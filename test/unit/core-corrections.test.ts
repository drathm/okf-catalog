import { describe, expect, it } from "vitest";
import { parseFrontmatter, splitFrontmatter } from "../../src/bundle/frontmatter.js";
import { generateIndex, parseIndex } from "../../src/bundle/index-file.js";
import { resolveLink } from "../../src/bundle/links.js";
import { loadBundle } from "../../src/bundle/load.js";
import { parseManifest } from "../../src/bundle/manifest.js";
import { DEFAULT_CAPS, type LoadOptions } from "../../src/bundle/model.js";
import { parsePage } from "../../src/bundle/page.js";
import { parseTimestamp } from "../../src/bundle/timestamp.js";
import { provenanceOf } from "../../src/catalog/provenance.js";
import { NOW, readFixture } from "../helpers/fixtures.js";

const options = (patch: Partial<LoadOptions> = {}): LoadOptions => ({
  admit: ["stable", "deprecated"],
  dev: false,
  integrity: "none",
  specText: "2026-08-15",
  caps: DEFAULT_CAPS,
  ...patch,
});
const file = (path: string, text: string) => ({ path, bytes: new TextEncoder().encode(text) });
const linkIndex = {
  pages: new Set<string>(),
  reserved: new Set<string>(),
  attachments: new Set<string>(),
  folders: new Set([""]),
};
const inline = (text: string) =>
  parsePage(file("x.md", text), { linkIndex, specText: "2026-08-15" });

describe("frontmatter fences and positions", () => {
  it("accepts spaces and tabs after either fence, as both checkers do", () => {
    expect(splitFrontmatter("--- \ntype: T\n---\t\nBody\n")).toEqual({
      block: "type: T",
      body: "Body\n",
    });
  });

  it("reports YAML error positions as file lines, without a dangling colon, and names a duplicate key", () => {
    const bad = parseFrontmatter("type: Note\ntitle: [unclosed", 1);
    expect(!bad.ok && bad.error).toMatch(/line 3/);
    expect(!bad.ok && bad.error).not.toMatch(/:\s*$/);
    const dup = parseFrontmatter("type: A\ntype: B\n", 1);
    expect(!dup.ok && dup.error).toMatch(/duplicate key "type"/);
  });

  it("says an unclosed block is unclosed", () => {
    const r = inline("---\ntype: T\nnever closed\n");
    expect(r).toMatchObject({
      ok: false,
      refusal: { rule: "no-frontmatter", detail: expect.stringMatching(/never closed/) },
    });
  });
});

describe("timestamps at the edges", () => {
  it("accepts years 0001 to 0099", () => {
    expect(parseTimestamp("0001-01-01")).toMatchObject({
      kind: "date",
      at: new Date("0001-01-01T00:00:00Z"),
    });
    expect(parseTimestamp("0099-12-31")).toMatchObject({ kind: "date" });
  });

  it("reads a leap second as the last millisecond of the minute", () => {
    expect(parseTimestamp("2000-06-01T23:59:60Z")).toMatchObject({
      kind: "datetime",
      at: new Date(Date.UTC(2000, 5, 1, 23, 59, 59, 999)),
    });
  });

  it("accepts offsets written as hhmm or hh", () => {
    expect(parseTimestamp("2000-06-01T18:00:00+0200")).toMatchObject({
      at: new Date(Date.UTC(2000, 5, 1, 16)),
    });
    expect(parseTimestamp("2000-06-01T18:00:00-02")).toMatchObject({
      at: new Date(Date.UTC(2000, 5, 1, 20)),
    });
  });
});

describe("page details", () => {
  it("reads a numeric source id as written and matches a numeric footnote to it, reporting a missing id once", () => {
    const r = inline(
      "---\ntype: T\ntitle: T\ndescription: D\nsources:\n  - { id: 1, resource: https://x }\n---\nA.[^1] B.[^2] C.[^2]\n\n[^1]: one\n[^2]: two\n",
    );
    if (!r.ok) throw new Error(r.refusal.rule);
    expect(r.page.sources[0]?.id).toBe("1");
    expect(r.page.degradations.filter((d) => d.code === "footnote-without-source")).toHaveLength(1);
  });

  it("reports a verification without a time and names the latest verifier by instant", () => {
    const r = inline(
      "---\ntype: T\ntitle: T\ndescription: D\nverified:\n  - { by: human:late, at: 2000-03-01T00:00:00Z }\n  - { by: human:early, at: 2000-01-01T00:00:00Z }\n  - { by: human:undated }\n---\n",
    );
    if (!r.ok) throw new Error(r.refusal.rule);
    expect(r.page.degradations.map((d) => d.code)).toContain("verification-without-at");
    expect(r.page.latestVerification).toEqual({
      by: "human:late",
      at: { raw: "2000-03-01T00:00:00Z", at: new Date(Date.UTC(2000, 2, 1)) },
    });
    expect(provenanceOf(r.page, NOW).latestVerification).toEqual({
      by: "human:late",
      at: "2000-03-01T00:00:00Z",
    });
  });

  it("treats an empty stale_after as absent, and says what a wrongly typed value is", () => {
    const empty = inline("---\ntype: T\ntitle: T\ndescription: D\nstale_after:\n---\n");
    expect(empty.ok && empty.page.staleAfter).toBeUndefined();
    expect(empty.ok && empty.page.degradations).toEqual([]);
    const list = inline("---\ntype: [a, b]\n---\n");
    expect(list).toMatchObject({
      ok: false,
      refusal: { rule: "no-type", detail: expect.stringMatching(/list/) },
    });
  });

  it("reports inline HTML with an event handler and keeps it out of the derived description", () => {
    const r = inline(
      "---\ntype: T\ntitle: T\n---\nHello <img src=x onerror=alert(1)> world. More.\n",
    );
    if (!r.ok) throw new Error(r.refusal.rule);
    expect(r.page.description).toBe("Hello world.");
    expect(r.page.degradations.map((d) => d.code)).toContain("body-html");
  });

  it("reports field-ignored for a non-scalar tag and description-missing for an empty body", () => {
    const r = inline("---\ntype: T\ntitle: T\ntags: [1, true, { a: 1 }]\n---\n");
    if (!r.ok) throw new Error(r.refusal.rule);
    expect(r.page.tags).toEqual(["1", "true"]);
    expect(r.page.degradations.map((d) => d.code).sort()).toEqual([
      "description-missing",
      "field-ignored",
    ]);
  });

  it("uses a distinct code when a deprecated page's first link is a folder or an attachment", async () => {
    const files = [
      file(
        "old.md",
        "---\ntype: T\ntitle: Old\ndescription: D\nstatus: deprecated\n---\nSee [the folder](/sub/).\n",
      ),
      file("sub/new.md", "---\ntype: T\ntitle: New\ndescription: D\n---\nBody.\n"),
    ];
    const { report } = loadBundle("x", files, options(), NOW);
    expect(report.degradations.map((d) => d.code)).toContain("replacement-not-a-page");
  });
});

describe("loader corrections", () => {
  it("admits a conformant page whose body cannot be analysed, at any stack depth", () => {
    const deep = `---\ntype: T\ntitle: Deep\ndescription: D\n---\n${">".repeat(5000)} x\n`;
    const run = (depth: number): string[] => {
      if (depth > 0) return run(depth - 1);
      const { report, catalog } = loadBundle("x", [file("deep.md", deep)], options(), NOW);
      expect(report.refusals).toEqual([]);
      expect(catalog.pages.has("deep.md")).toBe(true);
      return report.degradations.filter((d) => d.path === "deep.md").map((d) => d.code);
    };
    expect(run(0)).toContain("body-unanalysed");
    expect(run(2000)).toContain("body-unanalysed");
  });

  it("refuses absolute, empty-segment, parent and backslash paths as path-escape", () => {
    const files = ["/abs.md", "a//b.md", "../escape.md", "C:\\x.md"].map((p) =>
      file(p, "---\ntype: T\n---\n"),
    );
    const { report } = loadBundle(
      "x",
      [...files, file("ok.md", "---\ntype: T\ntitle: Ok\ndescription: D\n---\n")],
      options(),
      NOW,
    );
    expect(report.refusals.map((r) => r.rule)).toEqual([
      "path-escape",
      "path-escape",
      "path-escape",
      "path-escape",
    ]);
    expect(report.admitted).toBe(1);
  });

  it("reports a company index whose entries point at pages that are not served", () => {
    const { report } = loadBundle("b", readFixture("behaviours"), options({ admit: [] }), NOW);
    const d = report.degradations.find(
      (x) => x.code === "index-lists-unserved" && x.path === "terms/index.md",
    );
    expect(d?.detail).toMatch(/8 entr/);
  });

  it("lists a link to a draft page under linksToUnserved", () => {
    const files = [
      file("a.md", "---\ntype: T\ntitle: A\ndescription: D\n---\nSee [b](/b.md).\n"),
      file("b.md", "---\ntype: T\ntitle: B\ndescription: D\nstatus: draft\n---\nBody.\n"),
    ];
    const { report } = loadBundle("x", files, options(), NOW);
    expect(report.linksToUnserved).toEqual([{ from: "a.md", raw: "/b.md", target: "b.md" }]);
  });

  it("makes an unparseable manifest fatal when integrity is required, and accepts a 64-character commit", () => {
    const { report } = loadBundle(
      "x",
      [file("manifest.json", "{not json"), file("a.md", "---\ntype: T\n---\n")],
      options({ integrity: "require-manifest" }),
      NOW,
    );
    expect(report.fatal).toMatchObject({ rule: "manifest-invalid" });
    const sha256 = parseManifest(
      new TextEncoder().encode(
        JSON.stringify({
          okf_catalog: 1,
          commit: "a".repeat(64),
          published_at: "2026-10-06T00:00:00Z",
          files: {},
        }),
      ),
    );
    expect(sha256.ok).toBe(true);
  });

  it("files a body failure under body-unreadable, never under the frontmatter", () => {
    expect(["body-unreadable", "frontmatter-unparseable"]).toContain("body-unreadable");
  });
});

describe("generated indexes survive their own parser", () => {
  it("escapes link text, collapses descriptions and encodes file names, so every page round-trips", () => {
    const pages = [
      {
        path: "notes/my page.md",
        title: "Array] of [T",
        description: "line one\n# not a heading?\nline two",
      },
      { path: "notes/plain.md", title: "Plain", description: "<script>alert(1)</script>" },
    ];
    const body = generateIndex("notes", pages, []);
    const sections = parseIndex(body);
    const entries = sections.flatMap((s) => s.entries);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.title).toBe("Array] of [T");
    expect(entries[0]?.description).toBe("line one # not a heading? line two");
    const index = {
      pages: new Set(pages.map((p) => p.path)),
      reserved: new Set<string>(),
      attachments: new Set<string>(),
      folders: new Set(["", "notes"]),
    };
    for (const entry of entries) {
      expect(resolveLink(entry.href, "notes/index.md", index).kind, entry.href).toBe("page");
    }
    expect(body).not.toContain("<script>");
  });
});
