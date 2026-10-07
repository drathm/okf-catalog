import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CAPS } from "../../src/bundle/model.js";
import { createLocalSource } from "../../src/source/local.js";
import { FIXTURES } from "../helpers/fixtures.js";

describe("createLocalSource", () => {
  it("walks the configured folder on every load and describes itself by the configured text, never a resolved path", () => {
    const source = createLocalSource(
      { path: join(FIXTURES, "spec-example"), configured: "./kb" },
      DEFAULT_CAPS,
    );
    const walked = source.load();
    expect(walked.files.map((f) => f.path)).toContain("manifest.json");
    expect(source.describe()).toBe("./kb");
    expect(source.kind).toBe("local");
  });
  it("throws a plain sentence for a folder that does not exist", () => {
    const source = createLocalSource(
      { path: join(FIXTURES, "nowhere"), configured: "./nowhere" },
      DEFAULT_CAPS,
    );
    expect(() => source.load()).toThrow(/does not exist|cannot be read/);
  });
});
