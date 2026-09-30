import { generateText, Output } from "ai";
import { z } from "zod";
import { cachedCall, type ResponseCache } from "../cache.ts";
import { costUsd, type PriceTable } from "../evaluate.ts";
import { CATEGORY_OF, INTENT_NAMES, INTENTS } from "../intents.ts";
import { needsPerson } from "../triage.ts";
import {
  COMPLEXITY_LEVELS,
  COMPLEXITY_QUESTION,
  ESCALATION_NOTE,
  INTENT_INSTRUCTIONS,
  IS_REPEAT_QUESTION,
  ORDER_NUMBER_TARGET,
  REPLY,
} from "../wording.ts";
import { failedTriage, type Prediction, type TriagePrediction } from "./prediction.ts";
import type { StructuredSystem } from "./structured.ts";

const unit = z.number().min(0).max(1);

export const triageSchema = z.object({
  intent: z.enum(INTENT_NAMES),
  intentConfidence: unit,
  complexity: z.number().int().min(0).max(2),
  complexityConfidence: unit,
  isRepeat: z.boolean(),
  isRepeatConfidence: unit,
  orderNumber: z.string().nullable(),
  orderNumberConfidence: unit,
  reply: z.string(),
  escalationNote: z.string(),
});

/** Every field of the triage schema in one prompt, worded as the Fieldwork schema words it. */
export function buildTriagePrompt(ticket: string): string {
  return [
    `intent: ${INTENT_INSTRUCTIONS}. Choose one of:`,
    ...INTENT_NAMES.map((intent) => `- ${intent}: ${INTENTS[intent]}`),
    "",
    `complexity: ${COMPLEXITY_QUESTION}. Give the level's number:`,
    ...COMPLEXITY_LEVELS.map((level, i) => `- ${i}: ${level}`),
    "",
    `isRepeat: ${IS_REPEAT_QUESTION}`,
    "",
    `orderNumber: Give ${ORDER_NUMBER_TARGET}, copied exactly as written in the ticket, or null if the customer gives none.`,
    "",
    `reply: ${REPLY.instructions}. Style: ${REPLY.style}.`,
    `escalationNote: ${ESCALATION_NOTE.instructions}. Style: ${ESCALATION_NOTE.style}.`,
    "Write both texts; the application decides which one to use.",
    "",
    "For intent, complexity, isRepeat and orderNumber, give your confidence from 0 to 1 that the answer is correct.",
    "",
    `ticket: ${JSON.stringify(ticket)}`,
  ].join("\n");
}

/** The request as the response cache keys it. */
export function triageCacheRequest(ticket: string, modelId: string) {
  return {
    system: "triage-structured",
    modelId,
    prompt: buildTriagePrompt(ticket),
    schema: z.toJSONSchema(triageSchema),
  };
}

interface StructuredCall {
  output: unknown;
  inputTokens: number;
  outputTokens: number;
}

/**
 * One structured-output call for every field. The schema's escalation rule is applied to the
 * answers, and the text the rule selects is kept.
 */
export async function runTriageStructured(
  ticket: { id: string; text: string },
  system: StructuredSystem,
  cache: ResponseCache,
  prices: PriceTable,
): Promise<TriagePrediction> {
  const request = triageCacheRequest(ticket.text, system.modelId);

  try {
    const entry = await cachedCall(cache, request, async (): Promise<StructuredCall> => {
      const result = await generateText({
        model: system.model,
        prompt: request.prompt,
        output: Output.object({ schema: triageSchema }),
      });
      return {
        output: result.output,
        inputTokens: result.usage.inputTokens ?? 0,
        outputTokens: result.usage.outputTokens ?? 0,
      };
    });
    const answer = triageSchema.parse(entry.value.output);

    const base: Prediction = {
      system: system.name,
      ticketId: ticket.id,
      status: "ok",
      error: null,
      intent: answer.intent,
      intentConfidence: answer.intentConfidence,
      category: CATEGORY_OF[answer.intent],
      // No per-intent probabilities to sum, so the intent confidence stands in (a lower bound).
      categoryConfidence: answer.intentConfidence,
      orderNumber: answer.orderNumber,
      orderNumberConfidence: answer.orderNumberConfidence,
      model: system.modelId,
      provider: null,
      ms: entry.ms,
      inputTokens: entry.value.inputTokens,
      outputTokens: entry.value.outputTokens,
      cached: entry.hit,
    };
    const escalates = needsPerson({
      categoryProbability: answer.intentConfidence,
      complexity: answer.complexity,
      complexityConfidence: answer.complexityConfidence,
    });

    return {
      ...base,
      estCostUsd: costUsd(base, prices),
      complexity: answer.complexity,
      complexityConfidence: answer.complexityConfidence,
      isRepeat: answer.isRepeat,
      escalates,
      reply: escalates ? null : answer.reply,
      escalationNote: escalates ? answer.escalationNote : null,
      fieldErrors: [],
    };
  } catch (err) {
    return failedTriage(system.name, ticket.id, system.modelId, err);
  }
}
