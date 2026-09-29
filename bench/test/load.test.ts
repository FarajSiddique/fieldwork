import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { downloadBitext, parseBitext, sha256 } from "../src/bitext/load.ts";

const CSV = [
  "flags,instruction,category,intent,response",
  'B,"cancel order {{Order Number}}",ORDER,cancel_order,"Sure, I can help"',
  "BL,where is my refund,REFUND,track_refund,ok",
  "",
].join("\n");

describe("parseBitext", () => {
  it("reads rows with their index, flags, instruction and intent", () => {
    expect(parseBitext(CSV)).toEqual([
      { index: 0, flags: "B", instruction: "cancel order {{Order Number}}", intent: "cancel_order" },
      { index: 1, flags: "BL", instruction: "where is my refund", intent: "track_refund" },
    ]);
  });

  it("throws on an intent it does not know", () => {
    const bad = CSV.replace("track_refund", "weather");
    expect(() => parseBitext(bad)).toThrow('Unknown Bitext intent "weather" on row 1');
  });

  it("throws when the columns are not Bitext's", () => {
    expect(() => parseBitext("a,b\n1,2\n")).toThrow("Unexpected Bitext columns");
  });
});

describe("downloadBitext", () => {
  const body = "flags,instruction\n";
  const okFetch = () => vi.fn(async () => new Response(body, { status: 200 }));

  it("writes the file when the hash matches", async () => {
    const dest = join(await mkdtemp(join(tmpdir(), "bitext-")), "sub", "bitext.csv");
    const fetchImpl = okFetch();
    await downloadBitext(dest, fetchImpl, sha256(body));
    expect(await readFile(dest, "utf8")).toBe(body);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("throws on a hash mismatch and writes nothing", async () => {
    const dest = join(await mkdtemp(join(tmpdir(), "bitext-")), "bitext.csv");
    await expect(downloadBitext(dest, okFetch(), sha256("something else"))).rejects.toThrow(
      "Bitext hash mismatch",
    );
    await expect(readFile(dest)).rejects.toThrow();
  });

  it("skips the download when a file with the right hash is already there", async () => {
    const dest = join(await mkdtemp(join(tmpdir(), "bitext-")), "bitext.csv");
    await writeFile(dest, body);
    const fetchImpl = okFetch();
    await downloadBitext(dest, fetchImpl, sha256(body));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws on an HTTP error", async () => {
    const dest = join(await mkdtemp(join(tmpdir(), "bitext-")), "bitext.csv");
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 404 }));
    await expect(downloadBitext(dest, fetchImpl, sha256(body))).rejects.toThrow("HTTP 404");
  });
});
