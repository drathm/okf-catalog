import { describe, expect, it } from "vitest";
import { decodeUtf8, parseFrontmatter, splitFrontmatter } from "../../src/bundle/frontmatter.js";

const page = (fm: string, body = "# Body\n\nText.\n") => `---\n${fm}\n---\n\n${body}`;

describe("splitFrontmatter", () => {
  it("separates the block from the body and drops the fences", () => {
    expect(splitFrontmatter(page("type: Term"))).toEqual({
      block: "type: Term",
      body: "\n# Body\n\nText.\n",
    });
  });

  it("strips a byte order mark before the opening fence", () => {
    expect(splitFrontmatter(`﻿${page("type: Term")}`).block).toBe("type: Term");
  });

  it("accepts CRLF line endings", () => {
    const text = page("type: Term").replace(/\n/g, "\r\n");
    const r = splitFrontmatter(text);
    expect(r.block).toBe("type: Term");
    expect(r.body?.startsWith("\r\n# Body")).toBe(true);
  });

  it("accepts a closing fence at the very end of the file with no newline after it", () => {
    expect(splitFrontmatter("---\ntype: Term\n---")).toEqual({ block: "type: Term", body: "" });
  });

  it("accepts the YAML document-end marker as a closing fence", () => {
    expect(splitFrontmatter("---\ntype: Term\n...\nBody\n").block).toBe("type: Term");
  });

  it("reports no block when the file does not open with a fence, or never closes it", () => {
    expect(splitFrontmatter("# No frontmatter\n").block).toBeUndefined();
    expect(splitFrontmatter("---\ntype: Term\nno closing fence\n").block).toBeUndefined();
    expect(splitFrontmatter("").block).toBeUndefined();
  });

  it("treats an empty block between two fences as present and empty", () => {
    expect(splitFrontmatter("---\n---\nBody\n")).toEqual({ block: "", body: "Body\n" });
  });
});

describe("parseFrontmatter", () => {
  it("keeps dates and times as strings", () => {
    const r = parseFrontmatter("stale_after: 2027-01-31\nat: 2000-02-01T10:00:00Z\n");
    expect(r.ok && r.data).toEqual({ stale_after: "2027-01-31", at: "2000-02-01T10:00:00Z" });
  });

  it("parses the flow mappings the specification uses, including a colon inside an actor", () => {
    const r = parseFrontmatter("verified: { by: human:jsmith@acme, at: 2024-01-15T10:00:00Z }\n");
    expect(r.ok && r.data).toEqual({
      verified: { by: "human:jsmith@acme", at: "2024-01-15T10:00:00Z" },
    });
  });

  it("does not resolve explicit tags, so !!timestamp stays text", () => {
    const r = parseFrontmatter("when: !!timestamp 2026-12-31\n");
    expect(r.ok && r.data).toEqual({ when: "2026-12-31" });
  });

  it("refuses a duplicate key", () => {
    const r = parseFrontmatter("type: A\ntype: B\n");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/duplicate/i);
  });

  it("refuses YAML that does not parse", () => {
    const r = parseFrontmatter("title: [unclosed\n");
    expect(r.ok).toBe(false);
  });

  it("refuses a self-referencing alias instead of returning a cycle", () => {
    const r = parseFrontmatter("a: &x [1, *x]\n");
    expect(r.ok).toBe(false);
  });

  it("treats an empty block as an empty mapping", () => {
    expect(parseFrontmatter("")).toEqual({ ok: true, data: {}, warnings: [], sources: {} });
  });

  it("refuses a block that is a list or a scalar rather than a mapping", () => {
    expect(parseFrontmatter("- a\n- b\n").ok).toBe(false);
    expect(parseFrontmatter("just text\n").ok).toBe(false);
  });

  it("keeps the source text of top-level scalars so a numeric type can be read as written", () => {
    const r = parseFrontmatter("type: 123\nokf_version: 0.10\n");
    expect(r.ok && r.data).toEqual({ type: 123, okf_version: 0.1 });
    expect(r.ok && r.sources).toEqual({ type: "123", okf_version: "0.10" });
  });
});

describe("decodeUtf8", () => {
  it("decodes valid UTF-8 and rejects an invalid byte", () => {
    expect(decodeUtf8(new TextEncoder().encode("héllo"))).toEqual({ ok: true, text: "héllo" });
    expect(decodeUtf8(new Uint8Array([0x68, 0xff, 0x69]))).toEqual({ ok: false });
  });
});
