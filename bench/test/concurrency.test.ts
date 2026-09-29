import { expect, it } from "vitest";
import { mapLimit } from "../src/concurrency.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

it("keeps results in input order", async () => {
  const out = await mapLimit([30, 10, 20], 3, async (ms, i) => {
    await sleep(ms);
    return i;
  });
  expect(out).toEqual([0, 1, 2]);
});

it("never runs more than the limit at once", async () => {
  let running = 0;
  let peak = 0;
  await mapLimit(
    Array.from({ length: 20 }, (_, i) => i),
    4,
    async () => {
      running++;
      peak = Math.max(peak, running);
      await sleep(5);
      running--;
    },
  );
  expect(peak).toBe(4);
});

it("rejects a limit below one", async () => {
  await expect(mapLimit([1], 0, async (x) => x)).rejects.toThrow("positive integer");
});
