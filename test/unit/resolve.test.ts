import { describe, expect, it } from "vitest";
import { loadBundle } from "../../src/bundle/load.js";
import { DEFAULT_CAPS } from "../../src/bundle/model.js";
import { conceptNames } from "../../src/bundle/paths.js";
import { type BundleView, resolvePageName } from "../../src/catalog/resolve.js";
import { NOW } from "../helpers/fixtures.js";

// D60: one resolver for the name a caller gives get_page (and, from 0.3, citations and provenance).
const page = (title: string) =>
  Buffer.from(`---\ntype: Term\ntitle: ${title}\n---\n\nThe body of ${title}.\n`);
const files = [
  { path: "foo.md", bytes: page("Foo") },
  { path: "foo.md.md", bytes: page("Foo twice") },
  { path: "terms/alpha.md", bytes: page("Alpha") },
  { path: "terms/beta.md", bytes: page("Beta") },
  { path: "terms/gamma.md", bytes: page("Gamma") },
  { path: "terms/index.md", bytes: Buffer.from("# Terms\n\n* [Alpha](alpha.md)\n") },
  { path: "log.md", bytes: Buffer.from("# Log\n\n## 2026-10-07\n\n- started\n") },
];
const load = (company: string) =>
  loadBundle(
    company,
    files,
    {
      admit: ["stable", "deprecated"],
      dev: false,
      integrity: "none",
      specText: "2026-08-15",
      caps: DEFAULT_CAPS,
    },
    NOW,
  ).catalog;
const views: BundleView[] = [{ bundle: "b", catalog: load("b") }];
const found = (name: string, bundles = views, bundle?: string) => {
  const r = resolvePageName(bundles, name, bundle);
  if (!r.ok) throw new Error(`${name}: ${r.reason}`);
  return r.found;
};

describe("resolvePageName (D60)", () => {
  it("resolves a path after one leading / or ./", () => {
    for (const name of [
      "terms/alpha.md",
      "/terms/alpha.md",
      "./terms/alpha.md",
      "  terms/alpha.md ",
    ]) {
      const f = found(name);
      expect(f.kind, name).toBe("page");
      expect(f.path, name).toBe("terms/alpha.md");
    }
    for (const name of ["//terms/alpha.md", ".//terms/alpha.md", "/./terms/alpha.md"]) {
      const r = resolvePageName(views, name);
      expect(r.ok, name).toBe(false);
      expect(!r.ok && r.reason, name).toBe("not-found");
    }
  });

  it("resolves a concept id and reserved files both ways", () => {
    expect(conceptNames("terms/alpha")).toEqual(["terms/alpha", "terms/alpha.md"]);
    expect(found("terms/alpha").path).toBe("terms/alpha.md");
    expect(found("/terms/alpha").path).toBe("terms/alpha.md");
    for (const name of ["log", "log.md", "/log"]) {
      const f = found(name);
      expect(f.kind === "reserved" && f.file.kind, name).toBe("log");
      expect(f.path, name).toBe("log.md");
    }
    for (const name of ["terms/index", "terms/index.md"]) {
      const f = found(name);
      expect(f.kind === "reserved" && [f.file.kind, f.source], name).toEqual(["index", "file"]);
    }
    // The root has no index file, so its generated index is what `index` names.
    const root = found("index");
    expect(root.kind === "reserved" && [root.path, root.source]).toEqual(["index.md", "generated"]);
  });

  it("answers a path that is another page's concept id with both and their unique names", () => {
    const r = resolvePageName(views, "foo.md");
    expect(r).toEqual({
      ok: false,
      reason: "ambiguous",
      name: "foo.md",
      candidates: [
        { bundle: "b", path: "foo.md", ask: "foo" },
        { bundle: "b", path: "foo.md.md", ask: "foo.md.md" },
      ],
    });
    expect(found("foo").path).toBe("foo.md");
    expect(found("foo.md.md").path).toBe("foo.md.md");
    expect(found("/foo").path).toBe("foo.md");
  });

  it("names the three nearest served paths when nothing resolves", () => {
    const r = resolvePageName(views, "terms/alpa.md");
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== "not-found") throw new Error("expected not-found");
    expect(r.name).toBe("terms/alpa.md");
    expect(r.nearest).toHaveLength(3);
    expect(r.nearest[0]).toBe("terms/alpha.md");
  });

  it("takes a list of bundles and an optional bundle id", () => {
    expect(resolvePageName(views, "terms/alpha.md", "x")).toEqual({
      ok: false,
      reason: "unknown-bundle",
      bundle: "x",
      bundles: ["b"],
    });
    expect(found("terms/alpha", views, "b").bundle).toBe("b");
    const two: BundleView[] = [...views, { bundle: "c", catalog: load("c") }];
    const both = resolvePageName(two, "terms/alpha");
    expect(!both.ok && both.reason === "ambiguous" && both.candidates).toEqual([
      { bundle: "b", path: "terms/alpha.md", ask: "terms/alpha" },
      { bundle: "c", path: "terms/alpha.md", ask: "terms/alpha" },
    ]);
    expect(found("terms/alpha", two, "c").bundle).toBe("c");
    // A refused bundle is never a candidate, and naming it says it was refused.
    const fatal = {
      path: "manifest.json",
      rule: "manifest-missing" as const,
      detail: "no manifest",
    };
    const refused: BundleView[] = [
      views[0] as BundleView,
      { bundle: "c", catalog: load("c"), fatal },
    ];
    expect(found("terms/alpha", refused).bundle).toBe("b");
    expect(resolvePageName(refused, "terms/alpha", "c")).toEqual({
      ok: false,
      reason: "refused-bundle",
      bundle: "c",
      fatal,
    });
  });
});
