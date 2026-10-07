#!/usr/bin/env node
// Writes the degraded bundle of acceptance item 7 into a folder: three pages across two folders, no index.md
// anywhere, one page of a type the configuration does not declare (Recipe), one link to a page that does not
// exist, and the manifest a served bundle needs. Serve it with a configuration that declares `types:
// [Term, Guide]` and leaves development mode off; `status` must list the unknown type, the broken link and
// the folders without an index, refuse nothing, and the pages must be searchable and readable.
// Usage: node bench/acceptance/write-degraded-bundle.mjs <new or empty folder>
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const target = process.argv[2];
if (target === undefined) {
  process.stderr.write("usage: write-degraded-bundle.mjs <folder>\n");
  process.exit(2);
}
if (existsSync(target) && readdirSync(target).length > 0) {
  process.stderr.write(`${target} is not empty\n`);
  process.exit(2);
}
export const PAGES = {
  "terms/alpha.md":
    "---\ntype: Term\ntitle: Alpha\nstatus: stable\n---\n\nAlpha links to [a page that is not there](/terms/missing.md).\n",
  "terms/beta.md":
    "---\ntype: Recipe\ntitle: Zanzibar coffee ritual\nstatus: stable\n---\n\nA page of a type the company never declared.\n",
  "guides/gamma.md":
    "---\ntype: Guide\ntitle: Gamma\nstatus: stable\n---\n\nA guide in a folder with no index file.\n",
};
for (const [path, body] of Object.entries(PAGES)) {
  mkdirSync(join(target, dirname(path)), { recursive: true });
  writeFileSync(join(target, path), body);
}
const here = dirname(fileURLToPath(import.meta.url));
execFileSync(
  process.execPath,
  [join(here, "..", "..", "test", "tools", "make-manifest.mjs"), target],
  {
    stdio: "ignore",
  },
);
process.stdout.write(
  `wrote ${Object.keys(PAGES).length} pages and a manifest under ${target}; serve it with types: [Term, Guide]\n`,
);
