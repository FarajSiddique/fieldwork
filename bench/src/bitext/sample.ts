import { CATEGORY_OF, INTENT_NAMES, type Category, type Intent } from "../intents.ts";
import { createRng, shuffle } from "../rng.ts";
import { fillPlaceholders } from "./fill.ts";
import type { BitextRow } from "./load.ts";

export interface BitextTicket {
  id: string;
  text: string;
  intent: Intent;
  category: Category;
  orderNumber: string | null;
  flags: string;
}

export interface SampleOptions {
  seed: number;
  devPerIntent: number;
  testPerIntent: number;
}

const LONG_NUMBER = /\d{5,}/;

/**
 * An order ticket that carries a literal number instead of the {{Order Number}} placeholder
 * would get a wrong `none` order-number label, so it is left out.
 */
export function isEligible(row: BitextRow): boolean {
  return !(
    CATEGORY_OF[row.intent] === "order" &&
    !row.instruction.includes("{{Order Number}}") &&
    LONG_NUMBER.test(row.instruction)
  );
}

export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Dedupe, then draw `devPerIntent` and `testPerIntent` distinct rows per intent with a fixed seed. */
export function sampleBitext(
  rows: readonly BitextRow[],
  options: SampleOptions,
): { dev: BitextTicket[]; test: BitextTicket[] } {
  const seen = new Set<string>();
  const byIntent = new Map<Intent, BitextRow[]>(INTENT_NAMES.map((i) => [i, []]));
  for (const row of rows) {
    const key = normalizeText(row.instruction);
    if (!isEligible(row) || seen.has(key)) continue;
    seen.add(key);
    byIntent.get(row.intent)!.push(row);
  }

  const rng = createRng(options.seed);
  const need = options.devPerIntent + options.testPerIntent;
  const dev: BitextTicket[] = [];
  const test: BitextTicket[] = [];
  for (const intent of INTENT_NAMES) {
    const pool = shuffle(byIntent.get(intent)!, rng);
    if (pool.length < need) {
      throw new Error(`Intent ${intent} has ${pool.length} eligible rows; need ${need}`);
    }
    dev.push(...pool.slice(0, options.devPerIntent).map((r) => toTicket(r, options.seed)));
    test.push(...pool.slice(options.devPerIntent, need).map((r) => toTicket(r, options.seed)));
  }
  return { dev, test };
}

function toTicket(row: BitextRow, seed: number): BitextTicket {
  // A per-row generator keeps each ticket's filled values independent of sampling order.
  const { text, orderNumber } = fillPlaceholders(row.instruction, createRng(seed + row.index));
  return {
    id: `bx-${row.index}`,
    text,
    intent: row.intent,
    category: CATEGORY_OF[row.intent],
    orderNumber,
    flags: row.flags,
  };
}
