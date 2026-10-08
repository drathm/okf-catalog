import { describe, expect, it } from "vitest";
import { readBody } from "../../src/bundle/markdown.js";

describe("readBody", () => {
  it("finds the first heading at any depth and the first sentence of the first paragraph", () => {
    const facts = readBody(
      "## Deprecated\n\n**This metric is retired.** The current definition is elsewhere.\n",
    );
    expect(facts.firstHeading).toBe("Deprecated");
    expect(facts.firstSentence).toBe("This metric is retired.");
  });

  it("skips tables and footnote definitions when looking for the first sentence", () => {
    const body =
      "| a | b |\n|---|---|\n| 1 | 2 |\n\n[^n]: A note.\n\nReal prose comes here. More.\n";
    expect(readBody(body).firstSentence).toBe("Real prose comes here.");
  });

  it("strips footnote marks and collapses whitespace in the first sentence", () => {
    const body =
      "Revenue is recognised\nper the policy.[^rev-policy] Then more.\n\n[^rev-policy]: The policy.\n";
    expect(readBody(body).firstSentence).toBe("Revenue is recognised per the policy.");
  });

  it("caps a run-on first sentence", () => {
    const facts = readBody(`${"word ".repeat(80)}\n`);
    expect(facts.firstSentence?.length).toBeLessThanOrEqual(200);
  });

  it("lists links in document order, including reference-style links and links in headings", () => {
    const body =
      "# See [alpha](/terms/alpha.md)\n\nThen [beta][b] and [gamma](./gamma.md#top).\n\n[b]: /terms/beta.md\n";
    expect(readBody(body).links.map((l) => l.url)).toEqual([
      "/terms/alpha.md",
      "/terms/beta.md",
      "./gamma.md#top",
    ]);
  });

  it("records footnote references with their block and heading", () => {
    const facts = readBody("Claim.[^alpha-handbook]\n\n[^alpha-handbook]: The handbook\n");
    expect(facts.footnoteReferences).toEqual([{ id: "alpha-handbook", block: "Claim." }]);
    expect(facts.links).toEqual([]);
    // Two references in one block are two entries with the same prose; GFM records the identifier lower-cased.
    // The block is the smallest one holding the reference: a list item's or a quotation's paragraph, a table
    // cell, a heading; never the list, the quotation or the table around it.
    const body = [
      "# Scope",
      "",
      "First claim.[^a] Second claim.[^Ga4-Schema]",
      "",
      "- an item claim[^c]",
      "- another item",
      "",
      "> a quoted claim[^d]",
      "",
      "| column | other |",
      "|---|---|",
      "| a cell claim[^e] | beside |",
      "",
      "## A heading claim[^f]",
      "",
      "[^a]: A.",
      "[^ga4-schema]: Schema.",
      "[^c]: C.",
      "[^d]: D.",
      "[^e]: E.",
      "[^f]: F.",
      "",
    ].join("\n");
    expect(readBody(body).footnoteReferences).toEqual([
      { id: "a", block: "First claim. Second claim.", heading: "Scope" },
      { id: "ga4-schema", block: "First claim. Second claim.", heading: "Scope" },
      { id: "c", block: "an item claim", heading: "Scope" },
      { id: "d", block: "a quoted claim", heading: "Scope" },
      { id: "e", block: "a cell claim", heading: "Scope" },
      { id: "f", block: "A heading claim", heading: "A heading claim" },
    ]);
  });

  it("counts block HTML and flags script-like elements", () => {
    const facts = readBody(
      '<div class="box">Raw HTML.</div>\n\n<script>alert(1)</script>\n\nProse.\n',
    );
    expect(facts.htmlBlocks).toBe(2);
    expect(facts.hasScriptLike).toBe(true);
  });

  it("does not flag inline markup such as a line break as script-like", () => {
    const facts = readBody("A line<br>break and `List<String>` in code.\n");
    expect(facts.hasScriptLike).toBe(false);
    expect(facts.htmlBlocks).toBe(0);
  });

  it("returns nothing for an empty body", () => {
    expect(readBody("")).toEqual({
      firstHeading: undefined,
      firstSentence: undefined,
      links: [],
      footnoteReferences: [],
      citations: [],
      htmlBlocks: 0,
      inlineHtml: 0,
      hasScriptLike: false,
      unanalysed: false,
      truncated: false,
      prose: "",
    });
  });
});

describe("readBody: reference links and nested structures (review round 1)", () => {
  it("leaves an undefined reference as text, which is how CommonMark reads it, and keeps a defined one", () => {
    expect(readBody("See [beta][b] here.\n").links).toEqual([]);
    expect(readBody("See [beta][b].\n\n[b]: /x.md\n").links.map((l) => l.url)).toEqual(["/x.md"]);
  });

  it("finds links in nested lists, around images, inside footnote definitions and in link-only headings", () => {
    const body =
      "- outer\n  - [a](/a.md)\n\n[![img](/i.png)](/b.md)\n\n# [c](/c.md)\n\nText.[^n]\n\n[^n]: See [d](/d.md).\n";
    expect(readBody(body).links.map((l) => l.url)).toEqual(["/a.md", "/b.md", "/c.md", "/d.md"]);
  });
});

describe("readBody: prose for snippets (bite 4)", () => {
  it("captures the prose once, with blocks separated by a space and HTML and footnote marks left out", () => {
    const facts = readBody(
      "# Title\n\nFirst paragraph.\nStill first.\n\n- item one\n- item two\n\n<div>html</div>\n\nLast[^1] words.\n\n[^1]: a note\n",
    );
    expect(facts.prose).toBe(
      "Title First paragraph. Still first. item one item two Last words. a note",
    );
  });
  it("has no prose for an unanalysed body", () => {
    expect(readBody(`${">".repeat(10_000)} deep\n`).prose).toBeUndefined();
  });
});

// R6 (D63): the OKF 0.1 `# Citations` list, level one only, up to the next heading.
describe("readBody: the OKF 0.1 citations list (R6)", () => {
  it("collects the lists under a level-one Citations heading, up to the next heading", () => {
    const facts = readBody(
      "Intro.\n\n# citations\n\n- https://x.test/a\n- [B](https://x.test/b) and words\n\nA paragraph between.\n\n- two [links](https://x.test/c) [here](https://x.test/d)\n\n# Next\n\n- https://x.test/e\n",
    );
    expect(facts.citations).toEqual([
      { text: "https://x.test/a" },
      { text: "B and words", url: "https://x.test/b" },
      { text: "two links here" },
    ]);
    expect(readBody("# Notes\n\n## Citations\n\n- https://x.test/a\n").citations).toEqual([]);
    expect(readBody("# CITATIONS\n\n- https://x.test/a\n").citations).toEqual([
      { text: "https://x.test/a" },
    ]);
    expect(readBody("# Citations\n\n## Sub\n\n- https://x.test/a\n").citations).toEqual([]);
    expect(readBody("Body with no such heading.\n").citations).toEqual([]);
  });
});

// Issue 5: what citations needs from a body, stored at load (D69).
describe("readBody: link text, headings and claim blocks (#5)", () => {
  it("keeps link text and the nearest heading at or before the link", () => {
    const body = [
      "Before any [heading](/a.md) there is none.",
      "",
      "# Top with [a link](/b.md)",
      "",
      "Text with [**strong** words](/c.md) and [a reference][r].",
      "",
      "#",
      "",
      "After an empty heading, [no text](/e.md).",
      "",
      "## Sub",
      "",
      "- [listed](/f.md)",
      "",
      "[r]: /d.md",
      "",
    ].join("\n");
    expect(readBody(body).links).toEqual([
      { url: "/a.md", text: "heading" },
      { url: "/b.md", text: "a link", heading: "Top with a link" },
      { url: "/c.md", text: "strong words", heading: "Top with a link" },
      { url: "/d.md", text: "a reference", heading: "Top with a link" },
      { url: "/e.md", text: "no text" },
      { url: "/f.md", text: "listed", heading: "Sub" },
    ]);
  });

  it("takes the smallest block holding a reference, cut at 500, never the definition", () => {
    const long = `${"word ".repeat(120)}claim.`;
    const facts = readBody(
      `# H\n\n${long}[^n]\n\nShort.[^m]\n\n${"a".repeat(499)}${"😀".repeat(3)}[^p]\n\n[^n]: See [d](/d.md).\n[^m]: The definition prose.\n[^p]: P.\n`,
    );
    const [first, second, third] = facts.footnoteReferences;
    expect(first).toEqual({ id: "n", block: long.slice(0, 500), heading: "H" });
    expect(second).toEqual({ id: "m", block: "Short.", heading: "H" });
    // The cut never splits a surrogate pair.
    expect(third?.block).toBe("a".repeat(499));
    for (const reference of facts.footnoteReferences) {
      expect(reference.block).not.toContain("See d");
      expect(reference.block).not.toContain("definition prose");
    }
    // A link inside a definition is still a link, and the definition's prose is still the body's prose.
    expect(facts.links.map((l) => l.url)).toEqual(["/d.md"]);
    expect(facts.prose).toContain("The definition prose.");
  });
});
