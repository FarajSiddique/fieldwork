import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parse } from "csv-parse/sync";
import { isIntent, type Intent } from "../intents.ts";

const REVISION = "430d1a89bd93bd1fa23c16f29dd53e73f0087443";
const FILE = "Bitext_Sample_Customer_Support_Training_Dataset_27K_responses-v11.csv";

export const BITEXT_URL = `https://huggingface.co/datasets/bitext/Bitext-customer-support-llm-chatbot-training-dataset/resolve/${REVISION}/${FILE}`;
export const BITEXT_SHA256 = "6f81102b0100b97b8468eb04368033a23206bf1fde9d53500d5806ec1001a434";

export type FetchLike = (url: string) => Promise<Response>;

export function sha256(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Download the pinned Bitext CSV to `dest`, unless a copy with the expected hash is already there. */
export async function downloadBitext(
  dest: string,
  fetchImpl: FetchLike = fetch,
  expected: string = BITEXT_SHA256,
): Promise<void> {
  const existing = await readFile(dest).catch(() => undefined);
  if (existing && sha256(existing) === expected) return;

  const res = await fetchImpl(BITEXT_URL);
  if (!res.ok) throw new Error(`Bitext download failed: HTTP ${res.status}`);
  const body = new Uint8Array(await res.arrayBuffer());
  const actual = sha256(body);
  if (actual !== expected) {
    throw new Error(`Bitext hash mismatch: expected ${expected}, got ${actual}`);
  }
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, body);
}

export interface BitextRow {
  index: number;
  flags: string;
  instruction: string;
  intent: Intent;
}

const COLUMNS = ["flags", "instruction", "category", "intent", "response"];

export function parseBitext(csv: string): BitextRow[] {
  const records = parse(csv, { columns: true, skip_empty_lines: true }) as Record<string, string>[];
  const header = Object.keys(records[0] ?? {});
  if (records.length === 0 || COLUMNS.some((c) => !header.includes(c))) {
    throw new Error(`Unexpected Bitext columns: ${header.join(", ")}`);
  }
  return records.map((record, index) => {
    const intent = record.intent ?? "";
    if (!isIntent(intent)) throw new Error(`Unknown Bitext intent "${intent}" on row ${index}`);
    return { index, flags: record.flags ?? "", instruction: record.instruction ?? "", intent };
  });
}
