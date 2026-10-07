import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadBundle } from "../../src/bundle/load.js";
import { DEFAULT_CAPS } from "../../src/bundle/model.js";
import { reportToJson } from "../../src/commands/check.js";
import { NOW, readFixture } from "../helpers/fixtures.js";

/**
 * Whole-report golden files: every fixture's report, as `check --json` prints it, compared with a stored copy.
 * A deliberate change to any count, code, rule or detail string is made by running the suite with
 * UPDATE_EXPECTED=1 and committing the new files. (From the bite 2 build review, finding F10.)
 */
const expectedDir = join(dirname(fileURLToPath(import.meta.url)), "..", "expected");
const options = {
  admit: ["stable", "deprecated"] as const,
  dev: false,
  specText: "2026-08-15" as const,
  caps: DEFAULT_CAPS,
};

describe("golden reports", () => {
  for (const [name, integrity] of [
    ["spec-example", "require-manifest"],
    ["behaviours", "require-manifest"],
    ["refused", "require-manifest"],
    ["no-manifest", "none"],
  ] as const) {
    it(`${name}: the whole report equals its stored copy`, () => {
      const { report } = loadBundle(
        name,
        readFixture(name),
        { ...options, admit: [...options.admit], integrity },
        NOW,
      );
      const actual = reportToJson(report);
      const file = join(expectedDir, `${name}.report.json`);
      if (process.env.UPDATE_EXPECTED === "1" || !existsSync(file)) {
        mkdirSync(expectedDir, { recursive: true });
        writeFileSync(file, actual);
      }
      expect(actual).toBe(readFileSync(file, "utf8"));
    });
  }
});
