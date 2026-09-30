import { generateText, Output, type LanguageModel } from "ai";
import { z } from "zod";
import { NO_RETRIES, retryTimed, type BackoffOptions } from "../backoff.ts";
import { cacheKey, cachedCall, type ResponseCache } from "../cache.ts";
import { mapLimit } from "../concurrency.ts";
import { interval, type Interval } from "../evaluate.ts";
import { mean } from "../metrics.ts";
import { createRng, shuffle } from "../rng.ts";
import { REPLY } from "../wording.ts";
import type { WrittenTicket } from "../written.ts";
import type { TriagePrediction } from "./prediction.ts";

export const judgeSchema = z.object({ better: z.enum(["first", "second", "tie"]) });

export interface JudgeSystem {
  model: LanguageModel;
  modelId: string;
}

export type Winner = "fieldwork" | "baseline" | "tie";

export interface Verdict {
  ticketId: string;
  fieldworkFirst: boolean;
  /** `null` when the judge call failed. */
  winner: Winner | null;
  error: string | null;
}

export interface ReplyComparison {
  baseline: string;
  judge: string;
  /** Tickets where both systems answered the customer, so there are two replies to compare. */
  pairs: number;
  fieldworkWins: number;
  baselineWins: number;
  ties: number;
  failed: number;
  /** Fieldwork's wins plus half its ties, over the judged pairs. */
  winRate: Interval;
}

export function buildJudgePrompt(ticket: string, first: string, second: string): string {
  return [
    "A customer sent the support ticket below, and two replies were drafted.",
    `Which reply better answers the customer? Judge accuracy against the ticket, and the style: ${REPLY.style}.`,
    "Answer first, second or tie.",
    "",
    `ticket: ${JSON.stringify(ticket)}`,
    `first: ${JSON.stringify(first)}`,
    `second: ${JSON.stringify(second)}`,
  ].join("\n");
}

/** Fixed per ticket and baseline, so the judge cannot learn a position and reruns hit the cache. */
export function fieldworkFirst(ticketId: string, baseline: string): boolean {
  return Number.parseInt(cacheKey({ ticketId, baseline }).slice(0, 8), 16) % 2 === 0;
}

const WIN_SCORE: Record<Winner, number> = { fieldwork: 1, tie: 0.5, baseline: 0 };

const firstLine = (err: unknown) =>
  (err instanceof Error ? `${err.name}: ${err.message}` : String(err))
    .split("\n")[0]!
    .slice(0, 200);

/** Ask the judge about every ticket both systems replied to. Never throws. */
export async function compareReplies(
  tickets: readonly { id: string; text: string }[],
  fieldwork: readonly TriagePrediction[],
  baseline: readonly TriagePrediction[],
  options: {
    baseline: string;
    judge: JudgeSystem;
    cache: ResponseCache;
    seed: number;
    concurrency: number;
    /** Retries for a rate-limited judge call; absent means none. */
    backoff?: BackoffOptions;
  },
): Promise<{ comparison: ReplyComparison; verdicts: Verdict[] }> {
  const ours = new Map(fieldwork.map((p) => [p.ticketId, p.reply]));
  const theirs = new Map(baseline.map((p) => [p.ticketId, p.reply]));
  const pairs = tickets.filter((t) => ours.get(t.id) && theirs.get(t.id));

  const verdicts = await mapLimit(pairs, options.concurrency, async (t): Promise<Verdict> => {
    const first = fieldworkFirst(t.id, options.baseline);
    const [a, b] = first
      ? [ours.get(t.id)!, theirs.get(t.id)!]
      : [theirs.get(t.id)!, ours.get(t.id)!];
    const request = {
      system: "reply-judge",
      modelId: options.judge.modelId,
      prompt: buildJudgePrompt(t.text, a, b),
      schema: z.toJSONSchema(judgeSchema),
    };

    try {
      const entry = await cachedCall<unknown>(options.cache, request, () =>
        retryTimed(options.backoff ?? NO_RETRIES, async () => {
          const result = await generateText({
            model: options.judge.model,
            prompt: request.prompt,
            output: Output.object({ schema: judgeSchema }),
            // The backoff retries; the AI SDK's own retries would multiply it.
            maxRetries: 0,
          });
          return result.output;
        }),
      );
      const { better } = judgeSchema.parse(entry.value);
      const winner: Winner =
        better === "tie" ? "tie" : (better === "first") === first ? "fieldwork" : "baseline";
      return { ticketId: t.id, fieldworkFirst: first, winner, error: null };
    } catch (err) {
      return { ticketId: t.id, fieldworkFirst: first, winner: null, error: firstLine(err) };
    }
  });

  const judged = verdicts.flatMap((v) => (v.winner === null ? [] : [WIN_SCORE[v.winner]]));
  const count = (w: Winner) => verdicts.filter((v) => v.winner === w).length;

  return {
    comparison: {
      baseline: options.baseline,
      judge: options.judge.modelId,
      pairs: pairs.length,
      fieldworkWins: count("fieldwork"),
      baselineWins: count("baseline"),
      ties: count("tie"),
      failed: verdicts.filter((v) => v.winner === null).length,
      winRate: interval(judged, mean, createRng(options.seed)),
    },
    verdicts,
  };
}

/**
 * The human spot check: `count` written-set replies sampled across systems, shown without
 * system names. The key at the end says which system wrote each.
 */
export function renderSpotCheck(
  tickets: readonly WrittenTicket[],
  predictions: readonly TriagePrediction[],
  seed: number,
  count = 30,
): string {
  const text = new Map(tickets.map((t) => [t.id, t.text]));
  const replies = predictions.filter((p) => p.reply !== null && text.has(p.ticketId));
  const chosen = shuffle(replies, createRng(seed)).slice(0, count);

  return [
    "# Reply spot check",
    "",
    `${chosen.length} replies to written-set tickets, sampled across systems and shown without system names. For each, mark whether it is accurate, follows the style (${REPLY.style}), and could be sent as is. Read the key only after marking every reply.`,
    "",
    ...chosen.flatMap((p, i) => [
      `## ${i + 1}`,
      "",
      `**Ticket:** ${text.get(p.ticketId)}`,
      "",
      `**Reply:** ${p.reply}`,
      "",
      "- Accurate:",
      "- Follows the style:",
      "- Send as is:",
      "",
    ]),
    "## Key",
    "",
    ...chosen.map((p, i) => `${i + 1}. ${p.system} (${p.ticketId})`),
    "",
  ].join("\n");
}
