import { describe, expect, it } from "vitest";
import {
  admit,
  capRefusals,
  isEngineConfig,
  isHidden,
  unknownTypes,
} from "../../src/bundle/contract.js";
import type { Page } from "../../src/bundle/model.js";

const page = (patch: Partial<Page>): Page =>
  ({
    path: "p.md",
    folder: "",
    hash: "",
    type: "Term",
    title: "T",
    titleSource: "frontmatter",
    descriptionSource: "none",
    tags: [],
    status: "stable",
    statusSource: "frontmatter",
    verified: [],
    trust: "unverified",
    sources: [],
    links: [],
    footnoteReferences: [],
    frontmatter: {},
    body: "",
    degradations: [],
    ...patch,
  }) as Page;

describe("admit", () => {
  it("admits the statuses the company lists and nothing else", () => {
    expect(admit(page({ status: "stable" }), ["stable", "deprecated"], false)).toBe(true);
    expect(admit(page({ status: "deprecated" }), ["stable", "deprecated"], false)).toBe(true);
    expect(admit(page({ status: "draft" }), ["stable", "deprecated"], false)).toBe(false);
    expect(admit(page({ status: "stable" }), ["deprecated"], false)).toBe(false);
  });

  it("admits drafts, and so unknown statuses read as draft, only under the development flag", () => {
    expect(admit(page({ status: "draft" }), ["stable", "deprecated"], true)).toBe(true);
    expect(
      admit(page({ status: "draft", statusRaw: "archived" }), ["stable", "deprecated"], true),
    ).toBe(true);
  });
});

describe("unknownTypes", () => {
  it("is empty when the company declares no types, and lists undeclared values otherwise", () => {
    const pages = [page({ type: "Term" }), page({ type: "Widget" }), page({ type: "Widget" })];
    expect(unknownTypes(pages, undefined)).toEqual([]);
    expect(unknownTypes(pages, [])).toEqual([]);
    expect(unknownTypes(pages, ["Term"])).toEqual(["Widget"]);
  });
});

describe("hidden paths and engine configuration", () => {
  it("treats any dot-leading segment as hidden, except the engine's own folder which is refused", () => {
    expect(isHidden(".github/x.md")).toBe(true);
    expect(isHidden("a/.hidden/b.md")).toBe(true);
    expect(isHidden("a/.DS_Store")).toBe(true);
    expect(isHidden("a/b.md")).toBe(false);
    expect(isEngineConfig(".qmd/index.yml")).toBe(true);
    expect(isEngineConfig("sub/.qmd")).toBe(true);
    expect(isEngineConfig("sub/qmd.yml")).toBe(false);
  });
});

describe("capRefusals", () => {
  const caps = { fileBytes: 10, files: 3, treeBytes: 25 };
  const file = (path: string, size: number) => ({ path, bytes: new Uint8Array(size) });

  it("refuses an oversize file per path and keeps the rest", () => {
    const r = capRefusals([file("a.md", 5), file("big.md", 11)], caps);
    expect(r.fatal).toBeUndefined();
    expect(r.perFile).toEqual([
      { path: "big.md", rule: "oversize", detail: "11 bytes exceeds the cap of 10" },
    ]);
  });

  it("makes too many files, or too large a tree, fatal", () => {
    expect(
      capRefusals([file("a.md", 1), file("b.md", 1), file("c.md", 1), file("d.md", 1)], caps).fatal,
    ).toMatchObject({ rule: "too-many-files" });
    expect(
      capRefusals([file("a.md", 10), file("b.md", 10), file("c.md", 10)], caps).fatal,
    ).toMatchObject({ rule: "tree-too-large" });
  });
});
