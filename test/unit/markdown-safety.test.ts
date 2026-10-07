import { describe, expect, it } from "vitest";
import { readBody } from "../../src/bundle/markdown.js";

describe("readBody: safety (review round 2)", () => {
  it("walks a body nested ten thousand levels deep without recursion", () => {
    const facts = readBody(`${">".repeat(10_000)} deep\n`);
    expect(facts.unanalysed).toBe(true);
    expect(facts.links).toEqual([]);
  });

  it("analyses a hundred kilobytes of nested brackets in well under a second", () => {
    const body = `${"[".repeat(50_000)}x${"]".repeat(50_000)}\n`;
    const started = performance.now();
    const facts = readBody(body);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(facts.unanalysed).toBe(true);
  });

  it("analyses only the first 256 KiB of a huge body and says so", () => {
    const body = `${"word ".repeat(80_000)}\n\n[late](/late.md)\n`;
    const facts = readBody(body);
    expect(facts.truncated).toBe(true);
    expect(facts.links).toEqual([]);
  });

  it("does not turn a bare email or URL into a link", () => {
    const facts = readBody(
      "Write to admin@example.test or see https://example.test/x then [real](/terms/alpha.md).\n",
    );
    expect(facts.links.map((l) => l.url)).toEqual(["/terms/alpha.md"]);
  });

  it("counts inline HTML and keeps it out of the first sentence", () => {
    const facts = readBody("Hello <img src=x onerror=alert(1)> world. Second.\n");
    expect(facts.inlineHtml).toBe(1);
    expect(facts.firstSentence).toBe("Hello world.");
  });
});

describe("readBody: safety (bite 3 build review)", () => {
  it("leaves a body of thousands of emphasis delimiter runs unanalysed instead of parsing it", () => {
    const body = `${"*a ".repeat(4000)}x${" a*".repeat(4000)}\n`;
    const started = performance.now();
    const facts = readBody(body);
    expect(performance.now() - started).toBeLessThan(300);
    expect(facts.unanalysed).toBe(true);
  });

  it("leaves a body of thousands of link definitions unanalysed instead of parsing it", () => {
    const body = `${Array.from({ length: 3000 }, (_, i) => `[d${i}]: /x${i}.md`).join("\n")}\n`;
    const started = performance.now();
    const facts = readBody(body);
    expect(performance.now() - started).toBeLessThan(300);
    expect(facts.unanalysed).toBe(true);
  });

  it("still analyses an ordinary page with emphasis, identifiers and a few definitions", () => {
    const facts = readBody(
      "Some *emphasis*, **strong** text and snake_case_names_with_many_underscores.\n\n[a]: /a.md\n[b]: /b.md\n\nSee [a][a].\n",
    );
    expect(facts.unanalysed).toBe(false);
    expect(facts.links.map((l) => l.url)).toEqual(["/a.md"]);
  });
});
