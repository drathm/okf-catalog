import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "bundles");

/** A fixed clock for every core test; pages written for the tests use the years 2000 and 2999. */
export const NOW = new Date("2026-10-06T12:00:00Z");

/** Files the operating system or an editor may drop into a checkout; never part of a fixture. */
const IGNORED = new Set([".DS_Store", "Thumbs.db"]);

export interface FixtureFile {
  path: string;
  bytes: Uint8Array;
}

/** Reads a fixture bundle into memory as the core expects it: sorted POSIX paths, raw bytes. */
export function readFixture(name: string): FixtureFile[] {
  const root = join(FIXTURES, name);
  const files: FixtureFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (IGNORED.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else
        files.push({ path: relative(root, full).split("\\").join("/"), bytes: readFileSync(full) });
    }
  };
  walk(root);
  return files.sort((a, b) => (a.path < b.path ? -1 : 1));
}
