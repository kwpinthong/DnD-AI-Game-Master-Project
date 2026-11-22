import type { AiTokenUsage } from '../ai/provider.ts';

/**
 * GEN-115: how long each stage of a turn took, and the tokens it used. Stage names and numbers only: a log
 * line built from this never holds player text, prompt text or a key.
 */
export interface StageTimer {
  /** Runs `fn` (sync or async) and adds its wall time to `stage`. */
  time<T>(stage: string, fn: () => T): T;
  add(stage: string, ms: number): void;
  addTokens(usage: AiTokenUsage | undefined): void;
  /** `stage_ms=N ... total_ms=N in=N cached=N out=N`, stages in first-seen order. */
  line(): string;
}

export function createStageTimer(clock: () => number = performance.now.bind(performance)): StageTimer {
  const stages = new Map<string, number>();
  const tokens = { input: 0, cached: 0, output: 0 };
  const started = clock();
  const add = (stage: string, ms: number) => void stages.set(stage, (stages.get(stage) ?? 0) + ms);
  return {
    add,
    time(stage, fn) {
      const t0 = clock();
      const done = () => add(stage, clock() - t0);
      let out: ReturnType<typeof fn>;
      try {
        out = fn();
      } catch (error) {
        done();
        throw error;
      }
      if (out instanceof Promise) return out.finally(done) as typeof out;
      done();
      return out;
    },
    addTokens(usage) {
      if (!usage) return;
      tokens.input += usage.inputTokens;
      tokens.cached += usage.cachedInputTokens;
      tokens.output += usage.outputTokens;
    },
    line() {
      const parts = [...stages].map(([stage, ms]) => `${stage}_ms=${Math.round(ms)}`);
      parts.push(`total_ms=${Math.round(clock() - started)}`, `in=${tokens.input}`, `cached=${tokens.cached}`, `out=${tokens.output}`);
      return parts.join(' ');
    },
  };
}
