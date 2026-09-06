import SPELLS from 'common/SPELLS';
import { TALENTS_EVOKER } from 'common/TALENTS';
import Analyzer, { Options, SELECTED_PLAYER } from 'parser/core/Analyzer';
import Events, {
  ApplyBuffEvent,
  ApplyBuffStackEvent,
  CastEvent,
  FightEndEvent,
  RemoveBuffEvent,
} from 'parser/core/Events';
import {
  getEssenceBurstConsumeAbility,
  isCastFromEB,
} from 'analysis/retail/evoker/shared/modules/normalizers/EssenceBurstCastLinkNormalizer';
import { AnalysisData } from '../components/ProcAnalysis';
import { QualitativePerformance } from 'parser/ui/QualitativePerformance';
import { CastEvaluation } from 'interface/guide/components';

class EssenceBurst extends Analyzer {
  casts: CastEvaluation[] = [];
  activeStacks = 0;

  constructor(options: Options) {
    super(options);

    [Events.applybuffstack, Events.applybuff].forEach((event) => {
      this.addEventListener(
        event
          .by(SELECTED_PLAYER)
          .spell([TALENTS_EVOKER.RUBY_ESSENCE_BURST_TALENT, SPELLS.ESSENCE_BURST_DEV_BUFF]),
        this.onApplyBuff,
      );
    });

    this.addEventListener(
      Events.removebuff
        .by(SELECTED_PLAYER)
        .spell([TALENTS_EVOKER.RUBY_ESSENCE_BURST_TALENT, SPELLS.ESSENCE_BURST_DEV_BUFF]),
      this.onBuffRemove,
    );

    this.addEventListener(
      Events.cast
        .by(SELECTED_PLAYER)
        .spell([SPELLS.DISINTEGRATE, SPELLS.PYRE, SPELLS.PYRE_DENSE_TALENT]),
      this.onEssenceSpend,
    );

    this.addEventListener(Events.fightend, this.onFightEnd);
  }

  private onApplyBuff(event: ApplyBuffEvent | ApplyBuffStackEvent) {
    this.activeStacks += 1;
  }

  private onEssenceSpend(event: CastEvent) {
    if (isCastFromEB(event)) {
      this.activeStacks -= 1;
      this.castAnalysis(event.timestamp, QualitativePerformance.Good);
    }
  }

  private onBuffRemove(event: RemoveBuffEvent) {
    if (getEssenceBurstConsumeAbility(event) === null) {
      this.castAnalysis(event.timestamp, QualitativePerformance.Fail);
      this.activeStacks = 0;
    }
  }

  private onFightEnd(event: FightEndEvent) {
    if (this.activeStacks > 0) {
      this.castAnalysis(event.timestamp, QualitativePerformance.Ok);
    }
  }

  private castAnalysis(timestamp: number, performance: QualitativePerformance) {
    let info: string;

    switch (performance) {
      case QualitativePerformance.Fail:
        info = `Buff expired wasting ${this.activeStacks} stack(s)`;
        break;
      case QualitativePerformance.Ok:
        info = `Fight ended, leaving ${this.activeStacks} stack(s) unused`;
        break;
      default:
        info = 'Buff used';
        break;
    }

    const castEntry: CastEvaluation = {
      performance: performance,
      timestamp: timestamp,
      reason: info,
    };

    this.casts.push(castEntry);
  }

  get procUsageData(): AnalysisData {
    return {
      casts: this.casts,
      spell: SPELLS.ESSENCE_BURST_DEV_BUFF,
    };
  }
}

export default EssenceBurst;
