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

  it("says no name reaches the middle of a chain of three alone, rather than offering its own ambiguous path (build review I-E5, A-A7)", () => {
    const chain: BundleView[] = [
      {
        bundle: "b",
        catalog: loadBundle(
          "b",
          ["foo.md", "foo.md.md", "foo.md.md.md"].map((path) => ({ path, bytes: page(path) })),
          {
            admit: ["stable", "deprecated"],
            dev: false,
            integrity: "none",
            specText: "2026-08-15",
            caps: DEFAULT_CAPS,
          },
          NOW,
        ).catalog,
      },
    ];
    // foo.md.md is foo.md's .md path and foo.md.md.md's concept id: no name means it alone (D60's recorded limit).
    expect(resolvePageName(chain, "foo.md.md")).toEqual({
      ok: false,
      reason: "ambiguous",
      name: "foo.md.md",
      candidates: [
        { bundle: "b", path: "foo.md.md" },
        { bundle: "b", path: "foo.md.md.md", ask: "foo.md.md.md" },
      ],
    });
    expect(resolvePageName(chain, "foo.md")).toEqual({
      ok: false,
      reason: "ambiguous",
      name: "foo.md",
      candidates: [
        { bundle: "b", path: "foo.md", ask: "foo" },
        { bundle: "b", path: "foo.md.md" },
      ],
    });
    expect(found("foo", chain).path).toBe("foo.md");
    expect(found("foo.md.md.md", chain).path).toBe("foo.md.md.md");
  });

  it("names the three nearest served paths when nothing resolves", () => {
    const r = resolvePageName(views, "terms/alpa.md");
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== "not-found") throw new Error("expected not-found");
    expect(r.name).toBe("terms/alpa.md");
    expect(r.nearest).toHaveLength(3);
    expect(r.nearest[0]).toEqual({ bundle: "b", path: "terms/alpha.md" });
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

// Issue 3 and D74: names across the bundles of a network. D60's uniqueness is each bundle's own; across bundles the
// bundle's id is what tells two pages of one name apart.
describe("resolvePageName across bundles (D74)", () => {
  const two: BundleView[] = [
    { bundle: "a", catalog: load("a") },
    { bundle: "b", catalog: load("b") },
  ];

  it("lists the bundle ids for a name two bundles hold, until one is named", () => {
    for (const name of ["terms/alpha", "terms/alpha.md", "/terms/alpha.md"]) {
      expect(resolvePageName(two, name), name).toEqual({
        ok: false,
        reason: "ambiguous",
        name: name.replace(/^\//, ""),
        candidates: [
          { bundle: "a", path: "terms/alpha.md", ask: "terms/alpha" },
          { bundle: "b", path: "terms/alpha.md", ask: "terms/alpha" },
        ],
      });
    }
    expect(found("terms/alpha", two, "a")).toMatchObject({ bundle: "a", path: "terms/alpha.md" });
    expect(found("terms/alpha", two, "b")).toMatchObject({ bundle: "b", path: "terms/alpha.md" });
    // A name the named bundle does not hold is not found there, with that bundle's nearest paths alone.
    const elsewhere: BundleView[] = [
      { bundle: "a", catalog: load("a") },
      {
        bundle: "b",
        catalog: loadBundle(
          "b",
          [{ path: "metrics/revenue.md", bytes: page("Revenue") }],
          {
            admit: ["stable", "deprecated"],
            dev: false,
            integrity: "none",
            specText: "2026-08-15",
            caps: DEFAULT_CAPS,
          },
          NOW,
        ).catalog,
      },
    ];
    const missing = resolvePageName(elsewhere, "terms/alpha", "b");
    expect(missing.ok).toBe(false);
    if (missing.ok || missing.reason !== "not-found") throw new Error("expected not-found");
    expect(missing.nearest.every((near) => near.bundle === "b")).toBe(true);
    expect(missing.nearest.map((near) => near.path)).toContain("metrics/revenue.md");
    // Not found in any bundle: the nearest paths of every bundle, each with its bundle.
    const nowhere = resolvePageName(two, "terms/alpa.md");
    if (nowhere.ok || nowhere.reason !== "not-found") throw new Error("expected not-found");
    expect(nowhere.nearest).toEqual([
      { bundle: "a", path: "terms/alpha.md" },
      { bundle: "b", path: "terms/alpha.md" },
      { bundle: "a", path: "terms/beta.md" },
    ]);
  });

  it("skips a refused bundle", () => {
    const fatal = {
      path: "manifest.json",
      rule: "manifest-missing" as const,
      detail: "no manifest",
    };
    // Its catalog still holds pages here, to show that a refused bundle is never read, not merely empty.
    const refused: BundleView[] = [
      { bundle: "a", catalog: load("a"), fatal },
      { bundle: "b", catalog: load("b") },
    ];
    expect(found("terms/alpha", refused)).toMatchObject({ bundle: "b", path: "terms/alpha.md" });
    expect(found("foo", refused)).toMatchObject({ bundle: "b", path: "foo.md" });
    const missing = resolvePageName(refused, "terms/alpa.md");
    if (missing.ok || missing.reason !== "not-found") throw new Error("expected not-found");
    expect(missing.nearest.every((near) => near.bundle === "b")).toBe(true);
    expect(resolvePageName(refused, "terms/alpha", "a")).toEqual({
      ok: false,
      reason: "refused-bundle",
      bundle: "a",
      fatal,
    });
    expect(resolvePageName(refused, "terms/alpha", "c")).toEqual({
      ok: false,
      reason: "unknown-bundle",
      bundle: "c",
      bundles: ["a", "b"],
    });
  });

  it("applies the foo.md rule across bundles", () => {
    const one = (bundle: string, path: string): BundleView => ({
      bundle,
      catalog: loadBundle(
        bundle,
        [{ path, bytes: page(path) }],
        {
          admit: ["stable", "deprecated"],
          dev: false,
          integrity: "none",
          specText: "2026-08-15",
          caps: DEFAULT_CAPS,
        },
        NOW,
      ).catalog,
    });
    // a holds foo.md; b holds foo.md.md, whose concept id is foo.md: one name, two pages, in two bundles.
    const split = [one("a", "foo.md"), one("b", "foo.md.md")];
    expect(resolvePageName(split, "foo.md")).toEqual({
      ok: false,
      reason: "ambiguous",
      name: "foo.md",
      candidates: [
        // Each name is unique inside its own bundle (D60, per bundle); the bundle's id makes it unique in the network.
        { bundle: "a", path: "foo.md", ask: "foo" },
        { bundle: "b", path: "foo.md.md", ask: "foo.md" },
      ],
    });
    expect(found("foo", split)).toMatchObject({ bundle: "a", path: "foo.md" });
    expect(found("foo.md", split, "b")).toMatchObject({ bundle: "b", path: "foo.md.md" });
    expect(found("foo.md", split, "a")).toMatchObject({ bundle: "a", path: "foo.md" });
    expect(found("foo.md.md", split)).toMatchObject({ bundle: "b", path: "foo.md.md" });
  });
});

// The fold of bite c's build reviews, C-A-A2: the name the server prints (`<bundle>:<path>`, a path that is not plain
// quoted) is a name the resolver takes back.
describe("resolvePageName: a printed name (C-A-A2)", () => {
  const options = {
    admit: ["stable", "deprecated"],
    dev: false,
    integrity: "none" as const,
    specText: "2026-08-15" as const,
    caps: DEFAULT_CAPS,
  };
  const bundleOf = (bundle: string, paths: string[]): BundleView => ({
    bundle,
    catalog: loadBundle(
      bundle,
      paths.map((path) => ({ path, bytes: page(path) })),
      options,
      NOW,
    ).catalog,
  });

  it("reads <bundle>:<path> in that bundle when the bundle is left out or is the same", () => {
    const two = [
      bundleOf("a", ["terms/alpha.md", "x.md"]),
      bundleOf("b", ["terms/alpha.md", "x.md"]),
    ];
    for (const name of ["b:terms/alpha.md", "b:terms/alpha", " b:/terms/alpha.md "])
      expect(found(name, two), name).toMatchObject({ bundle: "b", path: "terms/alpha.md" });
    expect(found("b:terms/alpha.md", two, "b")).toMatchObject({
      bundle: "b",
      path: "terms/alpha.md",
    });
    expect(found("a:index.md", two)).toMatchObject({ bundle: "a", kind: "reserved" });
    // Another bundle named beside the prefix: the name is read as written in that bundle, and is not there.
    const other = resolvePageName(two, "b:x.md", "a");
    expect(other.ok).toBe(false);
    expect(!other.ok && other.reason).toBe("not-found");
    // A printed name that is not there answers for the bundle it names, with that bundle's nearest paths.
    const missing = resolvePageName(two, "b:terms/alpa.md");
    if (missing.ok || missing.reason !== "not-found") throw new Error("expected not-found");
    expect(missing.name).toBe("terms/alpa.md");
    expect(missing.bundle).toBe("b");
    expect(missing.nearest.every((near) => near.bundle === "b")).toBe(true);
    // A prefix that is no bundle of the network is part of the name.
    const unknown = resolvePageName(two, "zz:x.md");
    expect(!unknown.ok && unknown.reason).toBe("not-found");
    // A refused bundle named by its prefix answers as a refused bundle named as the bundle.
    const fatal = { path: "", rule: "load-failed" as const, detail: "gone" };
    const refused = [{ ...bundleOf("a", ["x.md"]), fatal }, bundleOf("b", ["y.md"])];
    expect(resolvePageName(refused, "a:x.md")).toEqual({
      ok: false,
      reason: "refused-bundle",
      bundle: "a",
      fatal,
    });
  });

  it("reads a page whose path holds a colon as written first, and takes its quoted form back", () => {
    // a holds a page literally named "b:x.md"; b holds x.md: the literal path wins, as no page is preferred silently.
    const two = [bundleOf("a", ["b:x.md"]), bundleOf("b", ["x.md"])];
    expect(found("b:x.md", two)).toMatchObject({ bundle: "a", path: "b:x.md" });
    expect(found("b:x.md", two, "b")).toMatchObject({ bundle: "b", path: "x.md" });
    // The path printed quoted, as a line prints a path that is not plain, alone or after its bundle.
    expect(found('"b:x.md"', two)).toMatchObject({ bundle: "a", path: "b:x.md" });
    expect(found('a:"b:x.md"', two)).toMatchObject({ bundle: "a", path: "b:x.md" });
    expect(found('b:"x.md"', two)).toMatchObject({ bundle: "b", path: "x.md" });
    // A quoted path's escapes are read back: a quotation mark, and a character a line writes as \u escape.
    const odd = [bundleOf("a", ['say "hi".md', "zero\u200bwidth.md"])];
    expect(found('a:"say \\"hi\\".md"', odd)).toMatchObject({ path: 'say "hi".md' });
    expect(found('a:"zero\\\\u200bwidth.md"', odd)).toMatchObject({ path: "zero\u200bwidth.md" });
    // What is not a JSON string is no quoted name.
    const broken = resolvePageName(odd, 'a:"unclosed.md');
    expect(!broken.ok && broken.reason).toBe("not-found");
  });
});
