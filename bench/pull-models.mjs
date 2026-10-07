#!/usr/bin/env node
// The approval step for the measurement's models (invariant 6): running this is the maintainer's say-so.
// Usage: node bench/pull-models.mjs embed [rerank] [expand]. Prints what each named model is, how big it is
// and under which terms, fetches it through node-llama-cpp's resolver into bench/.models/ (gitignored; one
// `rm -r` removes it), then checks the file's name, size and SHA-256 against the values pinned in
// bench/lib/models.mjs. Nothing else in the harness fetches anything.
import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatBytes, MODELS, modelPath } from "./lib/models.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, ".models");
const keys = process.argv.slice(2);
const known = new Set(MODELS.map((m) => m.key));
if (keys.length === 0 || keys.some((k) => !known.has(k))) {
  process.stderr.write(`usage: node bench/pull-models.mjs <${[...known].join("|")}>...\n\n`);
  for (const m of MODELS)
    process.stderr.write(
      `  ${m.key}: ${m.role}, ${m.uri}, ${formatBytes(m.bytes)} bytes, ${m.licence}\n`,
    );
  process.exit(2);
}
mkdirSync(dir, { recursive: true });

const sha256Of = (path) =>
  new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolveHash(hash.digest("hex")))
      .on("error", reject);
  });

const { resolveModelFile } = await import("node-llama-cpp");
let failed = false;
for (const key of keys) {
  const entry = MODELS.find((m) => m.key === key);
  process.stdout.write(
    `${entry.key}: ${entry.role}, ${entry.uri}, ${formatBytes(entry.bytes)} bytes, ${entry.licence}\n`,
  );
  const expected = modelPath(dir, entry);
  const path = await resolveModelFile(entry.uri, { directory: dir, cli: true });
  const problems = [];
  if (basename(path) !== entry.file) problems.push(`resolved to ${path}, expected ${expected}`);
  const size = statSync(path).size;
  if (size !== entry.bytes) problems.push(`size ${size}, expected ${entry.bytes}`);
  const digest = await sha256Of(path);
  if (digest !== entry.sha256) problems.push(`sha256 ${digest}, expected ${entry.sha256}`);
  if (problems.length > 0) {
    failed = true;
    // Left in place, the file would be reused by the resolver on the next run; removed, the next run fetches.
    unlinkSync(path);
    process.stderr.write(
      `${entry.key}: NOT the pinned file (${problems.join("; ")}); removed, so the next run fetches it again\n`,
    );
  } else process.stdout.write(`${entry.key}: in place at ${path}, size and SHA-256 as pinned\n`);
}
process.exit(failed ? 1 : 0);
