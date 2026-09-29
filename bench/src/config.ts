import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const SEED = 20260928;

const root = fileURLToPath(new URL("..", import.meta.url));

export const paths = {
  raw: join(root, ".data", "bitext.csv"),
  dev: join(root, "data", "bitext-dev.jsonl"),
  test: join(root, "data", "bitext-test.jsonl"),
  cache: join(root, "cache"),
  results: join(root, "results"),
  prices: join(root, "prices.json"),
};
