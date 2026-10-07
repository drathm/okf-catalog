import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runCli } from "../helpers/cli.js";
import { FIXTURES, NOW } from "../helpers/fixtures.js";

/**
 * Whole-report golden files: every fixture's report exactly as `okf-catalog check --json` prints it, through the
 * walker and the command, compared with a stored copy. A deliberate change to any count, code, rule or detail
 * string is made by running the suite with UPDATE_EXPECTED=1 and committing the new files. (From the bite 2
 * build review, finding F10; routed through the command after the bite 3 build review, finding F18.)
 */
const expectedDir = join(dirname(fileURLToPath(import.meta.url)), "..", "expected");

describe("golden reports", () => {
  for (const [name, flags] of [
    ["spec-example", []],
    ["behaviours", []],
    ["refused", []],
    ["no-manifest", ["--integrity", "none"]],
  ] as const) {
    it(`${name}: the whole report equals its stored copy`, async () => {
      const run = await runCli(["check", join(FIXTURES, name), "--json", ...flags], {
        env: { OKF_CATALOG_NOW: NOW.toISOString() },
      });
      expect(run.stderr).toBe("");
      const actual = run.stdout;
      const file = join(expectedDir, `${name}.report.json`);
      if (process.env.UPDATE_EXPECTED === "1" || !existsSync(file)) {
        mkdirSync(expectedDir, { recursive: true });
        writeFileSync(file, actual);
      }
      expect(actual).toBe(readFileSync(file, "utf8"));
    });
  }
});
