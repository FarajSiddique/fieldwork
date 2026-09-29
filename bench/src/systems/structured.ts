import { generateText, Output, type LanguageModel } from "ai";
import { z } from "zod";
import type { BitextTicket } from "../bitext/sample.ts";
import { cachedCall, type ResponseCache } from "../cache.ts";
import { CATEGORY_OF, INTENT_NAMES, INTENTS } from "../intents.ts";
import { INTENT_INSTRUCTIONS, ORDER_NUMBER_TARGET } from "../wording.ts";
import { failedPrediction, type Prediction } from "./types.ts";

export const structuredSchema = z.object({
  intent: z.enum(INTENT_NAMES),
  intentConfidence: z.number().min(0).max(1),
  orderNumber: z.string().nullable(),
  orderNumberConfidence: z.number().min(0).max(1),
});

export function buildStructuredPrompt(ticket: string): string {
  return [
    `${INTENT_INSTRUCTIONS}. Choose one of:`,
    ...INTENT_NAMES.map((intent) => `- ${intent}: ${INTENTS[intent]}`),
    "",
    `Give ${ORDER_NUMBER_TARGET}, copied exactly as written in the ticket, or null if the customer gives none.`,
    "",
    "For each answer, give your confidence from 0 to 1 that it is correct.",
    "",
    `ticket: ${JSON.stringify(ticket)}`,
  ].join("\n");
}

export interface StructuredSystem {
  name: string;
  model: LanguageModel;
  /** The id prices and reports use; for AI Gateway, the model string itself. */
  modelId: string;
}

interface StructuredCall {
  output: unknown;
  inputTokens: number;
  outputTokens: number;
}

/** One structured-output call per ticket, returning every field plus self-reported confidence. */
export async function runStructured(
  ticket: BitextTicket,
  system: StructuredSystem,
  cache: ResponseCache,
): Promise<Prediction> {
  const prompt = buildStructuredPrompt(ticket.text);
  const request = {
    system: "structured",
    modelId: system.modelId,
    prompt,
    schema: z.toJSONSchema(structuredSchema),
  };
  try {
    const entry = await cachedCall(cache, request, async (): Promise<StructuredCall> => {
      const result = await generateText({
        model: system.model,
        prompt,
        output: Output.object({ schema: structuredSchema }),
      });
      return {
        output: result.output,
        inputTokens: result.usage.inputTokens ?? 0,
        outputTokens: result.usage.outputTokens ?? 0,
      };
    });
    const output = structuredSchema.parse(entry.value.output);
    return {
      system: system.name,
      ticketId: ticket.id,
      status: "ok",
      error: null,
      intent: output.intent,
      intentConfidence: output.intentConfidence,
      category: CATEGORY_OF[output.intent],
      categoryConfidence: output.intentConfidence,
      orderNumber: output.orderNumber,
      orderNumberConfidence: output.orderNumberConfidence,
      model: system.modelId,
      ms: entry.ms,
      inputTokens: entry.value.inputTokens,
      outputTokens: entry.value.outputTokens,
      cached: entry.hit,
    };
  } catch (err) {
    return failedPrediction(system.name, ticket.id, system.modelId, err);
  }
}
