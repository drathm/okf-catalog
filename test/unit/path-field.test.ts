import { describe, expect, it } from "vitest";
import type { LinkIndex } from "../../src/bundle/links.js";
import type { BundleFile, Page, PathRole } from "../../src/bundle/model.js";
import { parsePage } from "../../src/bundle/page.js";
import {
  classifyPathField,
  type PathFieldIndex,
  pathEdgesOf,
} from "../../src/bundle/path-field.js";
import { reservedKind } from "../../src/bundle/reserved.js";
import { readFixture } from "../helpers/fixtures.js";

/** The classifier's index over a list of paths: a non-reserved `.md` is a held page, admitted unless withheld. */
function indexOver(paths: readonly string[], withheld: readonly string[] = []): PathFieldIndex {
  const index = {
    admitted: new Set<string>(),
    pages: new Set<string>(),
    reserved: new Set<string>(),
    attachments: new Set<string>(),
    folders: new Set<string>([""]),
  };
  for (const path of paths) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) index.folders.add(parts.slice(0, i).join("/"));
    if (reservedKind(path) !== undefined) index.reserved.add(path);
    else if (path.endsWith(".md")) {
      index.pages.add(path);
      if (!withheld.includes(path)) index.admitted.add(path);
    } else index.attachments.add(path);
  }
  return index;
}

const bundle = indexOver([
  "index.md",
  "log.md",
  "revenue.md",
  "foo.md",
  "foo.md.md",
  "metrics.md",
  "metrics/index.md",
  "metrics/margin.md",
  "tables/orders.md",
  "policies/revenue-recognition.md",
  "attesters/sql_equality.py",
  "a/other.md",
  "a/b/other.md",
]);
const ROLES: PathRole[] = ["resource", "source", "computation", "executor", "attester"];
const at = (value: string, role: PathRole = "source", from = "a/b/page.md") =>
  classifyPathField(value, role, from, bundle);

/** One page of a fixture, parsed as the loader parses it. */
function parsed(files: BundleFile[], path: string): Page {
  const linkIndex: LinkIndex = {
    pages: new Set(),
    reserved: new Set(),
    attachments: new Set(),
    folders: new Set([""]),
  };
  const file = files.find((f) => f.path === path);
  if (file === undefined) throw new Error(path);
  const result = parsePage(file, { linkIndex, specText: "2026-08-15" });
  if (!result.ok) throw new Error(`${path}: ${result.refusal.detail}`);
  return result.page;
}

// Issue 5's "Tests", one sentence of the classifier each, then D70's departures.
describe("classifyPathField: issue 5's sentences", () => {
  it("reads all queries in BigQuery project X on a source as a scope leaf", () => {
    expect(at("all queries in BigQuery project X")).toEqual({ kind: "scope" });
  });

  it("calls the same phrase on executor.resource unresolved, not a scope, as on every field but a source", () => {
    for (const role of ROLES.filter((r) => r !== "source"))
      expect(at("all queries in BigQuery project X", role), role).toEqual({ kind: "unresolved" });
  });

  it("calls orders, with neither orders nor orders.md present, unresolved, not a scope", () => {
    expect(at("orders")).toEqual({ kind: "unresolved" });
  });

  it("calls missing.md on a source unresolved", () => {
    expect(at("missing.md")).toEqual({ kind: "unresolved" });
    // A dot in the last segment is a path's shape, so a phrase that ends in one is no scope either.
    expect(at("see the ledger v2.1")).toEqual({ kind: "unresolved" });
  });

  it("leaves an https resource a url leaf, its fragment and all", () => {
    expect(at("https://example.test/handbook#refunds", "resource")).toEqual({ kind: "url" });
    expect(at("//cdn.example.test/x")).toEqual({ kind: "url" });
    expect(at("  mailto:team@example.test ", "source")).toEqual({ kind: "url" });
  });

  it("resolves a relative ../other.md from the page's folder", () => {
    expect(at("../other.md")).toEqual({ kind: "concept", target: "a/other.md" });
    expect(at("other.md")).toEqual({ kind: "concept", target: "a/b/other.md" });
    expect(at("/tables/orders.md#columns")).toEqual({
      kind: "concept",
      target: "tables/orders.md",
    });
    expect(at("/tables/or%64ers.md?v=2")).toEqual({ kind: "concept", target: "tables/orders.md" });
    expect(at("../../../above.md")).toEqual({ kind: "unresolved" });
    expect(at("/tables/%E0%A4%A.md")).toEqual({ kind: "unresolved" });
  });

  it("calls a lone #fragment on a source unresolved, not an anchor and not a scope", () => {
    for (const role of ROLES) {
      expect(at("#section", role), role).toEqual({ kind: "unresolved" });
      expect(at("  ?only=query ", role), role).toEqual({ kind: "unresolved" });
    }
  });

  it("calls an executor.resource pointing at a .py file an attachment, and reads no file", () => {
    // The classifier is handed names only: no bytes reach it, so nothing can be read or run.
    expect(at("/attesters/sql_equality.py", "executor")).toEqual({
      kind: "attachment",
      target: "attesters/sql_equality.py",
    });
  });

  it("calls a path-shaped executor.resource that matches nothing unresolved, not a scope", () => {
    expect(at("skills/run on nothing.md", "executor")).toEqual({ kind: "unresolved" });
    expect(at("/skills/none.md", "executor")).toEqual({ kind: "unresolved" });
  });

  it("answers a string that is the file foo.md and the concept id of foo.md.md as ambiguous, naming both", () => {
    expect(at("/foo.md")).toEqual({ kind: "ambiguous", candidates: ["foo.md", "foo.md.md"] });
  });

  it("answers a folder metrics beside a page metrics.md, named by metrics, as ambiguous, naming both", () => {
    expect(at("/metrics")).toEqual({ kind: "ambiguous", candidates: ["metrics", "metrics.md"] });
  });

  it("looks up a concept id and its file, and keeps a reserved file's kind", () => {
    expect(at("/revenue")).toEqual({ kind: "concept", target: "revenue.md" });
    expect(at("/log")).toEqual({ kind: "reserved", target: "log.md" });
    expect(at("/policies")).toEqual({ kind: "folder", target: "policies" });
    // A trailing slash names a folder, as a body link's does.
    expect(at("/metrics/")).toEqual({ kind: "folder", target: "metrics" });
  });
});

describe("classifyPathField: the root retry and unserved pages (D70)", () => {
  it("retries a bare relative path with a slash from the root and reports it once per page", () => {
    const files = readFixture("spec-example");
    const index = indexOver(files.map((f) => f.path));
    const page = parsed(files, "computations/revenue-ytd.md");
    const { edges, degradation } = pathEdgesOf(page, index);
    expect(edges).toEqual([
      {
        role: "source",
        field: "sources[0].resource",
        source: 0,
        raw: "policies/revenue-recognition.md",
        kind: "concept",
        target: "policies/revenue-recognition.md",
        fromRoot: true,
      },
      {
        role: "source",
        field: "sources[1].resource",
        source: 1,
        raw: "tables/orders.md",
        kind: "concept",
        target: "tables/orders.md",
        fromRoot: true,
      },
      {
        role: "executor",
        field: "executor.resource",
        raw: "skills/run-on-bq.md",
        kind: "concept",
        target: "skills/run-on-bq.md",
        fromRoot: true,
      },
      {
        role: "attester",
        field: "attester.resource",
        raw: "attesters/sql_equality.py",
        kind: "attachment",
        target: "attesters/sql_equality.py",
        fromRoot: true,
      },
    ]);
    expect(degradation).toEqual({
      path: "computations/revenue-ytd.md",
      code: "path-field-root-relative",
      field: "sources[0].resource",
      detail:
        "4 path fields name nothing from the page's folder and were read from the bundle root, as written without a leading /: sources[0].resource, sources[1].resource, executor.resource, attester.resource",
    });
    // The page's own resource, a URL, is an edge too, and a URL is never read from the root.
    const orders = pathEdgesOf(parsed(files, "tables/orders.md"), index);
    expect(orders.edges.map((e) => [e.role, e.field, e.kind, e.fromRoot ?? false])).toEqual([
      ["resource", "resource", "url", false],
      ["source", "sources[0].resource", "url", false],
      ["source", "sources[1].resource", "concept", true],
    ]);
    expect(orders.degradation?.detail).toMatch(/^1 path field names nothing /);
    // From a page at the root, or with a leading /, the root is the page's own reading: no retry, no report.
    expect(classifyPathField("tables/orders.md", "source", "top.md", index)).toEqual({
      kind: "concept",
      target: "tables/orders.md",
    });
    expect(classifyPathField("/tables/orders.md", "source", "metrics/revenue.md", index)).toEqual({
      kind: "concept",
      target: "tables/orders.md",
    });
    expect(pathEdgesOf(parsed(files, "policies/revenue-recognition.md"), index)).toEqual({
      edges: [
        {
          role: "resource",
          field: "resource",
          raw: "https://wiki.acme.internal/finance/revenue-recognition",
          kind: "url",
        },
      ],
    });
  });

  it("never retries a single-segment name, ./ or ../", () => {
    const index = indexOver([
      "revenue.md",
      "tables/orders.md",
      "policies/revenue-recognition.md",
      "a/b/c.md",
    ]);
    const from = (value: string, path: string) => classifyPathField(value, "source", path, index);
    expect(from("revenue", "tables/orders.md")).toEqual({ kind: "unresolved" });
    expect(from("revenue.md", "tables/orders.md")).toEqual({ kind: "unresolved" });
    expect(from("./policies/revenue-recognition.md", "tables/orders.md")).toEqual({
      kind: "unresolved",
    });
    expect(from("../policies/revenue-recognition.md", "a/b/c.md")).toEqual({
      kind: "unresolved",
    });
    expect(from("policies/revenue-recognition.md", "a/b/c.md")).toEqual({
      kind: "concept",
      target: "policies/revenue-recognition.md",
      fromRoot: true,
    });
  });

  it("calls a held but unadmitted page unserved", () => {
    const index = indexOver(
      ["foo.md", "foo.md.md", "drafts/plan.md", "metrics.md", "metrics/margin.md", "x.md"],
      ["foo.md.md", "drafts/plan.md", "metrics.md"],
    );
    const from = (value: string) => classifyPathField(value, "source", "x.md", index);
    expect(from("/drafts/plan.md")).toEqual({ kind: "unserved", target: "drafts/plan.md" });
    expect(from("drafts/plan")).toEqual({ kind: "unserved", target: "drafts/plan.md" });
    // Admitted candidates win: a held draft never makes an edge ambiguous.
    expect(from("/foo.md")).toEqual({ kind: "concept", target: "foo.md" });
    expect(from("/metrics")).toEqual({ kind: "folder", target: "metrics" });
  });
});
