// Contract test against real jev and one real text model, through Vercel AI Gateway. Runs only
// with FIELDWORK_LIVE=1; it reads AI_GATEWAY_API_KEY from the environment or bench/.env. It
// checks response shapes, not answer quality, and costs well under a cent per run.
import { existsSync } from "node:fs";
import { choice, noul, score, TypeSafeClient } from "@typesafe-ai/sdk";
import { describe, expect, it } from "vitest";
import { fieldwork } from "../src/builder.ts";

const LIVE = process.env.FIELDWORK_LIVE === "1";
const ENV_FILE = new URL("../../../bench/.env", import.meta.url);
if (LIVE && existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const GATEWAY_TYPESAFE_URL = "https://ai-gateway.vercel.sh/typesafe";
const JEV_MODEL = process.env.FIELDWORK_LIVE_JEV_MODEL ?? "typesafe-ai/jev";
const TEXT_MODEL = process.env.FIELDWORK_LIVE_TEXT_MODEL ?? "anthropic/claude-haiku-4.5";

const schema = fieldwork<{ ticket: string }>()
  .judge(
    "intent",
    choice("The primary intent of the customer message in `ticket`", {
      track_order: "Asks where an order is or for its tracking status",
      get_refund: "Asks for money back",
    }),
  )
  .judge("complexity", score("How complex is this request to resolve", ["simple", "some", "hard"]))
  .judge("isRepeat", noul("Does the customer say this problem happened before?"))
  .pick("orderNumber", {
    instructions: "Which of these is the order number the customer is asking about?",
    candidates: (input) => input.ticket.match(/#\d{5,}/g) ?? [],
  })
  .text("reply", {
    after: ["intent"],
    model: TEXT_MODEL,
    instructions: "Reply to the customer",
    style: "one short sentence",
  });

const isUnit = (x: unknown) => typeof x === "number" && x >= 0 && x <= 1;

describe.skipIf(!LIVE)("live contract (FIELDWORK_LIVE=1)", () => {
  it("gets typed answers, text, grading and usage from the real services", async () => {
    expect(process.env.AI_GATEWAY_API_KEY, "AI_GATEWAY_API_KEY is not set").toBeTruthy();
    const typesafe = new TypeSafeClient({
      apiKey: process.env.AI_GATEWAY_API_KEY,
      baseURL: GATEWAY_TYPESAFE_URL,
      logLevel: "off",
    });

    const { fields, trace } = await schema.run(
      { ticket: "Where is order #4471902? Invoice #12588 is already paid." },
      { typesafe, jevModel: JEV_MODEL, deadlineMs: 60_000 },
    );

    // Report failures by code before checking shapes, so a gateway error is readable.
    const failures = Object.entries(fields).flatMap(([name, r]) =>
      r.status === "failed" ? [`${name}: ${r.error.code} ${r.error.message}`] : [],
    );
    expect(failures).toEqual([]);

    const { intent, complexity, isRepeat, orderNumber, reply } = fields;
    if (intent.status !== "filled") throw new Error("intent not filled");
    expect(["track_order", "get_refund"]).toContain(intent.choice);
    expect(isUnit(intent.confidence)).toBe(true);
    const total = Object.values(intent.probabilities).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 2);

    if (complexity.status !== "filled") throw new Error("complexity not filled");
    expect(complexity.score).toBeGreaterThanOrEqual(0);
    expect(complexity.score).toBeLessThanOrEqual(2);

    if (isRepeat.status !== "filled") throw new Error("isRepeat not filled");
    expect(isUnit(isRepeat.noul)).toBe(true);

    if (orderNumber.status !== "filled") throw new Error("orderNumber not filled");
    expect(["#4471902", "#12588", null]).toContain(orderNumber.value);

    if (reply.status !== "filled") throw new Error("reply not filled");
    expect(reply.value.trim()).not.toBe("");
    expect(reply.score === null || isUnit(reply.score)).toBe(true);
    expect(reply.score, "grading returned no score").not.toBeNull();

    const jev = trace.steps[0]!.calls.find((c) => c.worker === "jev")!;
    expect(jev.model).toEqual(expect.any(String));
    expect(jev.inputTokens).toBeGreaterThan(0);
    const text = trace.steps[1]!.calls.find((c) => c.worker === "text")!;
    expect(text).toMatchObject({ model: TEXT_MODEL, status: "ok" });
    expect(text.outputTokens).toBeGreaterThan(0);
    expect(trace.grading!.calls[0]).toMatchObject({ worker: "jev", status: "ok" });
  }, 90_000);
});
