import { describe, expect, it } from "vitest";
import { generateIndex, parseIndex } from "../../src/bundle/index-file.js";
import { readFixture } from "../helpers/fixtures.js";

const text = (bundle: string, path: string): string => {
  const file = readFixture(bundle).find((f) => f.path === path);
  if (!file) throw new Error(`${bundle}/${path} missing`);
  return new TextDecoder().decode(file.bytes);
};

describe("parseIndex", () => {
  it("reads the example bundle's root index: one section, six subfolder entries with descriptions", () => {
    const sections = parseIndex(text("spec-example", "index.md"));
    expect(sections.map((s) => s.heading)).toEqual(["Subdirectories"]);
    const entries = sections[0]?.entries ?? [];
    expect(entries).toHaveLength(6);
    expect(entries[0]).toEqual({
      title: "tables",
      href: "tables/index.md",
      description: "BigQuery tables the bundle grounds against.",
    });
  });

  it("reads a folder index written for the tests, eight entries", () => {
    const sections = parseIndex(text("behaviours", "terms/index.md"));
    expect(sections).toHaveLength(1);
    expect(sections[0]?.entries.map((e) => e.href)).toEqual([
      "alpha.md",
      "beta.md",
      "gamma.md",
      "delta.md",
      "epsilon.md",
      "zeta.md",
      "eta.md",
      "theta.md",
    ]);
  });

  it("keeps a description that itself contains a dash, and accepts an entry without one", () => {
    const sections = parseIndex("# Pages\n\n* [A](a.md) - first - with a dash\n* [B](b.md)\n");
    expect(sections[0]?.entries).toEqual([
      { title: "A", href: "a.md", description: "first - with a dash" },
      { title: "B", href: "b.md" },
    ]);
  });

  it("ignores list items without a link and puts entries before any heading in an unnamed section", () => {
    const sections = parseIndex("* [A](a.md) - x\n* plain item\n");
    expect(sections).toEqual([
      { heading: "", entries: [{ title: "A", href: "a.md", description: "x" }] },
    ]);
  });
});

describe("generateIndex", () => {
  const pages = [
    { path: "terms/beta.md", title: "Beta", description: "The beta term." },
    { path: "terms/alpha.md", title: "Alpha" },
  ];

  it("writes the §8 layout: pages then subfolders, sorted by path, relative hrefs", () => {
    expect(generateIndex("terms", pages, ["zeta-folder", "archive"])).toBe(
      [
        "# Pages",
        "",
        "* [Alpha](alpha.md)",
        "* [Beta](beta.md) - The beta term.",
        "",
        "# Subfolders",
        "",
        "* [archive](archive/)",
        "* [zeta-folder](zeta-folder/)",
        "",
      ].join("\n"),
    );
  });

  it("omits an empty section", () => {
    expect(generateIndex("terms", pages, [])).not.toContain("Subfolders");
    expect(generateIndex("x", [], ["a"])).not.toContain("Pages");
  });

  it("round-trips through parseIndex", () => {
    const sections = parseIndex(generateIndex("terms", pages, ["archive"]));
    expect(sections).toEqual([
      {
        heading: "Pages",
        entries: [
          { title: "Alpha", href: "alpha.md" },
          { title: "Beta", href: "beta.md", description: "The beta term." },
        ],
      },
      { heading: "Subfolders", entries: [{ title: "archive", href: "archive/" }] },
    ]);
  });
});
