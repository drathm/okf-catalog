import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadBundle } from "../../src/bundle/load.js";
import { DEFAULT_CAPS, type LoadOptions } from "../../src/bundle/model.js";
import { deriveDocument } from "../../src/derive/derived-document.js";
import { renderReport } from "../../src/report/report.js";
import { NOW, readFixture } from "../helpers/fixtures.js";

const options = (patch: Partial<LoadOptions> = {}): LoadOptions => ({
  admit: ["stable", "deprecated"],
  dev: false,
  integrity: "require-manifest",
  specText: "2026-08-15",
  caps: DEFAULT_CAPS,
  ...patch,
});

describe("loadBundle: hostile reserved files (bite 3 build review)", () => {
  it("does not analyse an index.md past the analysis bounds, reports it, and still serves the bundle", () => {
    const hostile = `# Index\n\n${"*a ".repeat(8000)}x${" a*".repeat(8000)}\n`;
    const files = [
      { path: "index.md", bytes: Buffer.from(hostile) },
      { path: "a.md", bytes: Buffer.from("---\ntype: Note\ntitle: A\n---\n\nbody\n") },
    ];
    const started = performance.now();
    const { report, catalog } = loadBundle("h", files, options({ integrity: "none" }), NOW);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(catalog.pages.size).toBe(1);
    expect(report.degradations.map((d) => [d.path, d.code])).toContainEqual([
      "index.md",
      "reserved-unanalysed",
    ]);
  });

  it("orders refusals and missing paths by path, whatever order they arrived in", () => {
    const files = readFixture("refused");
    const { report } = loadBundle(
      "r",
      files,
      options({
        walkRefusals: [
          { path: "zz/late.md", rule: "symlink", detail: "x" },
          { path: "aa/early.md", rule: "symlink", detail: "x" },
        ],
      }),
      NOW,
    );
    const paths = report.refusals.map((r) => r.path);
    expect(paths).toEqual([...paths].sort());
  });
});

const { catalog: behaviours } = loadBundle("b", readFixture("behaviours"), options(), NOW);
const alpha = behaviours.pages.get("terms/alpha.md");
if (alpha === undefined) throw new Error("fixture page missing");

describe("deriveDocument: the duplicate-heading rule (bite 3 build review)", () => {
  const body = (title: string, text: string): string =>
    deriveDocument({ ...alpha, title, body: text }).body;
  it("keeps a heading whose text only starts like the title, such as `# C#` under the title C", () => {
    expect(body("C", "# C#\n\ntext\n")).toBe("# C#\n\ntext\n");
  });
  it("leaves an indented code block alone", () => {
    expect(body("Alpha", "    # Alpha\n    code\n")).toBe("    # Alpha\n    code\n");
  });
  it("removes a setext heading equal to the title", () => {
    expect(body("Alpha", "Alpha\n=====\n\ntext\n")).toBe("text\n");
  });
  it("removes an ATX heading equal to the title, with or without closing hashes", () => {
    expect(body("Alpha", "# Alpha ##\n\ntext\n")).toBe("text\n");
    expect(body("Alpha", "\n\n# Alpha\ntext\n")).toBe("text\n");
  });
});

describe("renderReport: hostile names (bite 3 build review)", () => {
  it("escapes control and direction-override characters so a file name cannot forge or hide a line", () => {
    const { report } = loadBundle("r", readFixture("refused"), options(), NOW);
    const first = report.refusals[0];
    if (first === undefined) throw new Error("fixture has no refusal");
    first.path = "evil\u001b]0;x\u0007\nFATAL forged‮";
    const text = renderReport(report);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: finding them is the point
    const unsafe = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
    expect(text).not.toMatch(unsafe);
    expect(text.split("\n").filter((l) => l.startsWith("FATAL"))).toHaveLength(0);
    expect(text).toContain("evil\\u001b]0;x\\u0007\\u000aFATAL forged\\u202e");
  });
});

describe("the core has no clock, environment, network or console of its own", () => {
  it("never reads the clock, the process or the network in src/bundle, src/catalog, src/derive or src/search", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");
    const forbidden = [
      /\bDate\.now\(/,
      /\bnew Date\(\)/,
      /\bglobalThis\b/,
      /\bperformance\./,
      /\bprocess\./,
      /\bfetch\(/,
      /\bconsole\./,
      /\bsetTimeout\(/,
      /\bsetImmediate\(/,
      /\bMath\.random\(/,
    ];
    for (const dir of ["bundle", "catalog", "derive", "search"]) {
      for (const name of readdirSync(join(root, dir))) {
        if (!name.endsWith(".ts")) continue;
        const source = readFileSync(join(root, dir, name), "utf8");
        for (const pattern of forbidden)
          expect(source, `${dir}/${name} ${pattern}`).not.toMatch(pattern);
      }
    }
  });
});

describe("paths and types with line breaks (bite 4 build review)", () => {
  it("refuses a bundle path that carries a control or line-separator character", () => {
    const files = [
      { path: "notes/evil\npage.md", bytes: Buffer.from("---\ntype: Note\n---\n") },
      { path: "notes/sep page.md", bytes: Buffer.from("---\ntype: Note\n---\n") },
      { path: "notes/ok.md", bytes: Buffer.from("---\ntype: Note\n---\n") },
    ];
    const { report, catalog } = loadBundle("h", files, options({ integrity: "none" }), NOW);
    expect(catalog.pages.size).toBe(1);
    expect(report.refusals.map((r) => r.rule)).toEqual(["path-escape", "path-escape"]);
  });
});
