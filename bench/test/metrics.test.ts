import { describe, expect, it } from "vitest";
import {
  accuracy,
  accuracyAtCoverage,
  auroc,
  bootstrapCi,
  expectedCalibrationError,
  macroF1,
  percentile,
  precision,
  recall,
} from "../src/metrics.ts";
import { createRng } from "../src/rng.ts";

const s = (confidence: number, correct: boolean) => ({ confidence, correct });

describe("accuracy", () => {
  it("is the share correct", () => expect(accuracy([true, false, true, true])).toBe(0.75));
  it("is NaN when empty", () => expect(accuracy([])).toBeNaN());
});

describe("macroF1", () => {
  it("averages per-label F1 over the gold labels", () => {
    // a: tp1 fp0 fn1 -> 2/3; b: tp1 fp1 fn0 -> 2/3; c: tp0 -> 0
    const pairs = [
      { gold: "a", predicted: "a" },
      { gold: "a", predicted: "b" },
      { gold: "b", predicted: "b" },
      { gold: "c", predicted: null },
    ] as const;
    expect(macroF1(pairs)).toBeCloseTo(4 / 9);
  });
});

describe("auroc", () => {
  it("is 1 when every correct answer is more confident than every wrong one", () => {
    expect(auroc([s(0.9, true), s(0.8, true), s(0.3, false)])).toBe(1);
  });
  it("is 0 when reversed", () => expect(auroc([s(0.2, true), s(0.9, false)])).toBe(0));
  it("counts ties as half", () => expect(auroc([s(0.5, true), s(0.5, false)])).toBe(0.5));
  it("is NaN with no wrong answers", () => expect(auroc([s(0.9, true)])).toBeNaN());
});

describe("expectedCalibrationError", () => {
  it("weights each bin's gap between accuracy and confidence", () => {
    // bin 9: acc 0.5, conf 0.95 -> 0.45 x 2/3; bin 2: acc 1, conf 0.25 -> 0.75 x 1/3
    expect(expectedCalibrationError([s(0.95, true), s(0.95, false), s(0.25, true)])).toBeCloseTo(
      0.55,
    );
  });
  it("puts confidence 1 in the last bin", () => {
    expect(expectedCalibrationError([s(1, true)])).toBe(0);
  });
});

describe("accuracyAtCoverage", () => {
  const scored = [s(0.9, true), s(0.8, true), s(0.7, false), s(0.6, false)];
  it("keeps the most confident share", () => {
    expect(accuracyAtCoverage(scored, 0.5)).toBe(1);
    expect(accuracyAtCoverage(scored, 1)).toBe(0.5);
  });
});

describe("percentile", () => {
  it("uses the nearest rank", () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 95)).toBe(5);
    expect(percentile([], 50)).toBeNaN();
  });
});

describe("bootstrapCi", () => {
  it("brackets the point estimate and is deterministic for a seed", () => {
    const correct = [true, true, false, true, false, true, true, true];
    const stat = (idx: readonly number[]) => accuracy(idx.map((i) => correct[i]!));
    const [lo, hi] = bootstrapCi(correct.length, stat, createRng(1));
    expect(lo).toBeLessThanOrEqual(accuracy(correct));
    expect(hi).toBeGreaterThanOrEqual(accuracy(correct));
    expect(bootstrapCi(correct.length, stat, createRng(1))).toEqual([lo, hi]);
  });
  it("collapses for a constant statistic", () => {
    expect(bootstrapCi(5, () => 0.7, createRng(2))).toEqual([0.7, 0.7]);
  });
});

describe("recall and precision", () => {
  const outcomes = [
    { gold: true, predicted: true },
    { gold: true, predicted: false },
    { gold: false, predicted: true },
    { gold: false, predicted: false },
    { gold: false, predicted: false },
  ];

  it("computes each over its own denominator", () => {
    expect(recall(outcomes)).toBe(0.5);
    expect(precision(outcomes)).toBe(0.5);
  });

  it("is NaN when undefined, never a crash", () => {
    expect(recall([{ gold: false, predicted: true }])).toBeNaN();
    expect(precision([{ gold: true, predicted: false }])).toBeNaN();
  });
});
