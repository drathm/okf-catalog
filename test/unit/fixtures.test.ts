import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIXTURES, readFixture } from "../helpers/fixtures.js";

interface FixtureManifest {
  okf_catalog: number;
  files: Record<string, { sha256: string; bytes: number }>;
}

describe("fixture bundles", () => {
  for (const name of ["spec-example", "behaviours", "refused"]) {
    it(`${name}: every file matches its manifest entry, and nothing is missing`, () => {
      const manifest = JSON.parse(
        readFileSync(join(FIXTURES, name, "manifest.json"), "utf8"),
      ) as FixtureManifest;
      expect(manifest.okf_catalog).toBe(1);
      const files = readFixture(name).filter((f) => f.path !== "manifest.json");
      expect(files.map((f) => f.path)).toEqual(Object.keys(manifest.files));
      for (const file of files) {
        const entry = manifest.files[file.path];
        expect(entry, file.path).toBeDefined();
        expect(createHash("sha256").update(file.bytes).digest("hex"), file.path).toBe(
          entry?.sha256,
        );
        expect(file.bytes.length, file.path).toBe(entry?.bytes);
      }
    });
  }

  it("no-manifest: has no manifest, by design", () => {
    expect(existsSync(join(FIXTURES, "no-manifest", "manifest.json"))).toBe(false);
  });

  it("spec-example: is the nineteen-file copy of the specification's example bundle", () => {
    const files = readFixture("spec-example").filter((f) => f.path !== "manifest.json");
    expect(files).toHaveLength(19);
    expect(files.map((f) => f.path)).toContain("metrics/gross-margin-legacy.md");
    expect(files.map((f) => f.path)).toContain("viz.html");
  });
});
