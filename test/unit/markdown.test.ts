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

  it("collects footnote reference identifiers and does not count them as links", () => {
    const facts = readBody("Claim.[^alpha-handbook]\n\n[^alpha-handbook]: The handbook\n");
    expect(facts.footnoteReferences).toEqual(["alpha-handbook"]);
    expect(facts.links).toEqual([]);
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
      htmlBlocks: 0,
      inlineHtml: 0,
      hasScriptLike: false,
    });
  });
});
