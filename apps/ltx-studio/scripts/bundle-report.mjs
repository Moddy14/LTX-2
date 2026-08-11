import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const distRoot = new URL("../dist/", import.meta.url).pathname;
const assetsRoot = join(distRoot, "assets");
const html = readFileSync(join(distRoot, "index.html"), "utf8");
const entryMatch = html.match(/<script[^>]+src="\/assets\/([^"]+\.js)"/);
if (!entryMatch) throw new Error("Vite entry chunk not found in dist/index.html");
const entry = entryMatch[1];

function sizes(file) {
  const content = readFileSync(join(assetsRoot, file));
  return {
    rawBytes: content.byteLength,
    gzipBytes: gzipSync(content, { level: 9 }).byteLength,
    brotliBytes: brotliCompressSync(content, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
    }).byteLength,
  };
}

const chunks = readdirSync(assetsRoot)
  .filter((file) => file.endsWith(".js"))
  .sort()
  .map((file) => ({ file, initial: file === entry, ...sizes(file) }));
const initial = chunks.find((chunk) => chunk.initial);
if (!initial) throw new Error(`Entry chunk ${basename(entry)} is missing`);

const report = {
  schemaVersion: "ltx-studio-bundle-report.v1",
  build: {
    node: process.version,
    vite: JSON.parse(readFileSync(new URL("../node_modules/vite/package.json", import.meta.url))).version,
  },
  baseline: { initialRawBytes: 533_430, initialGzipBytes: 155_280 },
  target: { initialRawBytesMax: 450_000, initialGzipBytesMax: 140_000 },
  initial: {
    file: initial.file,
    rawBytes: initial.rawBytes,
    gzipBytes: initial.gzipBytes,
    brotliBytes: initial.brotliBytes,
  },
  chunks,
  staticGate: initial.rawBytes <= 450_000 && initial.gzipBytes <= 140_000 ? "pass" : "fail",
  performanceGate: "pending-40-cold-context-runs",
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
