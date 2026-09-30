import { z } from "zod";
import { INTENT_NAMES } from "./intents.ts";
import { readJsonl } from "./io.ts";
import { findOrderNumbers } from "./orderNumbers.ts";

/** The jev weak spots the written set tags, from TypeSafe's jev notes. */
export const HARD_CASES = ["mixed_intents", "relative_dates", "injected_instructions"] as const;

export const writtenTicketSchema = z.strictObject({
  id: z.string().regex(/^wr-\d{3}$/),
  split: z.enum(["dev", "test"]),
  /** `draft` until labeled against the labeling guide (week 4). */
  status: z.enum(["draft", "final"]),
  synthetic: z.literal(true),
  text: z.string().trim().min(1),
  intent: z.enum(INTENT_NAMES),
  /** The complexity Score's level: 0 simple, 1 needs judgment, 2 unusual or needs a person. */
  complexity: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  needsEscalation: z.boolean(),
  isRepeat: z.boolean(),
  /** Exactly as written in the ticket, or `null` when the ticket has none. */
  orderNumber: z.string().nullable(),
  hardCases: z.array(z.enum(HARD_CASES)),
});

export type WrittenTicket = z.infer<typeof writtenTicketSchema>;

/**
 * Parse and cross-check the written set. Throws one error listing every problem, each prefixed
 * with the ticket id (or line number when the id is unreadable).
 */
export function validateWrittenSet(records: readonly unknown[]): WrittenTicket[] {
  const problems: string[] = [];
  const tickets: WrittenTicket[] = [];
  const seen = new Set<string>();
  records.forEach((record, i) => {
    const parsed = writtenTicketSchema.safeParse(record);
    if (!parsed.success) {
      const id = (record as { id?: unknown } | null)?.id;
      const where = typeof id === "string" ? id : `line ${i + 1}`;
      for (const issue of parsed.error.issues) {
        problems.push(`${where}: ${issue.path.join(".") || "record"}: ${issue.message}`);
      }
      return;
    }
    const t = parsed.data;
    if (seen.has(t.id)) problems.push(`${t.id}: duplicate id`);
    seen.add(t.id);
    // The pick can only choose a candidate the regex finds, so the label must be one.
    const candidates = findOrderNumbers(t.text);
    if (t.orderNumber !== null && !candidates.includes(t.orderNumber)) {
      problems.push(`${t.id}: orderNumber ${t.orderNumber} is not a candidate found in the text`);
    } else if (t.orderNumber !== null && candidates.length < 2) {
      // The spec asks for other numbers too; only ones the regex finds make the pick choose.
      problems.push(
        `${t.id}: a ticket with an order number needs another candidate number (5+ digits) as a distractor`,
      );
    }
    tickets.push(t);
  });
  if (problems.length > 0) throw new Error(`Invalid written set:\n${problems.join("\n")}`);
  return tickets;
}

export async function loadWrittenSet(path: string): Promise<WrittenTicket[]> {
  return validateWrittenSet(await readJsonl<unknown>(path));
}
