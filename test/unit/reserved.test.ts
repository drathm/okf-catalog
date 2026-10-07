import { describe, expect, it } from "vitest";
import { parseReserved, reservedKind } from "../../src/bundle/reserved.js";
import { readFixture } from "../helpers/fixtures.js";

const text = (bundle: string, path: string): string => {
  const file = readFixture(bundle).find((f) => f.path === path);
  if (!file) throw new Error(`${bundle}/${path} missing`);
  return new TextDecoder().decode(file.bytes);
};

describe("reservedKind", () => {
  it("recognises index.md and log.md at any depth and nothing else", () => {
    expect(reservedKind("index.md")).toBe("index");
    expect(reservedKind("a/b/c/log.md")).toBe("log");
    expect(reservedKind("a/index.markdown")).toBeUndefined();
    expect(reservedKind("a/my-index.md")).toBeUndefined();
    expect(reservedKind("Index.md")).toBeUndefined();
  });
});

describe("parseReserved", () => {
  it("keeps the frontmatter the example bundle's log carries and starts the body after it", () => {
    const r = parseReserved("log.md", text("spec-example", "log.md"));
    expect(r.kind).toBe("log");
    expect(r.folder).toBe("");
    expect(r.frontmatter).toEqual({ type: "Log", title: "Acme Retail bundle history" });
    expect(r.body.trimStart().startsWith("# Bundle history")).toBe(true);
    expect(r.degradations).toEqual([]);
  });

  it("lifts okf_version from a root index and leaves it off a folder index", () => {
    const root = parseReserved("index.md", text("behaviours", "index.md"));
    expect(root.okfVersion).toBe("0.2");
    expect(root.body.trimStart().startsWith("# Folders")).toBe(true);
    const folder = parseReserved("terms/index.md", text("behaviours", "terms/index.md"));
    expect(folder.folder).toBe("terms");
    expect(folder.frontmatter).toBeUndefined();
    expect(folder.okfVersion).toBeUndefined();
    expect(folder.body.startsWith("# Terms")).toBe(true);
  });

  it("degrades, never refuses, when a reserved file's frontmatter does not parse", () => {
    const r = parseReserved("index.md", "---\ntitle: [unclosed\n---\n# Listing\n");
    expect(r.frontmatter).toBeUndefined();
    expect(r.body).toBe("# Listing\n");
    expect(r.degradations.map((d) => d.code)).toEqual(["reserved-frontmatter-unparseable"]);
  });

  it("reports an okf_version it does not know and reads a numeric one as written", () => {
    const r = parseReserved("index.md", "---\nokf_version: 9.9\n---\n# Listing\n");
    expect(r.okfVersion).toBe("9.9");
    expect(r.degradations.map((d) => d.code)).toEqual(["okf-version-unknown"]);
  });
});

describe("parseReserved: review round 1 additions", () => {
  it("does not lift okf_version from a folder index", () => {
    const r = parseReserved("terms/index.md", '---\nokf_version: "0.2"\n---\n# Terms\n');
    expect(r.okfVersion).toBeUndefined();
    expect(r.frontmatter).toEqual({ okf_version: "0.2" });
  });
});
