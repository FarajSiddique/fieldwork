import { digits, pickOne, type Rng } from "../rng.ts";

const PLACEHOLDER = /\{\{([^}]+)\}\}/g;

const VALUES = {
  "Account Type": ["Free", "Standard", "Premium", "Business", "Gold"],
  "Account Category": ["personal", "family", "business", "student"],
  "Person Name": ["Maria Lopez", "James Chen", "Aisha Khan", "Tom Becker", "Sofia Rossi"],
  "Currency Symbol": ["$", "€", "£"],
  "Delivery City": ["Chicago", "Lyon", "Osaka", "Toronto", "Manchester"],
  "Delivery Country": ["Canada", "Germany", "Japan", "Mexico", "Spain"],
} satisfies Record<string, readonly string[]>;

export interface Filled {
  text: string;
  /** The value put in for {{Order Number}}, which is the ticket's order-number label. */
  orderNumber: string | null;
}

export function fillPlaceholders(text: string, rng: Rng): Filled {
  let orderNumber: string | null = null;
  const filled = text.replace(PLACEHOLDER, (_match, name: string) => {
    switch (name) {
      case "Order Number":
        orderNumber ??= `#${digits(6, rng)}`;
        return orderNumber;
      case "Invoice Number":
        return `#${digits(5, rng)}`;
      case "Refund Amount":
        return (10 + Math.floor(rng() * 49000) / 100).toFixed(2);
      default:
        if (!Object.hasOwn(VALUES, name)) throw new Error(`Unknown Bitext placeholder {{${name}}}`);
        return pickOne(VALUES[name as keyof typeof VALUES], rng);
    }
  });
  return { text: filled, orderNumber };
}
