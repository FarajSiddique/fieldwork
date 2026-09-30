import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { MockLanguageModelV4 } from "ai/test";
import { answer, fakeTextModel, fakeTypeSafe, type JevCall } from "fieldwork/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BitextTicket } from "../src/bitext/sample.ts";
import { runBench, type BenchContext } from "../src/benchRun.ts";
import { ResponseCache } from "../src/cache.ts";
import { DEFAULT_MODELS } from "../src/config.ts";
import { replayFetch, replayModel, type Fetch } from "../src/replay.ts";
import { renderBenchReport } from "../src/report.ts";
import type { WrittenTicket } from "../src/written.ts";

const bitext: BitextTicket[] = [
  {
    id: "bx-1",
    text: "where is order #4471902",
    intent: "track_order",
    category: "order",
    orderNumber: "#4471902",
    flags: "B",
  },
  {
    id: "bx-2",
    text: "i want a refund",
    intent: "get_refund",
    category: "refund",
    orderNumber: null,
    flags: "B",
  },
];

const written: WrittenTicket[] = [
  {
    id: "wr-1",
    split: "dev",
    status: "final",
    synthetic: true,
    text: "Where is order #4471902? Invoice #12588 is paid.",
    intent: "track_order",
    complexity: 0,
    needsEscalation: false,
    isRepeat: false,
    orderNumber: "#4471902",
    hardCases: [],
  },
  {
    id: "wr-2",
    split: "dev",
    status: "final",
    synthetic: true,
    text: "I was charged twice. Also, how do I change my email?",
    intent: "payment_issue",
    complexity: 2,
    needsEscalation: true,
    isRepeat: false,
    orderNumber: null,
    hardCases: ["mixed_intents"],
  },
];

/** jev answers from the ticket's words: a double charge is complex. */
function jev(call: JevCall) {
  const text = String((call.state as { ticket?: unknown }).ticket ?? "");
  const hard = text.includes("twice");
  const intent: Record<string, number> = hard
    ? { payment_issue: 0.9, get_refund: 0.1 }
    : text.includes("refund")
      ? { get_refund: 0.95, track_refund: 0.05 }
      : { track_order: 0.95, delivery_period: 0.05 };
  const answers: Record<string, unknown> = {
    intent: answer.choice(intent),
    complexity: answer.score(hard ? [0.05, 0.15, 0.8] : [0.9, 0.08, 0.02]),
    isRepeat: answer.noul(0.1),
    orderNumber: answer.choice({ "#4471902": 0.93, "#12588": 0.05, none: 0.02 }),
  };
  return {
    answers: Object.fromEntries(
      Object.keys(call.questions).map((id) => [id, answers[id] ?? answer.noul(0.9)]),
    ),
  };
}

const usage = {
  inputTokens: { total: 900, noCache: 900, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 120, text: 120, reasoning: 0 },
};

function jsonModel(modelId: string, output: unknown) {
  return new MockLanguageModelV4({
    modelId,
    doGenerate: async () => ({
      content: [{ type: "text", text: JSON.stringify(output) }],
      finishReason: { unified: "stop", raw: "stop" },
      usage,
      warnings: [],
    }),
  });
}

const baselineAnswer = {
  intent: "track_order",
  intentConfidence: 0.95,
  complexity: 0,
  complexityConfidence: 0.9,
  isRepeat: false,
  isRepeatConfidence: 0.9,
  orderNumber: "#4471902",
  orderNumberConfidence: 0.9,
  reply: "Your order is on its way.",
  escalationNote: "Customer asks about an order.",
};

let cache: ResponseCache;
beforeEach(async () => {
  cache = new ResponseCache(await mkdtemp(join(tmpdir(), "bench-")));
});

function context(): BenchContext {
  const { client } = fakeTypeSafe(jev);
  return {
    split: "dev",
    seed: 7,
    models: DEFAULT_MODELS,
    cache,
    prices: {},
    concurrency: 2,
    fieldwork: () => ({
      typesafe: client,
      models: {
        low: fakeTextModel("Your order has shipped.", "low"),
        high: fakeTextModel("Customer was charged twice.", "high"),
      },
      prices: {},
      jevModel: "typesafe-ai/jev",
      deadlineMs: 5_000,
    }),
    frontier: {
      name: "frontier",
      model: jsonModel("frontier", baselineAnswer),
      modelId: "frontier",
    },
    cheap: { name: "cheap", model: jsonModel("cheap", baselineAnswer), modelId: "cheap" },
    judge: { model: jsonModel("judge", { better: "tie" }), modelId: "judge" },
  };
}

describe("runBench", () => {
  it("runs every system on both sets and scores each set separately", async () => {
    const run = await runBench(bitext, written, context());

    expect(run.run).toBe("bench-dev");
    expect(run.bitext.map((s) => [s.system, s.tickets])).toEqual([
      ["fieldwork", 2],
      ["frontier", 2],
      ["cheap", 2],
    ]);
    expect(run.written.map((s) => [s.system, s.tickets])).toEqual([
      ["fieldwork", 2],
      ["frontier", 2],
      ["cheap", 2],
    ]);
    expect(run.predictions).toHaveLength(12);
    expect(run.written[0]!.escalationRecall.value).toBe(1);
    expect(run.written[1]!.escalationRecall.value).toBe(0);
  });

  it("judges replies only where Fieldwork and the baseline both answered", async () => {
    const run = await runBench(bitext, written, context());

    expect(run.replies.map((r) => [r.baseline, r.pairs, r.ties])).toEqual([
      ["frontier", 1, 1],
      ["cheap", 1, 1],
    ]);
    expect(run.verdicts.frontier!.map((v) => v.ticketId)).toEqual(["wr-1"]);
  });

  it("a dry run over an empty offline cache records misses and does not throw", async () => {
    const offline = new ResponseCache(await mkdtemp(join(tmpdir(), "bench-offline-")), {
      offline: true,
    });
    const tally = { replayed: 0, live: 0 };
    const replay = { delay: false };
    const send = vi.fn<Fetch>(() => {
      throw new Error("a dry run must not send");
    });
    const frontier = jsonModel("frontier", baselineAnswer);
    const cheap = jsonModel("cheap", baselineAnswer);
    const judge = jsonModel("judge", { better: "tie" });
    const ctx: BenchContext = {
      ...context(),
      cache: offline,
      fieldwork: () => ({
        typesafe: new TypeSafeClient({
          apiKey: "test",
          logLevel: "off",
          retry: { maxRetries: 0 },
          fetch: replayFetch(offline, tally, { ...replay, fetch: send }),
        }),
        models: {
          low: replayModel(fakeTextModel("Your order has shipped.", "low"), offline, tally, replay),
          high: replayModel(fakeTextModel("Charged twice.", "high"), offline, tally, replay),
        },
        prices: {},
        jevModel: "typesafe-ai/jev",
        deadlineMs: 5_000,
      }),
      frontier: { name: "frontier", model: frontier, modelId: "frontier" },
      cheap: { name: "cheap", model: cheap, modelId: "cheap" },
      judge: { model: judge, modelId: "judge" },
    };

    await runBench(bitext, written, ctx);

    const systems = [...offline.missed.values()].map((m) => (m as { system: string }).system);
    expect(systems.some((s) => s.includes("fieldwork-jev"))).toBe(true);
    expect(systems.some((s) => s.includes("triage-structured"))).toBe(true);
    expect(send).not.toHaveBeenCalled();
    for (const model of [frontier, cheap, judge]) expect(model.doGenerateCalls).toHaveLength(0);
  });

  it("rejects ticket ids that repeat across the sets", async () => {
    const clash = [{ ...bitext[0]!, id: "wr-1" }];

    await expect(runBench(clash, written, context())).rejects.toThrow("Ticket ids repeat");
  });
});

describe("renderBenchReport", () => {
  it("has every section, and prints n/a for missing numbers", async () => {
    const report = renderBenchReport(await runBench(bitext, written, context()));

    for (const heading of [
      "# Benchmark results: dev split",
      "## Bitext set (2 tickets)",
      "## Written set (2 synthetic tickets)",
      "## Hard cases",
      "## Reply quality",
      "## Failures",
      "## Notes",
    ]) {
      expect(report).toContain(heading);
    }
    expect(report).toContain("| mixed_intents | 1 |");
    expect(report).toContain("| frontier | 1 | 0 | 1 | 0 | 0 |");
    // No prices were given, and no ticket is tagged injected_instructions.
    expect(report).toContain("| Cost per ticket | n/a (price missing) |");
    expect(report).toContain(
      "| injected_instructions | 0 | n/a / n/a / n/a | n/a / n/a / n/a | n/a / n/a / n/a |",
    );
  });

  it("prints n/a for a cost that is not a number, as JSON turns NaN into null", async () => {
    const run = await runBench(bitext, written, context());
    run.written[0]!.costPerTicketUsd = Number.NaN;

    expect(renderBenchReport(run)).toContain("| Cost per ticket | n/a |");
  });

  // `pnpm report bench-dev` renders from the JSON, where NaN has become null.
  it("renders the same report from its JSON", async () => {
    const run = await runBench(bitext, written, context());

    expect(renderBenchReport(JSON.parse(JSON.stringify(run)))).toBe(renderBenchReport(run));
  });
});
