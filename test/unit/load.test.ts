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

describe("loadBundle on the specification's example bundle", () => {
  const { catalog, report } = loadBundle("acme", readFixture("spec-example"), options(), NOW);

  it("admits the nine pages, serves eight reserved files, counts two attachments, refuses nothing", () => {
    expect(report.fatal).toBeUndefined();
    expect(report.refusals).toEqual([]);
    expect(report.admitted).toBe(9);
    expect(report.excludedByStatus).toBe(0);
    expect(report.attachments).toBe(2);
    expect(report.hidden).toBe(0);
    expect(catalog.pages.size).toBe(9);
    expect(catalog.company).toBe("acme");
    expect(catalog.commit).toBe("0000000000000000000000000000000000000000");
  });

  it("keeps the company's own index files, with the log at the root", () => {
    expect([...catalog.folders.keys()].sort()).toEqual([
      "",
      "attesters",
      "computations",
      "metrics",
      "policies",
      "skills",
      "tables",
    ]);
    expect(catalog.folders.get("")?.indexSource).toBe("file");
    expect(catalog.folders.get("")?.log?.frontmatter).toEqual({
      type: "Log",
      title: "Acme Retail bundle history",
    });
    expect(report.foldersWithoutIndex).toEqual([]);
    expect(report.unknownTypes).toEqual([]);
  });

  it("resolves every body link and names the deprecated page's replacement", () => {
    expect(report.brokenLinks).toEqual([]);
    expect(catalog.pages.get("metrics/gross-margin-legacy.md")?.replacement).toBe(
      "metrics/gross-margin.md",
    );
    expect(catalog.pages.get("metrics/gross-margin-legacy.md")?.status).toBe("deprecated");
  });

  it("classifies the path fields of admitted pages and maps inbound mentions and derivations (D69)", () => {
    const ytd = catalog.pages.get("computations/revenue-ytd.md");
    expect(ytd?.pathEdges.map((e) => [e.field, e.kind, e.target, e.fromRoot])).toEqual([
      ["sources[0].resource", "concept", "policies/revenue-recognition.md", true],
      ["sources[1].resource", "concept", "tables/orders.md", true],
      ["executor.resource", "concept", "skills/run-on-bq.md", true],
      ["attester.resource", "attachment", "attesters/sql_equality.py", true],
    ]);
    // Five pages write their path fields from the root without a leading slash: one report each.
    expect(
      report.degradations
        .filter((d) => d.code === "path-field-root-relative")
        .map((d) => [d.path, d.field]),
    ).toEqual([
      ["computations/gross-margin-period.md", "sources[0].resource"],
      ["computations/revenue-ytd.md", "sources[0].resource"],
      ["metrics/gross-margin.md", "sources[0].resource"],
      ["metrics/revenue.md", "sources[0].resource"],
      ["tables/orders.md", "sources[1].resource"],
    ]);
    // The revenue policy is a source of both computations, both live metrics pages and the orders table.
    const derivations = catalog.graph.inboundDerivations.get("policies/revenue-recognition.md");
    expect(derivations?.map((d) => [d.from, d.edge.field])).toEqual([
      ["computations/gross-margin-period.md", "sources[1].resource"],
      ["computations/revenue-ytd.md", "sources[0].resource"],
      ["metrics/gross-margin.md", "sources[1].resource"],
      ["metrics/revenue.md", "sources[0].resource"],
      ["tables/orders.md", "sources[1].resource"],
    ]);
    // A contract field names a page without deriving from it.
    expect(catalog.graph.inboundDerivations.has("skills/run-on-bq.md")).toBe(false);
    expect(
      catalog.graph.inboundMentions
        .get("metrics/gross-margin.md")
        ?.map((m) => [m.from, m.link.raw]),
    ).toEqual([
      ["metrics/gross-margin-legacy.md", "./gross-margin.md"],
      ["policies/margin-standard.md", "/metrics/gross-margin.md"],
      ["policies/revenue-recognition.md", "/metrics/gross-margin.md"],
    ]);
  });

  it("checks every folder index's page links against the folder's pages", () => {
    for (const [folder, entry] of catalog.folders) {
      if (entry.indexSource !== "file" || entry.index === undefined) continue;
      const linked = entry.index.body.match(/\]\(([^)]+)\)/g)?.map((m) => m.slice(2, -1)) ?? [];
      const pageLinks = linked
        .filter((l) => l.endsWith(".md") && !l.endsWith("index.md"))
        .map((l) => (folder === "" ? l : `${folder}/${l}`));
      expect(pageLinks.sort(), folder).toEqual([...entry.pages].sort());
    }
  });
});

describe("loadBundle on the behaviours bundle", () => {
  const files = readFixture("behaviours");
  const { catalog, report } = loadBundle(
    "behaviours",
    files,
    options({ types: ["Term", "Note"] }),
    NOW,
  );

  it("admits seventeen of nineteen pages, excluding the draft and the unknown status, and reports the latter", () => {
    expect(report.fatal).toBeUndefined();
    expect(report.refusals).toEqual([]);
    expect(report.admitted).toBe(17);
    expect(report.excludedByStatus).toBe(2);
    expect(report.unknownStatuses).toEqual([
      { path: "notes/unknown-status.md", value: "archived" },
    ]);
    expect(catalog.pages.has("notes/draft.md")).toBe(false);
    expect(catalog.pages.has("notes/unknown-status.md")).toBe(false);
  });

  it("reports the undeclared type, the broken link, and the folders without an index", () => {
    expect(report.unknownTypes).toEqual(["Widget"]);
    expect(report.brokenLinks).toEqual([{ from: "terms/alpha.md", raw: "/terms/missing.md" }]);
    expect(report.foldersWithoutIndex).toEqual(["dist", "notes"]);
    expect(report.attachments).toBe(1);
  });

  it("decides replacements after admission and reports the deprecated page without one", () => {
    expect(catalog.pages.get("terms/delta.md")?.replacement).toBe("terms/alpha.md");
    expect(catalog.pages.get("terms/epsilon.md")?.replacement).toBeUndefined();
    expect(
      report.degradations.filter((d) => d.code === "replacement-missing").map((d) => d.path),
    ).toEqual(["terms/epsilon.md"]);
  });

  it("generates an index for a folder that has none and keeps the one the company wrote", () => {
    expect(catalog.folders.get("terms")?.indexSource).toBe("file");
    expect(catalog.folders.get("notes")?.indexSource).toBe("generated");
    expect(catalog.folders.get("notes")?.index?.body).toContain(
      "* [Tags only](tags-only.md) - A page whose tags are the thing under test.",
    );
    expect(catalog.folders.get("")?.subfolders.sort()).toEqual(["dist", "notes", "terms"]);
    expect(catalog.okfVersion).toBe("0.2");
  });

  it("admits the draft and the unknown status under the development flag", () => {
    const dev = loadBundle("behaviours", files, options({ dev: true, integrity: "none" }), NOW);
    expect(dev.report.admitted).toBe(19);
    expect(dev.catalog.pages.get("notes/unknown-status.md")?.status).toBe("archived");
    expect(dev.catalog.pages.get("notes/draft.md")?.status).toBe("draft");
  });

  it("admits an unknown status the company lists, and its generated index lists it", () => {
    const listed = loadBundle(
      "behaviours",
      files,
      options({ admit: ["stable", "deprecated", "Archived"], types: ["Term", "Note"] }),
      NOW,
    );
    expect(listed.report.admitted).toBe(18);
    expect(listed.report.excludedByStatus).toBe(1);
    expect(listed.catalog.pages.get("notes/unknown-status.md")?.status).toBe("archived");
    expect(listed.catalog.pages.has("notes/draft.md")).toBe(false);
    expect(listed.report.unknownStatuses).toEqual([
      { path: "notes/unknown-status.md", value: "archived" },
    ]);
    const notes = listed.catalog.folders.get("notes");
    expect(notes?.indexSource).toBe("generated");
    expect(notes?.index?.body).toContain("(unknown-status.md)");
    expect(notes?.index?.body).not.toContain("(draft.md)");
  });

  it("reports degradations for admitted pages only, and lists every type", () => {
    expect(
      report.degradations.every((d) => catalog.pages.has(d.path) || d.path.endsWith("index.md")),
    ).toBe(true);
    expect([...catalog.byType.keys()].sort()).toEqual(["Note", "Term", "Widget"]);
  });
});

describe("loadBundle: admitted words that match no page (D77, build review A-E1)", () => {
  it("reports each admitted word outside the three known statuses that no page carries, once, as written", () => {
    const { report } = loadBundle(
      "b",
      readFixture("behaviours"),
      options({
        admit: ["stable", " depreciated ", "Archived", "deprecated", "DEPRECIATED", "obsolete"],
      }),
      NOW,
    );
    // Archived is carried by notes/unknown-status.md, in any case; the known words are never typos.
    expect(report.unmatchedAdmits).toEqual(["depreciated", "obsolete"]);
    // A bundle with no deprecated page says nothing of deprecated, which the default list names.
    const plain = loadBundle(
      "x",
      readFixture("no-manifest"),
      options({ integrity: "none" }),
      NOW,
    ).report;
    expect(plain.unmatchedAdmits).toEqual([]);
    // A refused bundle's pages were never read: nothing is said of its words.
    const refused = loadBundle(
      "x",
      readFixture("no-manifest"),
      options({ admit: ["stable", "depreciated"] }),
      NOW,
    ).report;
    expect(refused.fatal).toBeDefined();
    expect(refused.unmatchedAdmits).toEqual([]);
  });
});

// The readiness ledger (issue 2's "Holds", D59, row 31): an unknown okf_version degrades, it never refuses.
describe("loadBundle: the readiness ledger (D59)", () => {
  it("serves a bundle whose root index declares an unknown okf_version", () => {
    const files = readFixture("behaviours").map((f) =>
      f.path === "index.md"
        ? {
            path: f.path,
            bytes: Buffer.from(Buffer.from(f.bytes).toString("utf8").replace('"0.2"', '"9.9"')),
          }
        : f,
    );
    const { catalog, report } = loadBundle("b", files, options({ integrity: "none" }), NOW);
    expect(report.fatal).toBeUndefined();
    expect(report.refusals).toEqual([]);
    expect(report.admitted).toBe(17);
    expect(catalog.okfVersion).toBe("9.9");
    expect(
      report.degradations.filter((d) => d.code === "okf-version-unknown").map((d) => d.path),
    ).toEqual(["index.md"]);
    expect(catalog.folders.get("")?.indexSource).toBe("file");
  });
});

describe("loadBundle on the refusal bundles", () => {
  it("refuses the three bad pages and the engine folder per path, and still serves the fine page", () => {
    const { catalog, report } = loadBundle("refused", readFixture("refused"), options(), NOW);
    expect(report.fatal).toBeUndefined();
    expect(report.refusals.map((r) => [r.path, r.rule]).sort()).toEqual([
      [".qmd/index.yml", "engine-config"],
      ["bad-yaml.md", "frontmatter-unparseable"],
      ["no-frontmatter.md", "no-frontmatter"],
      ["no-type.md", "no-type"],
    ]);
    expect(report.admitted).toBe(1);
    expect(catalog.pages.has("fine.md")).toBe(true);
  });

  it("makes a missing manifest fatal when integrity is required, and loads normally when it is not", () => {
    const required = loadBundle("x", readFixture("no-manifest"), options(), NOW);
    expect(required.report.fatal).toMatchObject({ rule: "manifest-missing" });
    expect(required.report.admitted).toBe(0);
    const relaxed = loadBundle(
      "x",
      readFixture("no-manifest"),
      options({ integrity: "none" }),
      NOW,
    );
    expect(relaxed.report.fatal).toBeUndefined();
    expect(relaxed.report.admitted).toBe(1);
  });

  it("refuses a tampered file and reports a listed file that is missing, without taking the bundle down", () => {
    const files = readFixture("behaviours").map((f) =>
      f.path === "terms/zeta.md"
        ? { path: f.path, bytes: new TextEncoder().encode("---\ntype: Term\ntitle: Z\n---\n") }
        : f,
    );
    const { report } = loadBundle(
      "behaviours",
      files.filter((f) => f.path !== "terms/eta.md"),
      options(),
      NOW,
    );
    expect(report.fatal).toBeUndefined();
    expect(report.refusals).toEqual([
      { path: "terms/zeta.md", rule: "size-mismatch", detail: expect.any(String) },
    ]);
    expect(report.missingOnDisk).toEqual(["terms/eta.md"]);
  });

  it("carries the walker's refusals into the report and counts hidden files", () => {
    const files = [
      ...readFixture("no-manifest"),
      { path: ".github/x.md", bytes: new Uint8Array(0) },
    ];
    const { report } = loadBundle(
      "x",
      files,
      options({
        integrity: "none",
        walkRefusals: [{ path: "evil", rule: "symlink", detail: "is a symbolic link" }],
      }),
      NOW,
    );
    expect(report.refusals).toEqual([
      { path: "evil", rule: "symlink", detail: "is a symbolic link" },
    ]);
    expect(report.hidden).toBe(1);
  });
});

describe("loadBundle: review round 1 additions", () => {
  const file = (path: string, text: string) => ({ path, bytes: new TextEncoder().encode(text) });
  const pageText = (title: string) =>
    `---\ntype: Note\ntitle: ${title}\ndescription: D\n---\n# ${title}\n\nBody.\n`;

  it("links a nested subfolder from a generated parent index by its relative name", () => {
    const files = [file("a/one.md", pageText("One")), file("a/b/two.md", pageText("Two"))];
    const { catalog, report } = loadBundle("x", files, options({ integrity: "none" }), NOW);
    expect(catalog.folders.get("a")?.subfolders).toEqual(["a/b"]);
    expect(catalog.folders.get("a")?.index?.body).toContain("* [b](b/)");
    expect(catalog.folders.get("a")?.index?.body).not.toContain("a/b/");
    expect(report.foldersWithoutIndex).toEqual(["", "a", "a/b"]);
  });

  it("does not list excluded pages in a generated index", () => {
    const { catalog } = loadBundle("behaviours", readFixture("behaviours"), options(), NOW);
    const notes = catalog.folders.get("notes")?.index?.body ?? "";
    expect(notes).not.toContain("draft.md");
    expect(notes).not.toContain("unknown-status.md");
  });

  it("reports nothing as missing on disk for the refused bundle, whose engine folder is on disk", () => {
    const { report } = loadBundle("refused", readFixture("refused"), options(), NOW);
    expect(report.missingOnDisk).toEqual([]);
  });

  it("does not count a refused attachment, and counts hidden and engine files toward the caps", () => {
    const big = "x".repeat(500);
    const files = [
      ...readFixture("no-manifest"),
      file("ref/big.bin", big),
      file(".hidden/a.md", big),
      file(".qmd/index.yml", big),
    ];
    const { report } = loadBundle(
      "x",
      files,
      options({ integrity: "none", caps: { fileBytes: 400, files: 100, treeBytes: 1_000_000 } }),
      NOW,
    );
    expect(report.attachments).toBe(0);
    expect(report.refusals.map((r) => [r.path, r.rule]).sort()).toEqual([
      [".hidden/a.md", "oversize"],
      [".qmd/index.yml", "engine-config"],
      [".qmd/index.yml", "oversize"],
      ["ref/big.bin", "oversize"],
    ]);
    const tooMany = loadBundle(
      "x",
      files,
      options({ integrity: "none", caps: { fileBytes: 1000, files: 2, treeBytes: 1_000_000 } }),
      NOW,
    );
    expect(tooMany.report.fatal).toMatchObject({ rule: "too-many-files" });
  });

  it("does not parse a reserved file the manifest refuses, and generates the index instead", () => {
    const files = readFixture("behaviours").map((f) =>
      f.path === "terms/index.md" ? file(f.path, "# Tampered\n") : f,
    );
    const { catalog, report } = loadBundle("behaviours", files, options(), NOW);
    expect(report.refusals.map((r) => r.path)).toEqual(["terms/index.md"]);
    expect(catalog.folders.get("terms")?.indexSource).toBe("generated");
  });

  it("says in the report whether integrity was checked or skipped", () => {
    expect(loadBundle("b", readFixture("behaviours"), options(), NOW).report.integrity).toBe(
      "checked",
    );
    expect(
      loadBundle("b", readFixture("behaviours"), options({ integrity: "none" }), NOW).report
        .integrity,
    ).toBe("skipped");
  });
});

describe("loadBundle: path fields naming a held draft (bite b's build reviews B-I-B1, L1)", () => {
  it("classifies a source naming a draft as unserved at load, without development mode", () => {
    const files = {
      "a.md":
        "---\ntype: Note\ntitle: A\nsources:\n  - { resource: drafts/plan.md }\n  - { resource: b.md }\n---\n\nA.\n",
      "b.md": "---\ntype: Note\ntitle: B\n---\n\nB.\n",
      "drafts/plan.md": "---\ntype: Note\ntitle: Plan\nstatus: draft\n---\n\nPlan.\n",
    };
    const { catalog, report } = loadBundle(
      "b",
      Object.entries(files).map(([path, text]) => ({ path, bytes: Buffer.from(text) })),
      options({ integrity: "none" }),
      NOW,
    );
    expect(report.excludedByStatus).toBe(1);
    expect(catalog.pages.has("drafts/plan.md")).toBe(false);
    expect(catalog.pages.get("a.md")?.pathEdges.map((e) => [e.kind, e.target])).toEqual([
      ["unserved", "drafts/plan.md"],
      ["concept", "b.md"],
    ]);
    // An unserved edge derives nothing: only the served page has an inbound derivation.
    expect([...catalog.graph.inboundDerivations.keys()]).toEqual(["b.md"]);
  });
});
