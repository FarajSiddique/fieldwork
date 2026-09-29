/** Bitext's 27 intents, with the descriptions jev and the baselines see. */
export const INTENTS = {
  cancel_order: "Wants to cancel an order",
  change_order: "Wants to change the items or details of an existing order",
  place_order: "Wants to buy something or place a new order",
  track_order: "Asks where an order is or for its tracking status",
  delivery_options: "Asks which delivery methods are available or whether you deliver somewhere",
  delivery_period: "Asks how long delivery takes or when an order will arrive",
  change_shipping_address: "Wants to change a shipping address",
  set_up_shipping_address: "Wants to add or set up a new shipping address",
  check_refund_policy: "Asks about the refund policy or whether a refund is possible",
  get_refund: "Wants to receive a refund",
  track_refund: "Asks about the status of a refund already requested",
  check_payment_methods: "Asks which payment methods are accepted",
  payment_issue: "Reports a problem or error when paying",
  check_invoice: "Wants to look at or check an invoice or bill",
  get_invoice: "Wants to download or receive an invoice or bill",
  create_account: "Wants to open a new account",
  delete_account: "Wants to close or delete an account",
  edit_account: "Wants to update information on an account",
  recover_password: "Forgot a password or wants to reset it",
  registration_problems: "Reports a problem signing up",
  switch_account: "Wants to switch to a different account or account type",
  check_cancellation_fee: "Asks about a fee or penalty for cancelling",
  contact_customer_service: "Asks how to contact customer service or when it is open",
  contact_human_agent: "Wants to talk to a human agent or a person",
  complaint: "Wants to make a complaint or file a claim against the company",
  review: "Wants to leave feedback or a review",
  newsletter_subscription: "Wants to subscribe to or unsubscribe from the newsletter",
} as const;

export type Intent = keyof typeof INTENTS;

export const INTENT_NAMES = Object.keys(INTENTS) as [Intent, ...Intent[]];

export const CATEGORIES = [
  "order",
  "shipping",
  "refund",
  "payment",
  "invoice",
  "account",
  "complaint",
  "other",
] as const;

export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_OF: Record<Intent, Category> = {
  cancel_order: "order",
  change_order: "order",
  place_order: "order",
  track_order: "order",
  delivery_options: "shipping",
  delivery_period: "shipping",
  change_shipping_address: "shipping",
  set_up_shipping_address: "shipping",
  check_refund_policy: "refund",
  get_refund: "refund",
  track_refund: "refund",
  check_payment_methods: "payment",
  payment_issue: "payment",
  check_invoice: "invoice",
  get_invoice: "invoice",
  create_account: "account",
  delete_account: "account",
  edit_account: "account",
  recover_password: "account",
  registration_problems: "account",
  switch_account: "account",
  complaint: "complaint",
  check_cancellation_fee: "other",
  contact_customer_service: "other",
  contact_human_agent: "other",
  review: "other",
  newsletter_subscription: "other",
};

export function isIntent(value: string): value is Intent {
  return Object.hasOwn(INTENTS, value);
}

/** Sum intent probabilities per category and return the most likely category. Ties go to the earlier category. */
export function rollUpToCategory(probabilities: Readonly<Partial<Record<Intent, number>>>): {
  category: Category;
  probability: number;
} {
  const totals = new Map<Category, number>(CATEGORIES.map((c) => [c, 0]));
  for (const intent of INTENT_NAMES) {
    const category = CATEGORY_OF[intent];
    totals.set(category, totals.get(category)! + (probabilities[intent] ?? 0));
  }
  let best: Category = CATEGORIES[0];
  for (const category of CATEGORIES) {
    if (totals.get(category)! > totals.get(best)!) best = category;
  }
  return { category: best, probability: totals.get(best)! };
}
