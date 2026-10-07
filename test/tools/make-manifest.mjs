#!/usr/bin/env node
// Writes manifest.json for a fixture bundle: every file except manifest.json, with its sha256 and size.
// Usage: node test/tools/make-manifest.mjs test/fixtures/bundles/<name>
// `okf-catalog pack` writes real manifests, but it leaves drafts out and refuses what the loader refuses, while
// the fixtures carry drafts and refused files on purpose; so this small tool stays for the fixtures alone.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.argv[2];
if (!root) {
  process.stderr.write("usage: make-manifest.mjs <bundle folder>\n");
  process.exit(2);
}
const files = {};
const walk = (dir) => {
  for (const entry of readdirSync(dir).sort()) {
    if (entry === ".DS_Store" || entry === "Thumbs.db") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else {
      const rel = relative(root, full).split("\\").join("/");
      if (rel === "manifest.json") continue;
      const bytes = readFileSync(full);
      files[rel] = {
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length,
      };
    }
  }
};
walk(root);
const manifest = {
  okf_catalog: 1,
  commit: "0000000000000000000000000000000000000000",
  published_at: "2026-10-06T00:00:00Z",
  files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1))),
};
writeFileSync(join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
process.stderr.write(
  `wrote ${Object.keys(files).length} entries to ${join(root, "manifest.json")}\n`,
);
