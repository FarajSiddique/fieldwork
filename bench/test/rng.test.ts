import { describe, expect, it } from "vitest";
import { createRng, digits, pickOne, shuffle } from "../src/rng.ts";

describe("createRng", () => {
  it("repeats the same sequence for the same seed", () => {
    const a = createRng(42);
    const b = createRng(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it("gives a different sequence for a different seed", () => {
    expect(createRng(1)()).not.toBe(createRng(2)());
  });

  it("returns values in [0, 1)", () => {
    const rng = createRng(7);
    for (let i = 0; i < 1000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("shuffle", () => {
  it("returns a permutation and leaves the input unchanged", () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    const out = shuffle(input, createRng(3));
    expect([...out].sort((x, y) => x - y)).toEqual(input);
    expect(input).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("is deterministic for a seed", () => {
    expect(shuffle([1, 2, 3, 4, 5], createRng(9))).toEqual(shuffle([1, 2, 3, 4, 5], createRng(9)));
  });
});

describe("pickOne", () => {
  it("throws on an empty list", () => {
    expect(() => pickOne([], createRng(1))).toThrow("empty");
  });
});

describe("digits", () => {
  it("returns the requested number of digits with no leading zero", () => {
    const rng = createRng(5);
    for (let i = 0; i < 200; i++) expect(digits(6, rng)).toMatch(/^[1-9]\d{5}$/);
  });
});
