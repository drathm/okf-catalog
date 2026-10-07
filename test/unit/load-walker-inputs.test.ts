import { describe, expect, it } from "vitest";
import { loadBundle } from "../../src/bundle/load.js";
import { DEFAULT_CAPS, type LoadOptions } from "../../src/bundle/model.js";
import { NOW, readFixture } from "../helpers/fixtures.js";

const options = (patch: Partial<LoadOptions> = {}): LoadOptions => ({
  admit: ["stable", "deprecated"],
  dev: false,
  integrity: "require-manifest",
  specText: "2026-08-15",
  caps: DEFAULT_CAPS,
  ...patch,
});

describe("loadBundle with the walker's inputs", () => {
  it("counts hidden paths the walker did not read, refuses the engine folder among them, and treats them as present for the manifest", () => {
    const files = readFixture("refused").filter((f) => !f.path.startsWith(".qmd/"));
    const { report } = loadBundle(
      "r",
      files,
      options({ hiddenPaths: [".qmd", ".git"], hiddenFolders: [".qmd", ".git"] }),
      NOW,
    );
    expect(report.hidden).toBe(2);
    expect(report.refusals.map((r) => [r.path, r.rule])).toContainEqual([".qmd", "engine-config"]);
    expect(report.missingOnDisk).toEqual([]);
  });

  it("returns the walker's fatal refusal without serving anything", () => {
    const { report, catalog } = loadBundle(
      "r",
      readFixture("refused"),
      options({
        walkFatal: { path: "", rule: "too-many-files", detail: "25 files exceeds the cap of 20" },
      }),
      NOW,
    );
    expect(report.fatal).toMatchObject({ rule: "too-many-files" });
    expect(catalog.pages.size).toBe(0);
  });
});
