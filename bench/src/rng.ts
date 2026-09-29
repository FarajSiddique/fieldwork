export type Rng = () => number;

/** mulberry32: a small seeded generator, so samples and filled values are reproducible. */
export function createRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates on a copy. */
export function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export function pickOne<T>(items: readonly T[], rng: Rng): T {
  if (items.length === 0) throw new Error("pickOne: empty list");
  return items[Math.floor(rng() * items.length)]!;
}

/** A string of `count` random digits with no leading zero. */
export function digits(count: number, rng: Rng): string {
  let out = String(1 + Math.floor(rng() * 9));
  while (out.length < count) out += String(Math.floor(rng() * 10));
  return out;
}
