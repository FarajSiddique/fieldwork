import { choice, type ChoiceResponse, type Question, type TypeSafeClient } from "@typesafe-ai/sdk";
import type { BitextTicket } from "../bitext/sample.ts";
import { cachedCall, type ResponseCache } from "../cache.ts";
import { INTENTS, isIntent, rollUpToCategory, type Intent } from "../intents.ts";
import { INTENT_INSTRUCTIONS, ORDER_NUMBER_TARGET } from "../wording.ts";
import { failedPrediction, type Prediction } from "./types.ts";

/** AI Gateway's id for jev. The gateway lists no versioned id, so the version can't be pinned here. */
export const JEV_MODEL = "typesafe-ai/jev";
/** Restricting to one provider keeps every ticket on the same jev deployment. */
export const JEV_PROVIDER = "typesafe-ai";
export const NONE = "none";

const ORDER_NUMBER_CANDIDATE = /#?\d{5,}/g;

/** Regex tuned to over-find; jev chooses among the matches (TypeSafe's pre-parsed extraction pattern). */
export function findOrderNumbers(text: string): string[] {
  return [...new Set(text.match(ORDER_NUMBER_CANDIDATE) ?? [])];
}

export function buildJevRequest(ticket: string, model: string = JEV_MODEL) {
  const candidates = findOrderNumbers(ticket);
  const questions: Record<string, Question> = { intent: choice(INTENT_INSTRUCTIONS, INTENTS) };
  if (candidates.length > 0) {
    questions.orderNumber = choice(`Which of these is ${ORDER_NUMBER_TARGET}?`, {
      ...Object.fromEntries(candidates.map((c) => [c, null])),
      [NONE]: "None of these is the order number the customer is asking about",
    });
  }
  // The TypeSafe SDK forwards `providerOptions` to AI Gateway, though its request type omits it.
  const request = {
    model,
    state: { ticket },
    questions,
    providerOptions: { gateway: { only: [JEV_PROVIDER] } },
  };
  return { request, candidates };
}

interface JevCall {
  model: string;
  /** AI Gateway's `provider_metadata.gateway.routing.finalProvider`, or null when absent. */
  provider: string | null;
  answers: Record<string, unknown>;
  usage: { input_tokens: number; output_tokens: number };
}

/** The TypeSafe SDK's result type omits AI Gateway's `provider_metadata`, but the parsed body keeps it. */
function finalProvider(response: object): string | null {
  const provider = (
    response as { provider_metadata?: { gateway?: { routing?: { finalProvider?: unknown } } } }
  ).provider_metadata?.gateway?.routing?.finalProvider;
  return typeof provider === "string" ? provider : null;
}

function asChoice(answer: unknown, name: string): ChoiceResponse {
  if (
    typeof answer !== "object" ||
    answer === null ||
    (answer as { type?: unknown }).type !== "choice"
  ) {
    throw new Error(`missing or malformed answer for ${name}`);
  }
  return answer as ChoiceResponse;
}

function toPrediction(
  ticketId: string,
  call: JevCall,
  meta: { ms: number; hit: boolean },
  candidates: readonly string[],
): Prediction {
  const intent = asChoice(call.answers.intent, "intent");
  if (!isIntent(intent.choice)) throw new Error("intent answer outside the options");
  const { category, probability } = rollUpToCategory(
    intent.probabilities as Partial<Record<Intent, number>>,
  );

  let orderNumber: string | null = null;
  let orderNumberConfidence = 1; // no candidates: "none" is certain, no question asked
  if (candidates.length > 0) {
    const pick = asChoice(call.answers.orderNumber, "orderNumber");
    if (pick.choice !== NONE && !candidates.includes(pick.choice)) {
      throw new Error("orderNumber answer outside the options");
    }
    orderNumber = pick.choice === NONE ? null : pick.choice;
    orderNumberConfidence = pick.confidence;
  }

  return {
    system: "jev",
    ticketId,
    status: "ok",
    error: null,
    intent: intent.choice,
    intentConfidence: intent.confidence,
    category,
    categoryConfidence: probability,
    orderNumber,
    orderNumberConfidence,
    model: call.model,
    provider: call.provider,
    ms: meta.ms,
    inputTokens: call.usage.input_tokens,
    outputTokens: call.usage.output_tokens,
    cached: meta.hit,
  };
}

/** One systemOne request per ticket: the intent Choice and, when there are candidates, the order-number pick. */
export async function runJev(
  ticket: BitextTicket,
  client: TypeSafeClient,
  cache: ResponseCache,
  model: string = JEV_MODEL,
): Promise<Prediction> {
  const { request, candidates } = buildJevRequest(ticket.text, model);
  try {
    const entry = await cachedCall(
      cache,
      { system: "jev", ...request },
      async (): Promise<JevCall> => {
        const response = await client.systemOne(request);
        return {
          model: response.model,
          provider: finalProvider(response),
          answers: response.answers as Record<string, unknown>,
          usage: response.usage,
        };
      },
    );
    return toPrediction(ticket.id, entry.value, entry, candidates);
  } catch (err) {
    return failedPrediction("jev", ticket.id, model, err);
  }
}
