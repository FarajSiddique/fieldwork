const ORDER_NUMBER_CANDIDATE = /#?\d{5,}/g;

/**
 * Every number that could be an order number, in order of appearance and without duplicates.
 * Tuned to over-find; jev chooses among the matches (TypeSafe's pre-parsed extraction pattern).
 */
export function findOrderNumbers(text: string): string[] {
  return [...new Set(text.match(ORDER_NUMBER_CANDIDATE) ?? [])];
}

/** Baselines may drop the "#"; the comparison ignores it and surrounding space. */
export function normalizeOrderNumber(value: string | null): string | null {
  return value === null ? null : value.trim().replace(/^#/, "");
}
