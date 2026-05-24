import Analyzer, { Options, SELECTED_PLAYER } from 'parser/core/Analyzer';
import TALENTS from 'common/TALENTS/evoker';
import Events, {
  ApplyDebuffEvent,
  CastEvent,
  DamageEvent,
  HasRelatedEvent,
  RefreshDebuffEvent,
  RemoveDebuffEvent,
} from 'parser/core/Events';
import SPELLS from 'common/SPELLS/evoker';
import { ChecklistUsageInfo, SpellUse } from 'parser/core/SpellUsage/core';
import { JSX } from 'react';
import { QualitativePerformance } from 'parser/ui/QualitativePerformance';
import SpellLink from 'interface/SpellLink';
import { combineQualitativePerformances } from 'common/combineQualitativePerformances';
import ContextualSpellUsageSubSection from 'parser/core/SpellUsage/HideGoodCastsSpellUsageSubSection';
import { MASS_ERUPTION_CONSUME } from 'analysis/retail/evoker/augmentation/modules/normalizers/CastLinkNormalizer';

const BOMBARDMENT_DURATION = 6000;
const EXTENDED_BATTLE_EXTENSION_DURATION = 1000;
const ACCEPTABLE_DURATION_PERCENTAGE = 1;

interface TargetCountData {
  timestamp: number;
  count: number;
}

interface BombardmentData {
  event: ApplyDebuffEvent;
  start: number;
  end: number;
  targetID: number;
  duration: number;
  avgTargetCount: number;
  isExtended: boolean;
}

/**
 */
class Bombardments extends Analyzer {
  private uses: SpellUse[] = [];
  private applications: BombardmentData[] = [];
  private targetCountData: TargetCountData[] = [];
  bombardmentDebuffCount = 0;

  constructor(options: Options) {
    super(options);
    this.active = this.selectedCombatant.hasTalent(TALENTS.BOMBARDMENTS_TALENT);

    this.addEventListener(
      Events.damage.by(SELECTED_PLAYER).spell(SPELLS.BOMBARDMENTS_DAMAGE),
      this.onDamage,
    );

    if (this.selectedCombatant.hasTalent(TALENTS.EXTENDED_BATTLE_TALENT))
      this.addEventListener(
        Events.cast.by(SELECTED_PLAYER).spell(TALENTS.ERUPTION_TALENT),
        this.onEruption,
      );

    this.addEventListener(
      Events.applydebuff.by(SELECTED_PLAYER).spell(SPELLS.BOMBARDMENTS_DEBUFF),
      this.onDebuffApply,
    );
    this.addEventListener(
      Events.refreshdebuff.by(SELECTED_PLAYER).spell(SPELLS.BOMBARDMENTS_DEBUFF),
      this.onDebuffRefresh,
    );
    this.addEventListener(
      Events.removedebuff.by(SELECTED_PLAYER).spell(SPELLS.BOMBARDMENTS_DEBUFF),
      this.onDebuffRemove,
    );
    this.addEventListener(Events.fightend, this.finalize);
  }

  /**
   * Record damage events for later analysis of target count
   */
  onDamage(event: DamageEvent) {
    const data = this.targetCountData.find((d) => d.timestamp === event.timestamp);
    if (data) data.count++;
    else this.targetCountData.push({ timestamp: event.timestamp, count: 1 });
  }

  onEruption(event: CastEvent) {
    if (HasRelatedEvent(event, MASS_ERUPTION_CONSUME)) return;
    this.applications.forEach((d) => {
      if (d.end !== 0) return;
      d.duration += EXTENDED_BATTLE_EXTENSION_DURATION;
    });
  }

  onDebuffApply(event: ApplyDebuffEvent) {
    if (this.bombardmentDebuffCount === 0) this.targetCountData = [];
    this.applications.push({
      event: event,
      start: event.timestamp,
      end: 0,
      targetID: event.targetID,
      duration: BOMBARDMENT_DURATION,
      avgTargetCount: 0,
      isExtended: false,
    });
    this.bombardmentDebuffCount++;
  }

  onDebuffRefresh(event: RefreshDebuffEvent) {
    this.applications.forEach((d) => {
      if (d.end !== 0) return;
      if (d.targetID === event.targetID) {
        d.duration += BOMBARDMENT_DURATION;
        d.isExtended = true;
      }
    });
  }

  onDebuffRemove(event: RemoveDebuffEvent) {
    this.applications.forEach((d) => {
      if (d.end !== 0) return;
      if (d.targetID === event.targetID) {
        d.end = event.timestamp;
        d.avgTargetCount = 0;
        let dataCount = 0;
        this.targetCountData.forEach((tcD) => {
          if (tcD.timestamp > d.start && tcD.timestamp < d.end) {
            d.avgTargetCount += tcD.count;
            dataCount++;
          }
        });
        d.avgTargetCount /= dataCount;
      }
    });
    this.bombardmentDebuffCount--;
  }

  private finalize() {
    // finalize performances
    this.uses = this.applications.map(this.bombardmentUsage);
  }

  private bombardmentUsage(data: BombardmentData): SpellUse {
    const fullDurationUsed =
      data.end - data.start >= (data.duration - 100) * ACCEPTABLE_DURATION_PERCENTAGE;
    const validSecondApplication = (data.isExtended && data.avgTargetCount < 2) || !data.isExtended;

    const spell = TALENTS.BOMBARDMENTS_TALENT.id;
    const performance =
      fullDurationUsed && validSecondApplication
        ? QualitativePerformance.Good
        : validSecondApplication || fullDurationUsed
          ? QualitativePerformance.Ok
          : QualitativePerformance.Fail;

    const summary =
      fullDurationUsed && validSecondApplication ? (
        <div>
          Targeted and extended <SpellLink spell={spell} /> correctly. Great Job.
        </div>
      ) : validSecondApplication ? (
        <div>
          Targeted <SpellLink spell={spell} /> correctly.
        </div>
      ) : fullDurationUsed ? (
        <div>
          Extended <SpellLink spell={spell} /> correctly.
        </div>
      ) : (
        <div>
          Targeted and extended <SpellLink spell={spell} /> incorrectly.
        </div>
      );
    const statistics = (
      <>
        <div>
          <b>Key Metrics</b>
        </div>
        <div>
          Duration (Actual/Maximum): {Math.round((data.end - data.start) / 10) / 100}/
          {Math.round(data.duration / 10) / 100}s
        </div>
        <div>Average Target Count of Hits: {Math.round(data.avgTargetCount * 10) / 10} targets</div>
      </>
    );
    const details =
      fullDurationUsed && validSecondApplication ? (
        <div>
          You correctly targeted and extended <SpellLink spell={spell} />.{statistics}
        </div>
      ) : validSecondApplication ? (
        <div>
          You targetted <SpellLink spell={spell} /> correctly but didn't use the full duration. Make
          sure to avoid applying fresh <SpellLink spell={spell} /> when the target would die early.
          {statistics}
        </div>
      ) : fullDurationUsed ? (
        <div>
          You used the full duration correctly but didn't spread <SpellLink spell={spell} />. Make
          sure to spread <SpellLink spell={spell} /> when it would hit more than 2 targets.
          {statistics}
        </div>
      ) : (
        <div>
          You did not extend nor spread <SpellLink spell={spell} /> correctly. Avoid casting{' '}
          <SpellLink spell={spell} /> on targets which would die early and spread{' '}
          <SpellLink spell={spell} /> when 2 targets are available.
          {statistics}
        </div>
      );

    const checklistItems: ChecklistUsageInfo[] = [
      {
        check: 'bombardment-uses',
        timestamp: data.start,
        performance,
        summary,
        details,
      },
    ];
    const actualPerformance = combineQualitativePerformances(
      checklistItems.map((item) => item.performance),
    );

    return {
      event: data.event,
      performance: actualPerformance,
      checklistItems,
      performanceExplanation:
        actualPerformance !== QualitativePerformance.Fail
          ? `${actualPerformance} Usage`
          : 'Bad Usage',
    };
  }

  guideSubsection(): JSX.Element | null {
    if (!this.active) {
      return null;
    }
    const explanation = (
      <section>
        <p>
          <strong>
            <SpellLink spell={TALENTS.BOMBARDMENTS_TALENT} />
          </strong>{' '}
          is a cornerstone of the Scalecommander hero talent tree. Correctly targetting and
          extending it leads to the maximum amount of <SpellLink spell={SPELLS.DEEP_BREATH} />/
          <SpellLink spell={TALENTS.BREATH_OF_EONS_TALENT} /> uses.
        </p>
        <p>
          <b>Disclaimer:</b> This analysis assumes that the targets are stacked somewhat reasonably
          and that <SpellLink spell={TALENTS.BOMBARDMENTS_TALENT} /> aren't applied to mobs standing
          further than 8y from other mobs in AoE situations
        </p>
      </section>
    );
    return (
      <ContextualSpellUsageSubSection
        title="Bombardments"
        explanation={explanation}
        uses={this.uses}
        castBreakdownSmallText={
          <>
            {' '}
            - <span className="goodCast">Green</span> casts have a minimum duration loss and ideal
            targetting. <span className="okCast">Yellow</span> casts have either a loss in duration
            or bad targetting <span className="badCast">Red</span> casts have both bad targetting
            and duration loss.
          </>
        }
        abovePerformanceDetails={<div style={{ marginBottom: 10 }}></div>}
      />
    );
  }
}

export default Bombardments;
