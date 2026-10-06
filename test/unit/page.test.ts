import { describe, expect, it } from "vitest";
import type { LinkIndex } from "../../src/bundle/links.js";
import type { BundleFile, Page, SpecText } from "../../src/bundle/model.js";
import { decideReplacement, parsePage } from "../../src/bundle/page.js";
import { reservedKind } from "../../src/bundle/reserved.js";
import { readFixture } from "../helpers/fixtures.js";

function indexOf(files: BundleFile[]): LinkIndex {
  const index: LinkIndex = {
    pages: new Set(),
    reserved: new Set(),
    attachments: new Set(),
    folders: new Set([""]),
  };
  for (const f of files) {
    const folder = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "";
    index.folders.add(folder);
    if (reservedKind(f.path)) index.reserved.add(f.path);
    else if (f.path.endsWith(".md")) index.pages.add(f.path);
    else index.attachments.add(f.path);
  }
  return index;
}

const behaviours = readFixture("behaviours");
const linkIndex = indexOf(behaviours);
const refused = readFixture("refused");

function page(
  path: string,
  specText: SpecText = "2026-08-15",
  files: BundleFile[] = behaviours,
): Page {
  const file = files.find((f) => f.path === path);
  if (!file) throw new Error(`${path} missing`);
  const r = parsePage(file, { linkIndex: indexOf(files), specText });
  if (!r.ok) throw new Error(`${path} refused: ${r.refusal.rule} ${r.refusal.detail}`);
  return r.page;
}

function inline(path: string, text: string, specText: SpecText = "2026-08-15") {
  return parsePage({ path, bytes: new TextEncoder().encode(text) }, { linkIndex, specText });
}

const codes = (p: Page): string[] => p.degradations.map((d) => d.code);

describe("parsePage: the fully described page", () => {
  const alpha = page("terms/alpha.md");

  it("takes type, title, description, tags, resource and status from the frontmatter", () => {
    expect(alpha.type).toBe("Term");
    expect(alpha.title).toBe("Alpha");
    expect(alpha.titleSource).toBe("frontmatter");
    expect(alpha.description).toMatch(/^The alpha term/);
    expect(alpha.descriptionSource).toBe("frontmatter");
    expect(alpha.tags).toEqual(["alpha", "glossary"]);
    expect(alpha.resource).toBe("https://example.test/glossary/alpha");
    expect(alpha.status).toBe("stable");
    expect(alpha.statusSource).toBe("frontmatter");
  });

  it("reads the date-form recheck date as the start of that UTC day", () => {
    expect(alpha.staleAfter).toEqual({
      raw: "2999-12-31",
      form: "date",
      at: new Date(Date.UTC(2999, 11, 31)),
    });
  });

  it("reads generated and both verifications, and derives human-reviewed trust", () => {
    expect(alpha.generated).toEqual({
      by: "human:editor",
      at: { raw: "2000-02-01T10:00:00Z", at: new Date(Date.UTC(2000, 1, 1, 10)) },
    });
    expect(alpha.verified.map((v) => v.by)).toEqual(["process:nightly", "human:reviewer"]);
    expect(alpha.trust).toBe("human-reviewed");
  });

  it("reads sources with their credibility signals and the sibling usage window", () => {
    expect(alpha.sources).toEqual([
      {
        id: "alpha-handbook",
        resource: "https://example.test/handbook/alpha",
        title: "The alpha handbook",
        author: "team:docs",
        usageCount: 42,
        lastModified: "2000-01-20",
      },
    ]);
    expect(alpha.usageWindow).toEqual({ from: "2000-01-01", to: "2000-01-31" });
  });

  it("resolves the body's links by kind and keeps footnote references", () => {
    expect(alpha.links).toEqual([
      { raw: "/terms/beta.md", kind: "page", target: "terms/beta.md" },
      { raw: "./gamma.md", kind: "page", target: "terms/gamma.md" },
      { raw: "/terms/missing.md", kind: "broken" },
    ]);
    expect(alpha.footnoteReferences).toEqual(["alpha-handbook"]);
    expect(alpha.degradations).toEqual([]);
    expect(alpha.folder).toBe("terms");
    expect(alpha.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(alpha.frontmatter.type).toBe("Term");
  });
});

describe("parsePage: trust and lifecycle", () => {
  it("derives machine-confirmed trust from a process verifier and reads a datetime recheck instant", () => {
    const beta = page("terms/beta.md");
    expect(beta.trust).toBe("machine-confirmed");
    expect(beta.staleAfter).toEqual({
      raw: "2000-06-01T18:00:00Z",
      form: "datetime",
      at: new Date(Date.UTC(2000, 5, 1, 18)),
    });
    expect(codes(beta)).toEqual(["stale-after-unexpected-form"]);
  });

  it("leaves an unverified page unverified, keeps a generator without a time, and has no recheck date", () => {
    const gamma = page("terms/gamma.md");
    expect(gamma.trust).toBe("unverified");
    expect(gamma.verified).toEqual([]);
    expect(gamma.generated).toEqual({ by: "human:editor" });
    expect(gamma.staleAfter).toBeUndefined();
    expect(gamma.degradations).toEqual([]);
  });

  it("wraps a bare verified mapping into one entry and marks an unreadable recheck date", () => {
    const eta = page("terms/eta.md");
    expect(eta.verified).toEqual([
      {
        by: "human:reviewer",
        at: { raw: "2000-02-02T09:00:00Z", at: new Date(Date.UTC(2000, 1, 2, 9)) },
      },
    ]);
    expect(eta.trust).toBe("human-reviewed");
    expect(eta.staleAfter).toEqual({ raw: "soon", form: "unparseable" });
    expect(codes(eta)).toEqual(["stale-after-unparseable"]);
  });

  it("reads a datetime without an offset as UTC and says so", () => {
    const theta = page("terms/theta.md");
    expect(theta.staleAfter).toEqual({
      raw: "2000-06-01T18:00:00",
      form: "datetime",
      at: new Date(Date.UTC(2000, 5, 1, 18)),
    });
    expect(codes(theta)).toEqual(["stale-after-no-offset", "stale-after-unexpected-form"]);
  });

  it("flags the date form as unexpected under the 21 August text", () => {
    expect(codes(page("terms/zeta.md", "2026-08-21"))).toEqual(["stale-after-unexpected-form"]);
    expect(codes(page("terms/zeta.md", "2026-08-15"))).toEqual([]);
  });

  it("treats an unknown status as draft, keeps the raw value, and reports it", () => {
    const p = page("notes/unknown-status.md");
    expect(p.status).toBe("draft");
    expect(p.statusRaw).toBe("archived");
    expect(codes(p)).toEqual(["status-unknown"]);
  });

  it("defaults an absent status to stable, and reads a draft as written", () => {
    expect(page("notes/no-description.md").statusSource).toBe("default");
    expect(page("notes/draft.md").status).toBe("draft");
  });
});

describe("parsePage: derived title and description", () => {
  it("takes the title from the first heading, else the file name, and says so", () => {
    const heading = page("notes/no-title.md");
    expect(heading.title).toBe("Heading From Body");
    expect(heading.titleSource).toBe("heading");
    expect(codes(heading)).toEqual(["title-from-heading"]);
    const filename = page("notes/no-title-no-heading.md");
    expect(filename.title).toBe("no-title-no-heading");
    expect(filename.titleSource).toBe("filename");
    expect(codes(filename)).toEqual(["title-from-filename"]);
  });

  it("takes the description from the body's first sentence and says so", () => {
    const p = page("notes/no-description.md");
    expect(p.description).toBe("The first sentence of the body stands in for the description.");
    expect(p.descriptionSource).toBe("body");
    expect(codes(p)).toEqual(["description-from-body"]);
  });

  it("reads tags as written and reports markup in a body", () => {
    expect(page("notes/tags-only.md").tags).toEqual(["one", "two", "three-four"]);
    expect(codes(page("notes/html-body.md"))).toEqual(["body-html"]);
  });

  it("preserves a page's own qmd key and reads a page that gives orders like any other", () => {
    expect(page("notes/with-qmd-key.md").frontmatter.qmd).toEqual({
      metadata: { custom: "the page author wrote this" },
    });
    expect(page("notes/injection.md").trust).toBe("human-reviewed");
  });
});

describe("parsePage: refusals and inline variants", () => {
  it("refuses a file with no frontmatter, one with no type, and one whose YAML does not parse", () => {
    const rule = (path: string) => {
      const file = refused.find((f) => f.path === path);
      if (!file) throw new Error(path);
      const r = parsePage(file, { linkIndex: indexOf(refused), specText: "2026-08-15" });
      return r.ok ? "ok" : r.refusal.rule;
    };
    expect(rule("no-frontmatter.md")).toBe("no-frontmatter");
    expect(rule("no-type.md")).toBe("no-type");
    expect(rule("bad-yaml.md")).toBe("frontmatter-unparseable");
    expect(rule("fine.md")).toBe("ok");
  });

  it("refuses an empty mapping as no-type and an invalid byte as not-utf8", () => {
    expect(inline("x.md", "---\n---\nBody\n")).toMatchObject({
      ok: false,
      refusal: { rule: "no-type" },
    });
    const r = parsePage(
      { path: "x.md", bytes: new Uint8Array([0x2d, 0x2d, 0x2d, 0x0a, 0xff]) },
      { linkIndex, specText: "2026-08-15" },
    );
    expect(r).toMatchObject({ ok: false, refusal: { rule: "not-utf8" } });
  });

  it("reads a numeric type as its source text and reports the coercion", () => {
    const r = inline("x.md", "---\ntype: 123\ntitle: T\n---\n");
    expect(r.ok && r.page.type).toBe("123");
    expect(r.ok && codes(r.page)).toContain("scalar-coerced");
  });

  it("drops malformed verified entries with a degradation and keeps the valid ones", () => {
    const r = inline(
      "x.md",
      "---\ntype: T\nverified:\n  - plain string\n  - { at: 2000-01-01T00:00:00Z }\n  - { by: human:ok }\n  - { by: process:x, at: not-a-time }\n---\n",
    );
    if (!r.ok) throw new Error(r.refusal.rule);
    expect(r.page.verified).toEqual([
      { by: "human:ok" },
      { by: "process:x", at: { raw: "not-a-time" } },
    ]);
    expect(codes(r.page).filter((c) => c === "verified-entry-malformed")).toHaveLength(2);
    expect(codes(r.page)).toContain("timestamp-invalid");
    expect(r.page.trust).toBe("human-reviewed");
  });

  it("treats verified given as a string, an empty list or null as malformed, leaving the page unverified", () => {
    for (const value of ["human:x", "[]", "null"]) {
      const r = inline("x.md", `---\ntype: T\nverified: ${value}\n---\n`);
      if (!r.ok) throw new Error(r.refusal.rule);
      expect(r.page.verified, value).toEqual([]);
      expect(r.page.trust, value).toBe("unverified");
    }
    const asString = inline("x.md", "---\ntype: T\nverified: human:x\n---\n");
    expect(asString.ok && codes(asString.page)).toContain("verified-entry-malformed");
  });

  it("reads a lone tag string as one tag and reports it; ignores a generator without by", () => {
    const r = inline(
      "x.md",
      "---\ntype: T\ntitle: T\ndescription: D\ntags: single\ngenerated: { at: 2000-01-01T00:00:00Z }\n---\n",
    );
    if (!r.ok) throw new Error(r.refusal.rule);
    expect(r.page.tags).toEqual(["single"]);
    expect(r.page.generated).toBeUndefined();
    expect(codes(r.page)).toEqual(["tags-not-list", "generated-malformed"]);
  });

  it("reports a footnote reference with no matching source id", () => {
    const r = inline(
      "x.md",
      "---\ntype: T\ntitle: T\ndescription: D\nsources:\n  - { id: a, resource: https://x }\n---\nClaim.[^a] Other.[^b]\n\n[^a]: A\n[^b]: B\n",
    );
    if (!r.ok) throw new Error(r.refusal.rule);
    expect(r.page.degradations).toEqual([
      {
        path: "x.md",
        code: "footnote-without-source",
        field: "sources",
        detail: "footnote b has no matching sources entry",
      },
    ]);
  });

  it("drops a source without a resource and reports it", () => {
    const r = inline("x.md", "---\ntype: T\nsources:\n  - { id: a }\n  - just text\n---\n");
    if (!r.ok) throw new Error(r.refusal.rule);
    expect(r.page.sources).toEqual([]);
    expect(codes(r.page).filter((c) => c === "source-malformed")).toHaveLength(2);
  });
});

describe("decideReplacement", () => {
  const admitted = new Set(["terms/alpha.md", "terms/delta.md", "terms/epsilon.md"]);

  it("names the first body link when it resolves to another admitted page", () => {
    expect(decideReplacement(page("terms/delta.md"), admitted)).toEqual({
      replacement: "terms/alpha.md",
    });
  });

  it("reports why when there is no usable link", () => {
    expect(decideReplacement(page("terms/epsilon.md"), admitted)).toMatchObject({
      degradation: { code: "replacement-missing" },
    });
    const notServed = decideReplacement(page("terms/delta.md"), new Set(["terms/delta.md"]));
    expect(notServed).toMatchObject({ degradation: { code: "replacement-not-served" } });
    const external = inline(
      "d.md",
      "---\ntype: T\nstatus: deprecated\n---\nSee [x](https://example.test) and [alpha](/terms/alpha.md).\n",
    );
    expect(external.ok && decideReplacement(external.page, admitted)).toMatchObject({
      degradation: { code: "replacement-external" },
    });
    const self = inline(
      "terms/epsilon.md",
      "---\ntype: T\nstatus: deprecated\n---\nSee [me](/terms/epsilon.md).\n",
    );
    expect(self.ok && decideReplacement(self.page, admitted)).toMatchObject({
      degradation: { code: "replacement-self" },
    });
    const broken = inline(
      "d.md",
      "---\ntype: T\nstatus: deprecated\n---\nSee [gone](/terms/gone.md).\n",
    );
    expect(broken.ok && decideReplacement(broken.page, admitted)).toMatchObject({
      degradation: { code: "replacement-broken" },
    });
  });

  it("skips a same-page anchor before deciding, and does nothing for a page that is not deprecated", () => {
    const anchored = inline(
      "d.md",
      "---\ntype: T\nstatus: deprecated\n---\nSee [below](#legacy) then [alpha](/terms/alpha.md).\n",
    );
    expect(anchored.ok && decideReplacement(anchored.page, admitted)).toEqual({
      replacement: "terms/alpha.md",
    });
    expect(decideReplacement(page("terms/alpha.md"), admitted)).toEqual({});
  });
});
