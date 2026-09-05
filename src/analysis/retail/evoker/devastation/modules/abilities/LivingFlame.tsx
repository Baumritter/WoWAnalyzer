import Analyzer, { Options, SELECTED_PLAYER } from 'parser/core/Analyzer';
import Events, {
  ApplyBuffEvent,
  ApplyBuffStackEvent,
  CastEvent,
  EventType,
} from 'parser/core/Events';
import SPELLS from 'common/SPELLS';
import { isFromBurnout } from '../normalizers/CastLinkNormalizer';
import { CastDetail, CastOverview, PerCastData, PerCastStat } from 'interface/guide/components';
import { QualitativePerformance } from 'parser/ui/QualitativePerformance';
import { formatNumber, formatPercentage } from 'common/format';
import { getLeapingEvents } from 'analysis/retail/evoker/shared/modules/normalizers/LeapingFlamesNormalizer';
import { getGeneratedEBEvents } from 'analysis/retail/evoker/shared/modules/normalizers/EssenceBurstCastLinkNormalizer';
import SpellLink from 'interface/SpellLink';
import { JSX } from 'react';
import { RoundedPanel } from 'interface/guide/components/GuideDivs';
import { explanationAndDataSubsection } from 'interface/guide/components/ExplanationRow';

interface Data {
  cast: CastEvent;
  withBurnout: boolean;
  generatedEssenceBurst: number;
  leapingHits: number;
  leapingDamage: number;
  leapingHeal: number;
}
interface ProcTracking {
  total: number;
  used: number;
}

class LivingFlame extends Analyzer {
  castEntries: PerCastData[] = [];
  burnout: ProcTracking = { total: 0, used: 0 };
  leaping: ProcTracking = { total: 0, used: 0 };

  constructor(options: Options) {
    super(options);

    this.addEventListener(
      Events.applybuff.by(SELECTED_PLAYER).spell([SPELLS.BURNOUT_BUFF, SPELLS.LEAPING_FLAMES_BUFF]),
      this.onApplyBuff,
    );
    this.addEventListener(
      Events.applybuffstack
        .by(SELECTED_PLAYER)
        .spell([SPELLS.BURNOUT_BUFF, SPELLS.LEAPING_FLAMES_BUFF]),
      this.onApplyBuff,
    );

    this.addEventListener(
      Events.cast.by(SELECTED_PLAYER).spell([SPELLS.LIVING_FLAME_CAST, SPELLS.LIVING_FLAME_DAMAGE]),
      this.onLivingFlameCast,
    );
    this.addEventListener(Events.fightend, this.onFightEnd);
  }

  onFightEnd() {
    this.burnout.total -= this.selectedCombatant.getBuffStacks(SPELLS.BURNOUT_BUFF.id);
    this.leaping.total -= this.selectedCombatant.getBuffStacks(SPELLS.LEAPING_FLAMES_BUFF.id);
  }

  onApplyBuff(event: ApplyBuffEvent | ApplyBuffStackEvent) {
    if (event.ability.guid === SPELLS.BURNOUT_BUFF.id) {
      this.burnout.total += 1;
    } else {
      this.leaping.total += 1;
    }
  }

  onLivingFlameCast(event: CastEvent) {
    if (isFromBurnout(event)) {
      this.burnout.used += 1;
    }
    const leapingFlameHits = getLeapingEvents(event);

    const data: Data = {
      cast: event,
      withBurnout: isFromBurnout(event),
      generatedEssenceBurst: getGeneratedEBEvents(event).length,
      leapingHits: 0,
      leapingDamage: 0,
      leapingHeal: 0,
    };

    leapingFlameHits.forEach((event) => {
      data.leapingHits++;
      const amount = (event.amount || 0) + (event.absorbed || 0);
      if (event.type === EventType.Damage) data.leapingDamage += amount;
      else data.leapingHeal += amount;
    });

    if (data.leapingHits > 0) {
      this.leaping.used += 1;
    }

    let performance = QualitativePerformance.Ok;
    if (data.withBurnout && data.leapingHits > 0) {
      performance = QualitativePerformance.Perfect;
    } else if (data.withBurnout || data.leapingHits > 0) {
      performance = QualitativePerformance.Good;
    }

    const stats: PerCastStat[] = [
      {
        label: 'Essence Bursts',
        value: data.generatedEssenceBurst,
        tooltip:
          data.generatedEssenceBurst > 0
            ? `Generated ${data.generatedEssenceBurst} Essence Burst`
            : `Generated no Essence Burst`,
      },
      {
        label: 'With Burnout',
        value: data.withBurnout ? 'Yes' : 'No',
        tooltip: data.withBurnout ? `Cast with Burnout` : `Cast without Burnout`,
      },
      {
        label: ' With Leaping Flame',
        value: data.leapingHits > 0 ? 'Yes' : 'No',
        tooltip: data.leapingHits > 0 ? `Cast with Leaping Flame` : `Cast without Leaping Flame`,
      },
    ];
    if (data.leapingHits > 0) {
      stats.push(
        {
          label: 'Leaping Flame Hits',
          value: `${data.leapingHits}`,
          tooltip: `This cast hit ${data.leapingHits} additional targets.`,
        },
        {
          label: 'Leaping Flame Output',
          value: formatNumber(data.leapingDamage + data.leapingHeal),
          tooltip: `Damage: ${formatNumber(data.leapingDamage)} | Healing: ${formatNumber(data.leapingHeal)}`,
        },
      );
    }

    const castEntry = {
      performance: performance,
      timestamp: this.owner.formatTimestamp(event.timestamp),
      stats,
      details: '',
      tooltip: (
        <>
          <p>
            @ <strong>{this.owner.formatTimestamp(event.timestamp)}</strong>
          </p>
        </>
      ),
    };

    this.castEntries.push(castEntry);
  }

  private performanceHelper(procTracker: ProcTracking) {
    const percentage = procTracker.used / procTracker.total;
    return {
      perf:
        percentage >= 1
          ? QualitativePerformance.Perfect
          : percentage >= 0.95
            ? QualitativePerformance.Good
            : percentage >= 0.8
              ? QualitativePerformance.Ok
              : QualitativePerformance.Fail,
      percentage: percentage,
    };
  }

  private overviewHelper(procTracker: ProcTracking, title: string) {
    const performance = this.performanceHelper(procTracker);
    return {
      value: `${procTracker.used} / ${procTracker.total}`,
      label: title,
      tooltip:
        performance.perf === QualitativePerformance.Perfect
          ? 'Used all procs.'
          : `Only used ${formatPercentage(performance.percentage, 0)}% of the procs.`,
      performance: performance.perf,
    };
  }

  get guideSubsection(): JSX.Element {
    const explanation = (
      <>
        <p>
          <SpellLink spell={SPELLS.LIVING_FLAME_CAST} /> is you core spender in most situations and
          it has a few associated buffs which increase its value significantly. Correctly utilizing
          those is at the core to generating ressources efficienctly.
        </p>
        <strong>
          The performance ranking "OK" is not indicative of misusage. They are merely informative to
          filter casts quickly.
        </strong>
      </>
    );

    const overviewData = (
      <CastOverview
        spell={SPELLS.LIVING_FLAME_CAST}
        stats={[
          this.overviewHelper(this.burnout, 'Burnout Usage'),
          this.overviewHelper(this.leaping, 'Leaping Flame Usage'),
        ]}
      />
    );

    const data =
      this.castEntries.length === 0 ? (
        <div>
          <RoundedPanel>
            <strong>
              No <SpellLink spell={SPELLS.EMERALD_BLOSSOM_CAST} /> cast.
            </strong>
          </RoundedPanel>
        </div>
      ) : (
        <div>
          <RoundedPanel>
            {overviewData}
            <CastDetail
              title="Living Flame Casts"
              casts={this.castEntries}
              possiblePerformances={[
                QualitativePerformance.Perfect,
                QualitativePerformance.Good,
                QualitativePerformance.Ok,
              ]}
            />
          </RoundedPanel>
        </div>
      );

    return explanationAndDataSubsection(explanation, data, 40);
  }
}

export default LivingFlame;
