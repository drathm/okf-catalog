import { describe, expect, it } from "vitest";
import { loadBundle } from "../../src/bundle/load.js";
import { DEFAULT_CAPS, type Page } from "../../src/bundle/model.js";
import { citationsOf, MAX_ENTERED, walkProvenance } from "../../src/catalog/graph.js";
import type { Catalog } from "../../src/catalog/model.js";
import { NOW, readFixture } from "../helpers/fixtures.js";

/** A bundle from a map of path to text, loaded as a served bundle loads it, integrity off. */
function bundle(files: Record<string, string>, admit = ["stable", "deprecated"]): Catalog {
  return loadBundle(
    "b",
    Object.entries(files).map(([path, text]) => ({ path, bytes: Buffer.from(text) })),
    { admit, dev: false, integrity: "none", specText: "2026-08-15", caps: DEFAULT_CAPS },
    NOW,
  ).catalog;
}
const note = (frontmatter: string, body = "Body.\n") =>
  `---\ntype: Note\ntitle: T\n${frontmatter}---\n\n${body}`;
const pageOf = (catalog: Catalog, path: string): Page => {
  const page = catalog.pages.get(path);
  if (page === undefined) throw new Error(`${path} is not admitted`);
  return page;
};
const sources = (...entries: string[]) => `sources:\n${entries.map((e) => `  - ${e}\n`).join("")}`;

// Issue 5's "Tests", sentence for sentence, and D71's walk.
describe("citationsOf", () => {
  it("joins claims by footnote id, case ignored, with their block", () => {
    const catalog = bundle({
      "a.md": note(
        sources(
          "{ id: ga4-schema, resource: https://x.test/ga4, title: GA4 schema, author: team:data, usage_count: 7, last_modified: 2026-01-01 }",
          "{ id: GA4-Schema, resource: https://x.test/ga4-old }",
        ),
        "# Events\n\nThe event table changed.[^Ga4-Schema] Then more.[^ga4-schema]\n\n[^Ga4-Schema]: See [the notes](/b.md) on the schema.\n",
      ),
      "b.md": note(""),
    });
    const cited = citationsOf(catalog, pageOf(catalog, "a.md"));
    const claim = {
      footnote: "ga4-schema",
      block: "The event table changed. Then more.",
      heading: "Events",
      sources: [
        {
          id: "ga4-schema",
          resource: "https://x.test/ga4",
          title: "GA4 schema",
          author: "team:data",
          usageCount: 7,
          lastModified: "2026-01-01",
        },
        { id: "GA4-Schema", resource: "https://x.test/ga4-old" },
      ],
    };
    // Two references in one block are two claims with the same prose.
    expect(cited.claims).toEqual([claim, claim]);
    // The link in the definition is a mention; the definition's prose is no claim's block.
    expect(cited.mentions).toEqual([
      { kind: "page", raw: "/b.md", target: "b.md", text: "the notes", heading: "Events" },
    ]);
    expect(JSON.stringify(cited.claims)).not.toContain("on the schema");
    expect(cited.bibliography).toEqual([]);
    expect(cited.unjoined).toEqual([]);
    expect(cited.partial).toBe(false);
  });

  it("lists bibliography, unjoined and inbound derivations", () => {
    const catalog = bundle({
      "policy.md": note(
        `${sources("{ id: law, resource: https://x.test/law, title: The law }", "{ resource: https://x.test/memo, author: team:legal }")}usage_window: { from: 2026-01-01, to: 2026-03-31 }\n`,
        "A claim with no source.[^nobody] Another.[^Nobody]\n\n[^nobody]: Nothing.\n",
      ),
      "uses/policy-user.md": note(
        sources(
          "{ resource: ../policy.md, author: team:ops, usage_count: 4, last_modified: 2026-02-02, usage_window: { from: 2026-02-01, to: 2026-02-28 } }",
        ),
      ),
      "uses/policy-resource.md": note("resource: /policy\n"),
      "uses/contract.md": note("executor: { resource: /policy.md }\n"),
      "foo.md": note(""),
      "foo.md.md": note(""),
      "uses/ambiguous.md": note(sources("{ resource: /foo.md, usage_count: 2 }")),
    });
    const cited = citationsOf(catalog, pageOf(catalog, "policy.md"));
    // The page's window is on the result once; its sources that inherit it name it (merge ruling 1).
    expect(cited.usageWindow).toEqual({ from: "2026-01-01", to: "2026-03-31" });
    expect(cited.bibliography).toEqual([
      { id: "law", resource: "https://x.test/law", title: "The law", window: { inherited: true } },
      { resource: "https://x.test/memo", author: "team:legal", window: { inherited: true } },
    ]);
    // A footnote with no source is unjoined, once per reference, and never a claim.
    expect(cited.unjoined).toEqual([
      { footnote: "nobody", block: "A claim with no source. Another." },
      { footnote: "nobody", block: "A claim with no source. Another." },
    ]);
    expect(cited.claims).toEqual([]);
    expect(cited.inboundDerivations).toEqual([
      { from: "uses/policy-resource.md", field: "resource", kind: "concept" },
      {
        from: "uses/policy-user.md",
        field: "sources[0].resource",
        kind: "concept",
        author: "team:ops",
        usageCount: 4,
        lastModified: "2026-02-02",
        window: { from: "2026-02-01", to: "2026-02-28", inherited: false },
      },
    ]);
    // An ambiguous source that names this concept is an inbound derivation and says so.
    expect(citationsOf(catalog, pageOf(catalog, "foo.md.md")).inboundDerivations).toEqual([
      { from: "uses/ambiguous.md", field: "sources[0].resource", kind: "ambiguous", usageCount: 2 },
    ]);
  });

  it("keeps mention kinds and calls an unadmitted target unserved", () => {
    const catalog = bundle({
      "index.md": "# Root\n\n- [Page](page.md)\n",
      "page.md": note(
        "",
        [
          "# Links",
          "",
          "[served](/other.md) [draft](/draft.md) [missing](/missing.md) [web](https://x.test)",
          "[anchor](#top) [folder](/sub/) [index](/sub/index.md) [file](/sub/data.csv)",
          "[no suffix](/revenue) [self](page.md)",
          "",
        ].join("\n"),
      ),
      "other.md": note("", "Back to [the page](/page.md).\n"),
      "draft.md": note("status: draft\n"),
      "revenue.md": note(""),
      "sub/index.md": "# Sub\n",
      "sub/data.csv": "a,b\n",
      "sourcing.md": note(sources("{ resource: /page.md }")),
    });
    const cited = citationsOf(catalog, pageOf(catalog, "page.md"));
    expect(cited.mentions.map((m) => [m.kind, m.target ?? m.raw, m.text, m.heading])).toEqual([
      ["page", "other.md", "served", "Links"],
      ["unserved", "draft.md", "draft", "Links"],
      ["broken", "/missing.md", "missing", "Links"],
      ["external", "https://x.test", "web", "Links"],
      ["anchor", "#top", "anchor", "Links"],
      ["folder", "sub", "folder", "Links"],
      ["reserved", "sub/index.md", "index", "Links"],
      ["attachment", "sub/data.csv", "file", "Links"],
      // A body link written without .md is not given a second name.
      ["broken", "/revenue", "no suffix", "Links"],
      ["page", "page.md", "self", "Links"],
    ]);
    // An inbound body link and an inbound source both name the pointing page; an index entry is no mention.
    expect(cited.inboundMentions).toEqual([
      { from: "other.md", text: "the page" },
      { from: "page.md", text: "self", heading: "Links" },
    ]);
    expect(cited.inboundDerivations.map((d) => d.from)).toEqual(["sourcing.md"]);
  });

  it("says partial when the body was only partly analysed", () => {
    const catalog = bundle({ "deep.md": note("", `${">".repeat(300)} deep\n`) });
    expect(citationsOf(catalog, pageOf(catalog, "deep.md")).partial).toBe(true);
  });
});

describe("walkProvenance", () => {
  const chain = bundle({
    "a.md": note(sources("{ resource: b.md, author: team:x }", "{ resource: https://x.test/a }")),
    "b.md": note(sources("{ resource: c.md }")),
    "c.md": note(sources("{ resource: d.md }")),
    "d.md": note(
      "stale_after: 2000-01-01\nverified: [{ by: human:r, at: 1999-12-01T00:00:00Z }]\n",
    ),
  });

  it("walks sources into concepts and stops at urls and depth", () => {
    const deep = walkProvenance(chain, pageOf(chain, "a.md"), 4, NOW);
    expect(deep.nodes.map((n) => [n.path, n.level, n.parent ?? null, n.truncated])).toEqual([
      ["a.md", 0, null, false],
      ["b.md", 1, "a.md", false],
      ["c.md", 2, "b.md", false],
      ["d.md", 3, "c.md", false],
    ]);
    expect(deep.nodes[0]?.edges.map((e) => [e.field, e.kind, e.walk ?? null])).toEqual([
      ["sources[0].resource", "concept", "entered"],
      ["sources[1].resource", "url", null],
    ]);
    // Each entered concept carries its tier, its recheck date and whether it is overdue.
    expect(deep.nodes[3]).toMatchObject({
      trust: "human-reviewed",
      recheck: { raw: "2000-01-01", form: "date", overdue: true },
    });
    expect(deep.capped).toBe(false);
    // Depth 0 emits the start page's edges and enters nothing; the cut branch says so.
    const none = walkProvenance(chain, pageOf(chain, "a.md"), 0, NOW);
    expect(none.nodes.map((n) => [n.path, n.truncated])).toEqual([["a.md", true]]);
    expect(none.nodes[0]?.edges[0]?.walk).toBe("depth-limit");
    const one = walkProvenance(chain, pageOf(chain, "a.md"), 1, NOW);
    expect(one.nodes.map((n) => [n.path, n.truncated])).toEqual([
      ["a.md", false],
      ["b.md", true],
    ]);
  });

  it("enters a concept once, at its least depth, and records a later reach as an edge", () => {
    // A diamond: a reaches d through b and through c; d is entered once, through the first branch.
    const diamond = bundle({
      "a.md": note(sources("{ resource: b.md }", "{ resource: c.md }")),
      "b.md": note(sources("{ resource: d.md }")),
      "c.md": note(
        `${sources("{ resource: d.md, id: d-again, author: team:c, usage_count: 9, last_modified: 2026-03-03 }")}usage_window: { from: 2026-01-01, to: 2026-06-30 }\n`,
      ),
      "d.md": note(""),
    });
    const walk = walkProvenance(diamond, pageOf(diamond, "a.md"), 4, NOW);
    expect(walk.nodes.map((n) => [n.path, n.level])).toEqual([
      ["a.md", 0],
      ["b.md", 1],
      ["c.md", 1],
      ["d.md", 2],
    ]);
    // The later reach is recorded with the same source fields as an expanded edge, so no citation's record drops.
    expect(walk.nodes[2]?.edges).toEqual([
      {
        role: "source",
        field: "sources[0].resource",
        raw: "d.md",
        kind: "concept",
        target: "d.md",
        id: "d-again",
        author: "team:c",
        usageCount: 9,
        lastModified: "2026-03-03",
        window: { inherited: true },
        walk: "already-entered",
      },
    ]);
    // The node carries its page's window once, which that edge names.
    expect(walk.nodes[2]?.usageWindow).toEqual({ from: "2026-01-01", to: "2026-06-30" });
    // A shorter path wins: d reached directly from a is entered at level 1, and b's edge to it is a later reach.
    const shortcut = bundle({
      "a.md": note(sources("{ resource: b.md }", "{ resource: d.md }")),
      "b.md": note(sources("{ resource: d.md }")),
      "d.md": note(""),
    });
    const short = walkProvenance(shortcut, pageOf(shortcut, "a.md"), 4, NOW);
    expect(short.nodes.map((n) => [n.path, n.level])).toEqual([
      ["a.md", 0],
      ["b.md", 1],
      ["d.md", 1],
    ]);
    expect(short.nodes[1]?.edges[0]?.walk).toBe("already-entered");
  });

  it("records a cycle as an edge to an ancestor and stops the branch", () => {
    const loop = bundle({
      "a.md": note(sources("{ resource: b.md }", "{ resource: a.md }")),
      "b.md": note(sources("{ resource: c.md }")),
      "c.md": note(sources("{ resource: b.md }", "{ resource: a.md }")),
    });
    const walk = walkProvenance(loop, pageOf(loop, "a.md"), 8, NOW);
    expect(walk.nodes.map((n) => n.path)).toEqual(["a.md", "b.md", "c.md"]);
    expect(walk.nodes[0]?.edges.map((e) => e.walk)).toEqual(["entered", "cycle"]);
    expect(walk.nodes[2]?.edges.map((e) => [e.target, e.walk])).toEqual([
      ["b.md", "cycle"],
      ["a.md", "cycle"],
    ]);
    expect(walk.nodes.every((n) => !n.truncated)).toBe(true);
  });

  it("never hops from an entered page's own resource or a contract edge", () => {
    const catalog = bundle({
      "a.md": note(
        `resource: e.md\n${sources("{ resource: b.md }")}computation: c.md\nexecutor: { resource: c.md }\nattester: { resource: tools/check.py }\n`,
      ),
      "b.md": note(`resource: f.md\n${sources("{ resource: https://x.test/b }")}`),
      "c.md": note(""),
      "e.md": note(""),
      "f.md": note(""),
      "tools/check.py": "print('never run')\n",
    });
    const walk = walkProvenance(catalog, pageOf(catalog, "a.md"), 4, NOW);
    expect(walk.nodes.map((n) => n.path)).toEqual(["a.md", "e.md", "b.md"]);
    expect(
      walk.nodes[0]?.edges.map((e) => [e.role, e.kind, e.target ?? null, e.walk ?? null]),
    ).toEqual([
      ["resource", "concept", "e.md", "entered"],
      ["source", "concept", "b.md", "entered"],
      ["computation", "concept", "c.md", null],
      ["executor", "concept", "c.md", null],
      ["attester", "attachment", "tools/check.py", null],
    ]);
    // b's own resource names f.md: an entered page emits its sources only.
    expect(walk.nodes[2]?.edges.map((e) => e.role)).toEqual(["source"]);
  });

  it("takes a source's window, else the page's", () => {
    const catalog = bundle({
      "a.md": note(
        `${sources("{ resource: https://x.test/own, usage_count: 1, usage_window: { from: 2026-04-01, to: 2026-04-30 } }", "{ resource: https://x.test/shared, usage_count: 2 }", "{ resource: https://x.test/none }")}usage_window: { from: 2026-01-01, to: 2026-03-31 }\n`,
      ),
      "b.md": note(sources("{ resource: https://x.test/none, usage_count: 3 }")),
    });
    const walk = walkProvenance(catalog, pageOf(catalog, "a.md"), 4, NOW);
    expect(walk.nodes[0]?.edges.map((e) => [e.usageCount ?? null, e.window ?? null])).toEqual([
      [1, { from: "2026-04-01", to: "2026-04-30", inherited: false }],
      [2, { inherited: true }],
      [null, { inherited: true }],
    ]);
    expect(walk.nodes[0]?.usageWindow).toEqual({ from: "2026-01-01", to: "2026-03-31" });
    // usage_count is returned and orders nothing: the rows stay in the page's order.
    const plain = walkProvenance(catalog, pageOf(catalog, "b.md"), 4, NOW);
    expect(plain.nodes[0]?.edges[0]).toMatchObject({ usageCount: 3 });
    expect(plain.nodes[0]?.edges[0]?.window).toBeUndefined();
    const cited = citationsOf(catalog, pageOf(catalog, "a.md"));
    expect(cited.bibliography.map((s) => s.window?.inherited ?? null)).toEqual([false, true, true]);
  });

  it("stops entering at 200 concepts and says so", () => {
    // 50 pages under the start, 4 more under each: 250 concepts within depth 2, more than the walk enters.
    const files: Record<string, string> = {};
    const name = (prefix: string, i: number) => `${prefix}${String(i).padStart(3, "0")}.md`;
    files["start.md"] = note(
      sources(...Array.from({ length: 50 }, (_, i) => `{ resource: ${name("p/", i)} }`)),
    );
    for (let i = 0; i < 50; i++) {
      files[name("p/", i)] = note(
        sources(...Array.from({ length: 4 }, (_, j) => `{ resource: /${name("q/", i * 4 + j)} }`)),
      );
      for (let j = 0; j < 4; j++) files[name("q/", i * 4 + j)] = note("");
    }
    const catalog = bundle(files);
    const walk = walkProvenance(catalog, pageOf(catalog, "start.md"), 8, NOW);
    expect(MAX_ENTERED).toBe(200);
    expect(walk.nodes).toHaveLength(201);
    expect(walk.capped).toBe(true);
    const outcomes = walk.nodes.flatMap((n) => n.edges.map((e) => e.walk));
    expect(outcomes.filter((w) => w === "entered")).toHaveLength(200);
    expect(outcomes.filter((w) => w === "concept-limit")).toHaveLength(50);
    expect(walk.nodes.every((n) => !n.truncated)).toBe(true);
  });

  it("caps a node's sources at 50, with their total, and walks only those listed", () => {
    const files: Record<string, string> = {
      "wide.md": note(
        sources(
          ...Array.from(
            { length: 60 },
            (_, i) => `{ resource: n${String(i).padStart(2, "0")}.md }`,
          ),
        ),
      ),
    };
    for (let i = 0; i < 60; i++) files[`n${String(i).padStart(2, "0")}.md`] = note("");
    const catalog = bundle(files);
    const walk = walkProvenance(catalog, pageOf(catalog, "wide.md"), 4, NOW);
    expect(walk.nodes[0]?.sourcesTotal).toBe(60);
    expect(walk.nodes[0]?.edges).toHaveLength(50);
    expect(walk.nodes).toHaveLength(51);
  });

  it("follows the specification's own example: four edges, two concepts entered once each", () => {
    const { catalog } = loadBundle(
      "acme",
      readFixture("spec-example"),
      {
        admit: ["stable", "deprecated"],
        dev: false,
        integrity: "require-manifest",
        specText: "2026-08-15",
        caps: DEFAULT_CAPS,
      },
      NOW,
    );
    const walk = walkProvenance(catalog, pageOf(catalog, "computations/revenue-ytd.md"), 4, NOW);
    expect(walk.nodes.map((n) => n.path)).toEqual([
      "computations/revenue-ytd.md",
      "policies/revenue-recognition.md",
      "tables/orders.md",
    ]);
    expect(walk.nodes[0]?.edges.map((e) => [e.role, e.kind, e.target, e.walk ?? null])).toEqual([
      ["source", "concept", "policies/revenue-recognition.md", "entered"],
      ["source", "concept", "tables/orders.md", "entered"],
      ["executor", "concept", "skills/run-on-bq.md", null],
      ["attester", "attachment", "attesters/sql_equality.py", null],
    ]);
    expect(walk.nodes[2]?.edges.map((e) => [e.kind, e.target ?? null, e.walk ?? null])).toEqual([
      ["url", null, null],
      ["concept", "policies/revenue-recognition.md", "already-entered"],
    ]);
  });
});
