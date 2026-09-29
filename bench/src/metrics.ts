import type { Rng } from "./rng.ts";

export interface Scored {
  confidence: number;
  correct: boolean;
}

export function mean(xs: readonly number[]): number {
  return xs.length === 0 ? Number.NaN : xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function accuracy(correct: readonly boolean[]): number {
  return mean(correct.map((c) => (c ? 1 : 0)));
}

/** Mean F1 over the labels present in the gold data; a missing prediction counts against its gold label. */
export function macroF1<L extends string>(pairs: readonly { gold: L; predicted: L | null }[]): number {
  const labels = [...new Set(pairs.map((p) => p.gold))];
  return mean(
    labels.map((label) => {
      let tp = 0;
      let fp = 0;
      let fn = 0;
      for (const p of pairs) {
        if (p.predicted === label && p.gold === label) tp++;
        else if (p.predicted === label) fp++;
        else if (p.gold === label) fn++;
      }
      return tp === 0 ? 0 : (2 * tp) / (2 * tp + fp + fn);
    }),
  );
}

/** Probability that a correct answer carries higher confidence than a wrong one (ties count half). */
export function auroc(scored: readonly Scored[]): number {
  const pos = scored.filter((x) => x.correct).map((x) => x.confidence);
  const neg = scored.filter((x) => !x.correct).map((x) => x.confidence);
  if (pos.length === 0 || neg.length === 0) return Number.NaN;
  let wins = 0;
  for (const p of pos) for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

export function expectedCalibrationError(scored: readonly Scored[], bins = 10): number {
  if (scored.length === 0) return Number.NaN;
  const groups = Array.from({ length: bins }, () => [] as Scored[]);
  for (const x of scored) groups[Math.min(Math.floor(x.confidence * bins), bins - 1)]!.push(x);
  return groups.reduce((sum, group) => {
    if (group.length === 0) return sum;
    const gap = Math.abs(
      accuracy(group.map((x) => x.correct)) - mean(group.map((x) => x.confidence)),
    );
    return sum + (group.length / scored.length) * gap;
  }, 0);
}

/** Accuracy on the most confident `coverage` share of answers. */
export function accuracyAtCoverage(scored: readonly Scored[], coverage: number): number {
  if (scored.length === 0) return Number.NaN;
  const k = Math.max(1, Math.round(coverage * scored.length));
  const top = [...scored].sort((a, b) => b.confidence - a.confidence).slice(0, k);
  return accuracy(top.map((x) => x.correct));
}

export function percentile(xs: readonly number[], p: number): number {
  if (xs.length === 0) return Number.NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.max(1, Math.ceil((p / 100) * sorted.length)) - 1]!;
}

/** 95% percentile bootstrap interval; `statistic` receives resampled indices into the data. */
export function bootstrapCi(
  n: number,
  statistic: (indices: readonly number[]) => number,
  rng: Rng,
  iterations = 1000,
): [number, number] {
  const values: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const indices = Array.from({ length: n }, () => Math.floor(rng() * n));
    const v = statistic(indices);
    if (!Number.isNaN(v)) values.push(v);
  }
  return [percentile(values, 2.5), percentile(values, 97.5)];
}
