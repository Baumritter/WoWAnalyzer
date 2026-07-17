import SPELLS from 'common/SPELLS';
import TALENTS from 'common/TALENTS/evoker';
import { formatNumber } from 'common/format';

import Analyzer, { Options, SELECTED_PLAYER } from 'parser/core/Analyzer';
import ItemDamageDone from 'parser/ui/ItemDamageDone';
import Events, {
  ApplyDebuffEvent,
  DamageEvent,
  EmpowerEndEvent,
  RefreshDebuffEvent,
  RemoveDebuffEvent,
} from 'parser/core/Events';

import Statistic from 'parser/ui/Statistic';
import STATISTIC_CATEGORY from 'parser/ui/STATISTIC_CATEGORY';
import STATISTIC_ORDER from 'parser/ui/STATISTIC_ORDER';
import TalentSpellText from 'parser/ui/TalentSpellText';
import {
  getConsumeFlameDamageLinkEvent,
  getFireBreathDebuffEvents,
} from '../normalizers/CastLinkNormalizer';
import DonutChart from 'parser/ui/DonutChart';
import { encodeEventTargetString } from 'parser/shared/modules/Enemies';
import { CastDetail, CastInSequence, PerCastData, TipBox } from 'interface/guide/components';
import { QualitativePerformance } from 'parser/ui/QualitativePerformance';
import { explanationAndDataSubsection } from 'interface/guide/components/ExplanationRow';
import { RoundedPanel } from 'interface/guide/components/GuideDivs';
import SpellLink from 'interface/SpellLink';
import { JSX } from 'react';
import { PerformanceMark, qualitativePerformanceToColor } from 'interface/guide';
import { SpellSequence } from 'interface/guide/components/CastSequence';
import {
  numberToQualitativePerformance,
  qualitativePerformanceToNumber,
} from 'common/combineQualitativePerformances';

const FIREBREATH_DEBUFF_END_BUFFER = 100;

const FIRE_BREATH_DOT_DURATIONS = [20000, 14000, 8000, 2000];

const CONSUME_PERFECT_THRESHOLD = 0.8;
const CONSUME_GOOD_THRESHOLD = 0.6;
const CONSUME_OK_THRESHOLD = 0.4;

interface FBWindow {
  debuffs: FBDebuff[];
  event: EmpowerEndEvent;
}

interface FBDebuff {
  cast: EmpowerEndEvent;
  debuffEvent: ApplyDebuffEvent | RefreshDebuffEvent;
  target: string;
  end: number;

  disintegrateHits: number;
  pyreHits: number;

  consumedDuration: number;
  extraDuration: number;
  maximumDuration: number;
  lastEmpower: number;
  pandemic: number;
}

interface OverallCounts {
  consumedDurationAvg: number;
  maximumDurationAvg: number;
  pandemicCounts: number;
}

class ConsumeFlame extends Analyzer {
  windows: FBWindow[] = [];
  debuffEvents: FBDebuff[] = [];
  totalDamage = 0;
  disintegrateDamage = 0;
  pyreDamage = 0;
  fireBreathDotIncrease = 0;

  constructor(options: Options) {
    super(options);

    this.fireBreathDotIncrease =
      (this.selectedCombatant.hasTalent(TALENTS.BLAST_FURNACE_TALENT) ? 4000 : 0) +
      (this.selectedCombatant.hasTalent(TALENTS.DEEP_EXHALATION_TALENT) ? 4000 : 0);

    this.active = this.selectedCombatant.hasTalent(TALENTS.CONSUME_FLAME_TALENT);

    this.addEventListener(
      Events.damage.by(SELECTED_PLAYER).spell(SPELLS.CONSUME_FLAME_DAMAGE),
      this.onConsumeFlameHit,
    );
    this.addEventListener(Events.damage, this.onHit);
    this.addEventListener(
      Events.empowerEnd.by(SELECTED_PLAYER).spell([SPELLS.FIRE_BREATH, SPELLS.FIRE_BREATH_FONT]),
      this.onFireBreathCast,
    );
    this.addEventListener(
      Events.removedebuff.by(SELECTED_PLAYER).spell(SPELLS.FIRE_BREATH_DOT),
      this.onFireBreathRemove,
    );
    this.addEventListener(Events.fightend, this.finalize);
  }

  onFireBreathCast(event: EmpowerEndEvent) {
    const debuffEvents = getFireBreathDebuffEvents(event);

    if (debuffEvents.length === 0) return;

    const FB: FBWindow = {
      debuffs: [],
      event: event,
    };
    let addedDebuffs = 0;

    debuffEvents.forEach((e) => {
      const debuff = this.getActiveDebuffByTargetString(e);
      if (debuff !== undefined) {
        const remainingDuration = debuff.maximumDuration - this.getConsumedDuration(debuff);
        const maxPandemic = this.getFireBreathMaxDuration(event.empowermentLevel) * 0.3;
        const actualPandemic = maxPandemic - remainingDuration;

        debuff.maximumDuration +=
          (remainingDuration >= maxPandemic ? actualPandemic : 0) +
          this.getFireBreathMaxDuration(event.empowermentLevel);
        debuff.lastEmpower = event.empowermentLevel;
        debuff.pandemic++;
      } else {
        this.debuffEvents.push({
          cast: event,
          debuffEvent: e,
          target: encodeEventTargetString(e),
          disintegrateHits: 0,
          pyreHits: 0,
          end: 0,
          consumedDuration: 0,
          extraDuration: 0,
          maximumDuration: this.getFireBreathMaxDuration(event.empowermentLevel),
          lastEmpower: event.empowermentLevel,
          pandemic: 0,
        });
        addedDebuffs++;
      }
    });
    if (addedDebuffs > 0) this.windows.push(FB);
  }
  onFireBreathRemove(event: RemoveDebuffEvent) {
    const debuff = this.getActiveDebuffByTargetString(event);
    if (debuff !== undefined) {
      debuff.end = event.timestamp;
      const window = this.getRelatedWindow(debuff);
      if (window) window.debuffs.push(debuff);
    }
  }
  onConsumeFlameHit(event: DamageEvent) {
    this.totalDamage += event.amount + (event.absorbed || 0);
    const consumeFlameDamageEvent = getConsumeFlameDamageLinkEvent(event);
    if (!consumeFlameDamageEvent) {
      return;
    }

    const debuff = this.getActiveDebuffByTargetString(event);

    if (consumeFlameDamageEvent.ability.guid == SPELLS.DISINTEGRATE.id) {
      this.disintegrateDamage += event.amount + (event.absorbed || 0);
      if (debuff !== undefined) debuff.disintegrateHits++;
    } else {
      this.pyreDamage += event.amount + (event.absorbed || 0);
      if (debuff !== undefined) debuff.pyreHits++;
    }
  }
  onHit(event: DamageEvent) {
    if ((event.hitPoints || 0) > event.amount + (event.overkill || 0)) return;

    const debuff = this.getActiveDebuffByTargetString(event);
    if (debuff !== undefined) {
      debuff.end = event.timestamp;
    }
  }

  private getRelatedWindow(debuff: FBDebuff) {
    return this.windows.find((x) => x.event === debuff.cast);
  }
  private getActiveDebuffByTargetString(
    event: DamageEvent | RemoveDebuffEvent | RefreshDebuffEvent | ApplyDebuffEvent,
  ) {
    return this.debuffEvents.find(
      (x) =>
        x.target === encodeEventTargetString(event) &&
        (x.end === 0 || event.timestamp < x.end + FIREBREATH_DEBUFF_END_BUFFER),
    );
  }
  private getFireBreathMaxDuration(empowerLevel: number): number {
    return FIRE_BREATH_DOT_DURATIONS[empowerLevel - 1] + this.fireBreathDotIncrease;
  }
  private getConsumedDuration(debuff: FBDebuff): number {
    return (debuff.disintegrateHits + debuff.pyreHits * 4) * 1000;
  }

  finalize() {
    this.windows.forEach((w) => {
      w.debuffs.forEach((d) => {
        d.consumedDuration = this.getConsumedDuration(d);
      });
    });
  }

  private getAverageQualitativePerformance(performances: QualitativePerformance[]) {
    let sum = 0;
    performances.forEach((p) => {
      sum += qualitativePerformanceToNumber(p);
    });
    return numberToQualitativePerformance(Math.round(sum / performances.length));
  }
  private formatSeconds(timespan: number): string {
    return `${Math.round(timespan / 100) / 10}s`;
  }

  private buildOverallStats(window: FBWindow): OverallCounts {
    let MaximumDuration = 0,
      ConsumedDuration = 0,
      PandemicCount = 0;

    window.debuffs.forEach((debuff) => {
      MaximumDuration += debuff.maximumDuration;
      ConsumedDuration += debuff.consumedDuration;
      if (debuff.pandemic > PandemicCount) PandemicCount = debuff.pandemic;
    });

    ConsumedDuration = ConsumedDuration / window.debuffs.length;
    MaximumDuration = MaximumDuration / window.debuffs.length;

    return {
      consumedDurationAvg: ConsumedDuration,
      maximumDurationAvg: MaximumDuration,
      pandemicCounts: PandemicCount,
    };
  }
  private buildDebuffTargetSequence(window: FBWindow): CastInSequence[] {
    return window.debuffs.map((debuff, idx) => {
      const performance =
        debuff.maximumDuration * CONSUME_PERFECT_THRESHOLD <= debuff.consumedDuration
          ? QualitativePerformance.Perfect
          : debuff.maximumDuration * CONSUME_GOOD_THRESHOLD <= debuff.consumedDuration
            ? QualitativePerformance.Good
            : debuff.maximumDuration * CONSUME_OK_THRESHOLD <= debuff.consumedDuration
              ? QualitativePerformance.Ok
              : QualitativePerformance.Fail;

      const stats = (
        <>
          <ul>
            <li>Consumed Duration: {this.formatSeconds(debuff.consumedDuration)}</li>
            <li>Maximum Duration: {this.formatSeconds(debuff.maximumDuration)}</li>
            {debuff.pandemic > 0 && <li>Extensions: {debuff.pandemic}</li>}
          </ul>
        </>
      );

      const details =
        debuff.maximumDuration * CONSUME_PERFECT_THRESHOLD <= debuff.consumedDuration ? (
          <>
            Consumed more than <b>{CONSUME_PERFECT_THRESHOLD * 100}%</b> of{' '}
            <SpellLink spell={SPELLS.FIRE_BREATH} /> on this target. Perfect!
            {stats}
          </>
        ) : debuff.maximumDuration * CONSUME_GOOD_THRESHOLD <= debuff.consumedDuration ? (
          <>
            Consumed more than <b>{CONSUME_GOOD_THRESHOLD * 100}%</b> of{' '}
            <SpellLink spell={SPELLS.FIRE_BREATH} /> on this target. Good Job.
            {stats}
          </>
        ) : debuff.maximumDuration * CONSUME_OK_THRESHOLD <= debuff.consumedDuration ? (
          <>
            Consumed more than <b>{CONSUME_OK_THRESHOLD * 100}%</b> of{' '}
            <SpellLink spell={SPELLS.FIRE_BREATH} /> on this target. Ok.
            {stats}
          </>
        ) : (
          <>
            Did not consume enough of <SpellLink spell={SPELLS.FIRE_BREATH} /> on this target.
            {stats}
          </>
        );
      return {
        timestamp: 0,
        spellId: 0,
        spellName: '',
        icon: 'spell_nature_reincarnation',
        outlineColor: qualitativePerformanceToColor(performance),
        tooltip: (
          <div>
            <strong>Target {idx + 1}</strong>
            <p>{details}</p>
          </div>
        ),
        performance: performance,
      };
    });
  }
  private buildCastInfo(): PerCastData[] {
    return this.windows.map((window): PerCastData => {
      const overallCount = this.buildOverallStats(window);
      const debuffs = this.buildDebuffTargetSequence(window);
      const performance = this.getAverageQualitativePerformance(
        debuffs.map((debuff) => debuff.performance!),
      );

      const stats = [
        {
          value: this.formatSeconds(overallCount.consumedDurationAvg),
          label: 'Consumed Duration',
          tooltip: (
            <>
              Average amount of duration consumed with <SpellLink spell={SPELLS.DISINTEGRATE} /> and{' '}
              <SpellLink spell={SPELLS.PYRE} />.
            </>
          ),
        },
        {
          value: this.formatSeconds(overallCount.maximumDurationAvg),
          label: 'Maximum Duration',
          tooltip: (
            <>
              Maximum amount of duration that <SpellLink spell={SPELLS.FIRE_BREATH} /> could have
              been active for. This is based on empower rank and refreshes of the debuffs.
            </>
          ),
        },
      ];
      if (overallCount.pandemicCounts > 0) {
        stats.push({
          value: overallCount.pandemicCounts.toFixed(0),
          label: 'Extensions',
          tooltip: (
            <>
              Amount of extensions of the initial <SpellLink spell={SPELLS.FIRE_BREATH} /> buff.
            </>
          ),
        });
      }

      return {
        performance: performance,
        timestamp: this.owner.formatTimestamp(window.event.timestamp),
        tooltip:
          overallCount.maximumDurationAvg * CONSUME_PERFECT_THRESHOLD <=
          overallCount.consumedDurationAvg ? (
            <>
              Consumed more than <b>{CONSUME_PERFECT_THRESHOLD * 100}%</b> of this{' '}
              <SpellLink spell={SPELLS.FIRE_BREATH} /> cast. Perfect!
            </>
          ) : overallCount.maximumDurationAvg * CONSUME_GOOD_THRESHOLD <=
            overallCount.consumedDurationAvg ? (
            <>
              Consumed more than <b>{CONSUME_GOOD_THRESHOLD * 100}%</b> of this{' '}
              <SpellLink spell={SPELLS.FIRE_BREATH} /> cast. Good Job.
            </>
          ) : overallCount.maximumDurationAvg * CONSUME_OK_THRESHOLD <=
            overallCount.consumedDurationAvg ? (
            <>
              Consumed more than <b>{CONSUME_OK_THRESHOLD * 100}%</b> of this{' '}
              <SpellLink spell={SPELLS.FIRE_BREATH} /> cast. Ok.
            </>
          ) : (
            <>
              Did not consume enough of this
              <SpellLink spell={SPELLS.FIRE_BREATH} /> cast.
            </>
          ),
        stats: stats,
        additionalContent:
          window.debuffs.length > 0
            ? {
                content: <SpellSequence casts={debuffs} iconSize={32} />,
              }
            : undefined,
      };
    });
  }

  guideSubsection(): JSX.Element {
    const legend = (
      <TipBox hideIcon>
        <div>
          <PerformanceMark perf={QualitativePerformance.Perfect} /> <strong>Perfect</strong> -
          Consumed more than <b>{CONSUME_PERFECT_THRESHOLD * 100}%</b> of{' '}
          <SpellLink spell={SPELLS.FIRE_BREATH} />.
        </div>
        <div>
          <PerformanceMark perf={QualitativePerformance.Good} /> <strong>Good</strong> - Consumed
          more than <b>{CONSUME_GOOD_THRESHOLD * 100}%</b> of{' '}
          <SpellLink spell={SPELLS.FIRE_BREATH} />.
        </div>
        <div>
          <PerformanceMark perf={QualitativePerformance.Ok} /> <strong>Ok</strong> - Consumed more
          than <b>{CONSUME_OK_THRESHOLD * 100}%</b> of <SpellLink spell={SPELLS.FIRE_BREATH} />.
        </div>
        <div>
          <PerformanceMark perf={QualitativePerformance.Fail} /> <strong>Fail</strong> - Did not
          consume enough of <SpellLink spell={SPELLS.FIRE_BREATH} />
        </div>
      </TipBox>
    );

    const explanation = (
      <>
        <p>
          <strong>
            <SpellLink spell={SPELLS.CONSUME_FLAME_DAMAGE} />
          </strong>{' '}
          is the major component of Flameshaper and is responsible for around large part of your
          total damage. Correct play around it includes efficiently consuming{' '}
          <SpellLink spell={SPELLS.FIRE_BREATH} /> from mobs affected by it.
        </p>
        {legend}
      </>
    );

    const data = (
      <RoundedPanel>
        <div style={{ minWidth: 0, overflow: 'hidden' }}>
          <CastDetail title="Fire Breath Windows" casts={this.buildCastInfo()} />
        </div>
      </RoundedPanel>
    );

    return explanationAndDataSubsection(explanation, data, 40);
  }

  statistic() {
    const damageItems = [
      {
        color: 'rgb(183,65,14)',
        label: 'Pyre',
        spellId: SPELLS.PYRE.id,
        valueTooltip: formatNumber(this.pyreDamage),
        value: this.pyreDamage,
      },
      {
        color: 'rgb(41,134,204)',
        label: 'Disintegrate',
        spellId: SPELLS.DISINTEGRATE.id,
        valueTooltip: formatNumber(this.disintegrateDamage),
        value: this.disintegrateDamage,
      },
    ];
    return (
      <Statistic
        position={STATISTIC_ORDER.OPTIONAL(13)}
        size="flexible"
        category={STATISTIC_CATEGORY.HERO_TALENTS}
        tooltip={<li>Damage: {formatNumber(this.totalDamage)}</li>}
      >
        <TalentSpellText talent={TALENTS.CONSUME_FLAME_TALENT}>
          <ItemDamageDone amount={this.totalDamage} />
        </TalentSpellText>

        <div className="pad">
          <label>Damage sources</label>
          <DonutChart items={damageItems} />
        </div>
      </Statistic>
    );
  }
}

export default ConsumeFlame;
