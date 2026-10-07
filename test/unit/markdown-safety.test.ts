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
