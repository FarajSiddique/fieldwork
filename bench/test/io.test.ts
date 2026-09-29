import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readJsonl, writeJsonl, writeText } from "../src/io.ts";

it("round-trips JSONL, creating directories", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "io-")), "a", "b.jsonl");
  await writeJsonl(path, [{ x: 1 }, { x: 2 }]);
  expect(await readJsonl<{ x: number }>(path)).toEqual([{ x: 1 }, { x: 2 }]);
});

it("writes text, creating directories", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "io-")), "c", "d.md");
  await writeText(path, "hello\n");
  expect(await readFile(path, "utf8")).toBe("hello\n");
});
