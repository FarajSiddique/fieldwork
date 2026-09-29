import { readFile } from "node:fs/promises";
import { downloadBitext, parseBitext } from "./bitext/load.ts";
import { sampleBitext, type BitextTicket } from "./bitext/sample.ts";
import { paths, SEED } from "./config.ts";
import { writeJsonl } from "./io.ts";

await downloadBitext(paths.raw);
const rows = parseBitext(await readFile(paths.raw, "utf8"));
const { dev, test } = sampleBitext(rows, { seed: SEED, devPerIntent: 10, testPerIntent: 40 });
await writeJsonl(paths.dev, dev);
await writeJsonl(paths.test, test);

const withOrder = (tickets: BitextTicket[]) => tickets.filter((t) => t.orderNumber !== null).length;
console.log(`Bitext rows: ${rows.length}`);
console.log(`dev: ${dev.length} tickets (${withOrder(dev)} with an order number)`);
console.log(`test: ${test.length} tickets (${withOrder(test)} with an order number)`);
