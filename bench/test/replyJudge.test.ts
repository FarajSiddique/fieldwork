import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it } from "vitest";
import { ResponseCache } from "../src/cache.ts";
import type { TriagePrediction } from "../src/systems/prediction.ts";
import {
  buildJudgePrompt,
  compareReplies,
  fieldworkFirst,
  renderSpotCheck,
} from "../src/systems/replyJudge.ts";
import { REPLY } from "../src/wording.ts";
import type { WrittenTicket } from "../src/written.ts";

const usage = {
  inputTokens: { total: 300, noCache: 300, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

function judgeAlways(better: "first" | "second" | "tie" | Error) {
  return new MockLanguageModelV4({
    modelId: "mock-judge",
    doGenerate: async () => {
      if (better instanceof Error) throw better;
      return {
        content: [{ type: "text", text: JSON.stringify({ better }) }],
        finishReason: { unified: "stop", raw: "stop" },
        usage,
        warnings: [],
      };
    },
  });
}

const tickets = ["wr-1", "wr-2", "wr-3"].map((id) => ({ id, text: `ticket ${id}` }));

const replyOf = (system: string, ticketId: string, reply: string | null) =>
  ({ system, ticketId, reply }) as TriagePrediction;

// Reply texts carry no system names, so the blindness checks test the sheet's own labels.
const fieldwork = [
  replyOf("fieldwork", "wr-1", "Reply A1"),
  replyOf("fieldwork", "wr-2", null), // escalated: nothing to compare
  replyOf("fieldwork", "wr-3", "Reply A3"),
];
const frontier = tickets.map((t) => replyOf("frontier", t.id, `Reply B ${t.id}`));

let cache: ResponseCache;
beforeEach(async () => {
  cache = new ResponseCache(await mkdtemp(join(tmpdir(), "judge-")));
});

const compare = (better: "first" | "second" | "tie" | Error) => {
  const model = judgeAlways(better);
  const judge = { model, modelId: "mock-judge" };
  const options = { baseline: "frontier", judge, cache, seed: 7, concurrency: 2 };
  return { model, result: compareReplies(tickets, fieldwork, frontier, options) };
};

describe("fieldworkFirst", () => {
  it("is fixed per ticket and baseline, and roughly balanced", () => {
    const ids = Array.from({ length: 200 }, (_, i) => `wr-${i}`);
    const first = ids.filter((id) => fieldworkFirst(id, "frontier")).length;

    expect(fieldworkFirst("wr-1", "frontier")).toBe(fieldworkFirst("wr-1", "frontier"));
    expect(first).toBeGreaterThan(70);
    expect(first).toBeLessThan(130);
  });
});

describe("buildJudgePrompt", () => {
  it("shows the ticket, both replies and the style, but no system names", () => {
    const prompt = buildJudgePrompt("where is my order", "Reply A", "Reply B");

    for (const text of ["where is my order", "Reply A", "Reply B", REPLY.style]) {
      expect(prompt).toContain(text);
    }
    expect(prompt).not.toMatch(/fieldwork|frontier|cheap/i);
  });
});

describe("compareReplies", () => {
  it("judges only tickets where both systems replied, mapping positions back to systems", async () => {
    const { model, result } = compare("first");
    const { comparison, verdicts } = await result;

    expect(model.doGenerateCalls).toHaveLength(2);
    expect(verdicts.map((v) => v.ticketId)).toEqual(["wr-1", "wr-3"]);
    for (const v of verdicts) {
      expect(v.winner).toBe(fieldworkFirst(v.ticketId, "frontier") ? "fieldwork" : "baseline");
    }
    expect(comparison).toMatchObject({
      baseline: "frontier",
      judge: "mock-judge",
      pairs: 2,
      failed: 0,
    });
    expect(comparison.fieldworkWins + comparison.baselineWins).toBe(2);
  });

  it("counts a tie as half a win", async () => {
    const { comparison } = await compare("tie").result;

    expect(comparison.ties).toBe(2);
    expect(comparison.winRate.value).toBe(0.5);
  });

  it("counts a judge failure without failing the comparison", async () => {
    const { comparison, verdicts } = await compare(new Error("judge down")).result;

    expect(comparison).toMatchObject({ pairs: 2, failed: 2, fieldworkWins: 0 });
    expect(comparison.winRate.value).toBeNaN();
    expect(verdicts[0]!.error).toContain("judge down");
  });
});

describe("renderSpotCheck", () => {
  const written = tickets.map((t) => ({ id: t.id, text: t.text }) as WrittenTicket);
  const predictions = [...fieldwork, ...frontier];

  it("samples replies blind, with a key at the end", () => {
    const sheet = renderSpotCheck(written, predictions, 7, 4);
    const [entries, key] = sheet.split("## Key");

    expect(entries!.match(/^## \d+$/gm)).toHaveLength(4);
    expect(entries).not.toMatch(/fieldwork|frontier/);
    expect(key!.trim().split("\n")).toHaveLength(4);
    expect(renderSpotCheck(written, predictions, 7, 4)).toBe(sheet);
  });

  it("never shows a missing reply", () => {
    expect(renderSpotCheck(written, predictions, 7, 30).match(/^## \d+$/gm)).toHaveLength(5);
  });
});
