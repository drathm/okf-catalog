import { describe, expect, it } from "vitest";
import type { LinkIndex } from "../../src/bundle/links.js";
import type { BundleFile, Page, SpecText } from "../../src/bundle/model.js";
import { decideReplacement, parsePage } from "../../src/bundle/page.js";
import { reservedKind } from "../../src/bundle/reserved.js";
import { APPENDIX_A_V01 } from "../helpers/appendix-a.js";
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
      {
        raw: "/terms/beta.md",
        kind: "page",
        target: "terms/beta.md",
        text: "beta",
        heading: "Alpha",
      },
      {
        raw: "./gamma.md",
        kind: "page",
        target: "terms/gamma.md",
        text: "gamma",
        heading: "Alpha",
      },
      { raw: "/terms/missing.md", kind: "broken", text: "missing", heading: "Alpha" },
    ]);
    expect(alpha.footnoteReferences).toEqual([
      {
        id: "alpha-handbook",
        block:
          "Alpha is the first term. It links to beta by a bundle-absolute path, to gamma by a relative path, and to a page that does not exist: missing.",
        heading: "Alpha",
      },
    ]);
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

  it("keeps an unknown status as written, trimmed, case kept, and reports it", () => {
    const p = page("notes/unknown-status.md");
    expect(p.status).toBe("archived");
    expect(p.statusRaw).toBe("archived");
    expect(codes(p)).toEqual(["status-unknown"]);
    const status = (line: string): Page => {
      const r = inline("x.md", `---\ntype: T\ntitle: T\ndescription: D\n${line}\n---\n`);
      if (!r.ok) throw new Error(`${line}: ${r.refusal.rule}`);
      return r.page;
    };
    const review = status('status: " In Review "');
    expect(review.status).toBe("In Review");
    expect(review.statusRaw).toBe(" In Review ");
    expect(codes(review)).toEqual(["status-unknown"]);
    // The three known values are read without regard to case, and kept as the specification spells them.
    const known = status("status: Stable");
    expect(known.status).toBe("stable");
    expect(known.statusRaw).toBe("Stable");
    expect(codes(known)).toEqual([]);
    expect(status("status: ' DEPRECATED '").status).toBe("deprecated");
    // A list or a mapping is no word: its JSON text stands in for one, and it counts as unknown.
    const list = status("status: [a, b]");
    expect(list.status).toBe('["a","b"]');
    expect(codes(list)).toEqual(["status-unknown"]);
    const mapping = status("status: { a: 1 }");
    expect(mapping.status).toBe('{"a":1}');
    expect(codes(mapping)).toEqual(["status-unknown"]);
    // A number or a boolean is read as written.
    expect(status("status: 2").status).toBe("2");
    expect(status("status: True").status).toBe("True");
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

  it("leaves the page unverified for a string, an empty list or null, reporting the string as malformed", () => {
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

describe("parsePage: review round 1 additions", () => {
  it("matches footnote ids to source ids without regard to case", () => {
    const r = inline(
      "x.md",
      "---\ntype: T\ntitle: T\ndescription: D\nsources:\n  - { id: Alpha-Handbook, resource: https://x }\n---\nClaim.[^Alpha-Handbook]\n\n[^Alpha-Handbook]: A\n",
    );
    if (!r.ok) throw new Error(r.refusal.rule);
    expect(r.page.degradations).toEqual([]);
  });

  it("under the 21 August text, the offset-less recheck datetime is reported for the offset only", () => {
    expect(codes(page("terms/theta.md", "2026-08-21"))).toEqual(["stale-after-no-offset"]);
  });

  it("words the unknown-status detail without a claim about admission", () => {
    const p = page("notes/unknown-status.md");
    expect(p.degradations[0]?.detail).not.toMatch(/not served/);
  });
});

describe("parsePage: prose (bite 4)", () => {
  it("stores the body's prose on the page for snippets", () => {
    const result = parsePage(
      {
        path: "p.md",
        bytes: Buffer.from(
          "---\ntype: Note\ntitle: P\n---\n\nOne sentence here.\n\nAnother one.\n",
        ),
      },
      { linkIndex, specText: "2026-08-15" },
    );
    expect(result.ok && result.page.prose).toBe("One sentence here. Another one.");
  });
});

// The readiness ledger (issue 2's "Holds", D59): sentences no test asserted before 0.2.0.
describe("parsePage: the readiness ledger (D59)", () => {
  it("refuses a type that is empty, a list or a mapping; reads a boolean type as its source text", () => {
    const rule = (line: string): string => {
      const r = inline("x.md", `---\n${line}\ntitle: T\n---\n`);
      return r.ok ? `ok: ${r.page.type}` : `${r.refusal.rule}: ${r.refusal.detail}`;
    };
    expect(rule('type: ""')).toBe("no-type: type is empty");
    expect(rule("type: '   '")).toBe("no-type: type is empty");
    expect(rule("type:")).toBe("no-type: type is empty, not text");
    expect(rule("type: [Term, Note]")).toBe("no-type: type is a list, not text");
    expect(rule("type: { name: Term }")).toBe("no-type: type is a mapping, not text");
    for (const [line, written] of [
      ["type: true", "true"],
      ["type: False", "False"],
    ] as const) {
      const r = inline("x.md", `---\n${line}\ntitle: T\n---\n`);
      if (!r.ok) throw new Error(`${line}: ${r.refusal.rule}`);
      expect(r.page.type, line).toBe(written);
      expect(r.page.degradations, line).toContainEqual({
        path: "x.md",
        code: "scalar-coerced",
        field: "type",
        detail: `type is a boolean, read as "${written}"`,
      });
    }
  });

  it("reads an absent, null or blank status as stable", () => {
    for (const line of ["", "status:", "status: null", "status: ''", "status: '   '"]) {
      const r = inline("x.md", `---\ntype: T\ntitle: T\n${line}\n---\n`);
      if (!r.ok) throw new Error(`${line}: ${r.refusal.rule}`);
      expect(r.page.status, line).toBe("stable");
      expect(r.page.statusSource, line).toBe("default");
      expect(codes(r.page), line).not.toContain("status-unknown");
    }
  });

  it("derives human-reviewed from a trimmed human: actor, case-sensitively, and names the latest verifier of any actor", () => {
    const parse = (verified: string): Page => {
      const r = inline("x.md", `---\ntype: T\ntitle: T\nverified:\n${verified}\n---\n`);
      if (!r.ok) throw new Error(r.refusal.rule);
      return r.page;
    };
    const padded = parse("  - { by: '  human:alice  ', at: 2026-01-01T00:00:00Z }");
    expect(padded.verified[0]?.by).toBe("human:alice");
    expect(padded.trust).toBe("human-reviewed");
    // The prefix is matched as written: `Human:` is another actor, so the page is machine-confirmed.
    const capital = parse("  - { by: 'Human:x', at: 2026-01-01T00:00:00Z }");
    expect(capital.trust).toBe("machine-confirmed");
    // A human verified first and a process later: the tier is the human's, the latest verification the process's.
    const mixed = parse(
      "  - { by: human:alice, at: 2026-01-01T00:00:00Z }\n  - { by: process:nightly, at: 2026-06-01T00:00:00Z }",
    );
    expect(mixed.trust).toBe("human-reviewed");
    expect(mixed.latestVerification?.by).toBe("process:nightly");
  });
});

// R2 and R3 (D62): the contract fields typed, the page window typed; malformed values degrade, never refuse.
describe("parsePage: the contract fields and the page window (R2, R3)", () => {
  const spec = readFixture("spec-example");

  it("types the contract of the specification's attested computation", () => {
    const revenue = page("computations/revenue-ytd.md", "2026-08-15", spec);
    expect(revenue.contract).toEqual({
      runtime: "bigquery",
      parameters: [{ name: "year", type: "integer", required: true }],
      executor: {
        resource: "skills/run-on-bq.md",
        receipt: ["job_id", "executed_sql", "result"],
      },
      attester: { resource: "attesters/sql_equality.py" },
    });
    expect(codes(revenue)).not.toContain("field-ignored");
    // A page of any type carries the fields it has; one without any carries no contract.
    const r = inline(
      "x.md",
      "---\ntype: Metric\ntitle: T\ndescription: D\ncomputation: lib/revenue.sql\n---\n",
    );
    if (!r.ok) throw new Error(r.refusal.rule);
    expect(r.page.contract).toEqual({ computation: "lib/revenue.sql" });
    expect(page("terms/alpha.md").contract).toBeUndefined();
  });

  it("drops malformed contract values with a degradation, never the page", () => {
    const cases: Array<[string, Page["contract"]]> = [
      ["parameters: x", undefined],
      [
        "parameters:\n  - { type: integer }\n  - { name: year, type: integer, required: true }",
        { parameters: [{ name: "year", type: "integer", required: true }] },
      ],
      ["executor: text", undefined],
      ["attester: { resource: 3 }", undefined],
      ["runtime: [bigquery, dbt]", undefined],
      // A parameter whose name is blank has no name (build review A-B7).
      ['parameters:\n  - { name: "  ", type: integer }', { parameters: [] }],
      // A mapping with none of the keys the specification gives it is reported too (build review I-A3).
      ["attester: { path: attesters/check.py }", undefined],
      ["attester: {}", undefined],
      ["executor: { resources: run.md }", undefined],
      ["executor: {}", undefined],
    ];
    for (const [yaml, contract] of cases) {
      const r = inline("x.md", `---\ntype: T\ntitle: T\ndescription: D\n${yaml}\n---\n`);
      if (!r.ok) throw new Error(`${yaml}: refused ${r.refusal.rule}`);
      expect(r.page.contract, yaml).toEqual(contract);
      expect(
        r.page.degradations.filter((d) => d.code === "field-ignored"),
        yaml,
      ).toHaveLength(1);
    }
  });

  it("reports a page usage_window that is not a from-to mapping", () => {
    for (const yaml of [
      "usage_window: 2026",
      "usage_window: { from: 2026-01-01 }",
      "usage_window: [a, b]",
    ]) {
      const r = inline("x.md", `---\ntype: T\ntitle: T\ndescription: D\n${yaml}\n---\n`);
      if (!r.ok) throw new Error(`${yaml}: refused ${r.refusal.rule}`);
      expect(r.page.usageWindow, yaml).toBeUndefined();
      expect(r.page.degradations, yaml).toEqual([
        expect.objectContaining({ code: "field-ignored", field: "usage_window" }),
      ]);
    }
    expect(page("terms/alpha.md").usageWindow).toEqual({ from: "2000-01-01", to: "2000-01-31" });
  });

  it("reports a source's own usage_window that is not a from-to mapping, and the source takes no window (build review I-A1, A-A5)", () => {
    const withSourceWindow = (value: string) =>
      inline(
        "x.md",
        `---\ntype: T\ntitle: T\ndescription: D\nusage_window: { from: 2026-06-01, to: 2026-06-30 }\nsources:\n  - resource: https://x.test/own\n    usage_count: 7\n    usage_window: ${value}\n  - resource: https://x.test/none\n    usage_count: 3\n---\n`,
      );
    for (const value of ["{ from: 2025-01-01 }", "2025", "[a, b]", "{ from: 1, to: 2 }"]) {
      const r = withSourceWindow(value);
      if (!r.ok) throw new Error(`${value}: refused ${r.refusal.rule}`);
      // The source wrote a window of its own: its count is not framed by the page's, which it did not ask for.
      expect(r.page.sources, value).toEqual([
        { resource: "https://x.test/own", usageCount: 7, usageWindowIgnored: true },
        { resource: "https://x.test/none", usageCount: 3 },
      ]);
      expect(r.page.degradations, value).toEqual([
        expect.objectContaining({
          code: "source-malformed",
          field: "sources",
          detail: expect.stringContaining("sources[0].usage_window"),
        }),
      ]);
    }
    // A well-formed own window is kept; a key with no value is no window, and inherits as before.
    const own = withSourceWindow("{ from: 2025-01-01, to: 2025-12-31 }");
    if (!own.ok) throw new Error(own.refusal.rule);
    expect(own.page.sources[0]).toEqual({
      resource: "https://x.test/own",
      usageCount: 7,
      usageWindow: { from: "2025-01-01", to: "2025-12-31" },
    });
    expect(own.page.degradations).toEqual([]);
    const none = withSourceWindow("null");
    if (!none.ok) throw new Error(none.refusal.rule);
    expect(none.page.sources[0]).toEqual({ resource: "https://x.test/own", usageCount: 7 });
    expect(none.page.degradations).toEqual([]);
  });
});

// R4, R5, R6: a usage count that is not a number, and the two OKF 0.1 fallbacks (§13.1; D63, D79).
describe("parsePage: usage counts and the OKF 0.1 fallbacks (R4, R5, R6)", () => {
  const parsed = (text: string): Page => {
    const r = inline("metrics/income-statement.md", text);
    if (!r.ok) throw new Error(r.refusal.rule);
    return r.page;
  };

  it("reports a usage_count that is not a number and keeps the source", () => {
    for (const value of ['"12"', "[1]", "{ n: 1 }", "true"]) {
      const p = parsed(
        `---\ntype: T\ntitle: T\ndescription: D\nsources:\n  - { resource: https://x.test/a, usage_count: ${value} }\n---\n`,
      );
      expect(p.sources, value).toEqual([{ resource: "https://x.test/a" }]);
      expect(p.degradations, value).toEqual([
        expect.objectContaining({
          code: "source-malformed",
          field: "sources",
          detail: expect.stringContaining("sources[0].usage_count is"),
        }),
      ]);
    }
    const counted = parsed(
      "---\ntype: T\ntitle: T\ndescription: D\nsources:\n  - { resource: https://x.test/a, usage_count: 7 }\n---\n",
    );
    expect(counted.sources).toEqual([{ resource: "https://x.test/a", usageCount: 7 }]);
    expect(counted.degradations).toEqual([]);
  });

  it("keeps an OKF 0.1 timestamp as its own field only when generated is absent", () => {
    const legacy = parsed(APPENDIX_A_V01);
    expect(legacy.timestamp).toEqual({
      raw: "2026-05-28T22:53:05+00:00",
      at: new Date("2026-05-28T22:53:05Z"),
    });
    expect(legacy.generated).toBeUndefined();
    expect(codes(legacy)).toContain("legacy-timestamp");
    const both = parsed(
      APPENDIX_A_V01.replace(
        "timestamp:",
        "generated: { by: human:x, at: 2026-06-01T00:00:00Z }\ntimestamp:",
      ),
    );
    expect(both.timestamp).toBeUndefined();
    expect(both.generated?.by).toBe("human:x");
    expect(codes(both)).not.toContain("legacy-timestamp");
    const unreadable = parsed("---\ntype: T\ntitle: T\ndescription: D\ntimestamp: soon\n---\n");
    expect(unreadable.timestamp).toEqual({ raw: "soon" });
    expect(codes(unreadable)).toEqual(["timestamp-invalid", "legacy-timestamp"]);
  });

  it("reads a level-one # Citations list as sources only on a page with no generated, verified or sources", () => {
    const legacy = parsed(APPENDIX_A_V01);
    expect(legacy.sources).toEqual([
      { resource: "https://wiki.acme/finance/fpa-handbook" },
      { resource: "https://wiki.acme/finance/revenue-recognition" },
      { resource: "https://wiki.acme/finance/cost-allocation" },
    ]);
    expect(codes(legacy)).toContain("legacy-citations");
    const linked = parsed(
      "---\ntype: T\ntitle: T\ndescription: D\n---\n\n# Citations\n- [Policy](https://x.test/p)\n- plain words\n",
    );
    expect(linked.sources).toEqual([
      { resource: "https://x.test/p", title: "Policy" },
      { resource: "plain words" },
    ]);
    // Beside any of the three v0.2 keys, or under a lower heading, the list is body text only.
    for (const key of [
      "generated: { by: human:x }",
      "verified: { by: human:x, at: 2026-01-01T00:00:00Z }",
      "sources: []",
    ]) {
      const v02 = parsed(APPENDIX_A_V01.replace("timestamp:", `${key}\ntimestamp:`));
      expect(v02.sources, key).toEqual([]);
      expect(codes(v02), key).not.toContain("legacy-citations");
    }
    const subsection = parsed(
      "---\ntype: T\ntitle: T\ndescription: D\n---\n\n# Notes\n\n## Citations\n- https://x.test/a\n",
    );
    expect(subsection.sources).toEqual([]);
    expect(codes(subsection)).not.toContain("legacy-citations");
  });

  it("cuts each legacy citation item at 500 characters and says how many were cut (build review I-E2)", () => {
    const words = "w".repeat(800);
    const url = `https://x.test/${"u".repeat(700)}`;
    const cut = parsed(
      `---\ntype: T\ntitle: T\ndescription: D\n---\n\n# Citations\n- ${words}\n- [${"t".repeat(600)}](${url})\n- short\n`,
    );
    expect(cut.sources).toEqual([
      { resource: `${"w".repeat(500)}…` },
      { resource: `${url.slice(0, 500)}…`, title: `${"t".repeat(500)}…` },
      { resource: "short" },
    ]);
    expect(cut.degradations).toEqual([
      expect.objectContaining({
        code: "legacy-citations",
        detail: expect.stringContaining("2 cut at 500 characters"),
      }),
    ]);
    // An item of exactly 500 characters is whole.
    const whole = parsed(
      `---\ntype: T\ntitle: T\ndescription: D\n---\n\n# Citations\n- ${"w".repeat(500)}\n`,
    );
    expect(whole.sources).toEqual([{ resource: "w".repeat(500) }]);
    expect(whole.degradations[0]?.detail).not.toContain("cut");
  });
});
