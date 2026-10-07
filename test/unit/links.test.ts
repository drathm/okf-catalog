import { describe, expect, it } from "vitest";
import { resolveLink } from "../../src/bundle/links.js";

const index = {
  pages: new Set(["terms/alpha.md", "terms/beta.md", "notes/no-title.md", "root.md"]),
  reserved: new Set(["index.md", "terms/index.md", "log.md"]),
  attachments: new Set(["references/attachment.txt"]),
  folders: new Set(["", "terms", "notes", "references"]),
};

describe("resolveLink", () => {
  it("resolves a bundle-absolute link from anywhere", () => {
    expect(resolveLink("/terms/beta.md", "notes/no-title.md", index)).toEqual({
      kind: "page",
      target: "terms/beta.md",
    });
  });

  it("resolves a relative link against the page's folder", () => {
    expect(resolveLink("./beta.md", "terms/alpha.md", index)).toEqual({
      kind: "page",
      target: "terms/beta.md",
    });
    expect(resolveLink("../notes/no-title.md", "terms/alpha.md", index)).toEqual({
      kind: "page",
      target: "notes/no-title.md",
    });
    expect(resolveLink("beta.md", "terms/alpha.md", index)).toEqual({
      kind: "page",
      target: "terms/beta.md",
    });
  });

  it("strips fragments and queries before resolving", () => {
    expect(resolveLink("/terms/beta.md#top", "root.md", index)).toEqual({
      kind: "page",
      target: "terms/beta.md",
    });
  });

  it("classifies folders, reserved files and attachments", () => {
    expect(resolveLink("/terms/", "root.md", index)).toEqual({ kind: "folder", target: "terms" });
    expect(resolveLink("terms/index.md", "root.md", index)).toEqual({
      kind: "reserved",
      target: "terms/index.md",
    });
    expect(resolveLink("/references/attachment.txt", "root.md", index)).toEqual({
      kind: "attachment",
      target: "references/attachment.txt",
    });
  });

  it("treats a fragment-only link as an anchor", () => {
    expect(resolveLink("#legacy", "root.md", index)).toEqual({ kind: "anchor" });
  });

  it("treats any scheme and a protocol-relative URL as external", () => {
    expect(resolveLink("https://example.test/x.md", "root.md", index)).toEqual({
      kind: "external",
    });
    expect(resolveLink("mailto:someone@example.test", "root.md", index)).toEqual({
      kind: "external",
    });
    expect(resolveLink("//example.test/x.md", "root.md", index)).toEqual({ kind: "external" });
  });

  it("percent-decodes segments and reports a bad escape as broken", () => {
    expect(resolveLink("/terms/alph%61.md", "root.md", index)).toEqual({
      kind: "page",
      target: "terms/alpha.md",
    });
    expect(resolveLink("/terms/%E0%A4%A.md", "root.md", index)).toEqual({ kind: "broken" });
  });

  it("reports a link above the root, an empty link and a missing target as broken", () => {
    expect(resolveLink("../../x.md", "terms/alpha.md", index)).toEqual({ kind: "broken" });
    expect(resolveLink("", "root.md", index)).toEqual({ kind: "broken" });
    expect(resolveLink("/terms/missing.md", "root.md", index)).toEqual({ kind: "broken" });
  });
});

describe("resolveLink: percent-encoding edge cases (review round 1)", () => {
  it("decodes before handling dot segments, so an encoded parent segment climbs", () => {
    expect(resolveLink("/terms/%2E%2E/root.md", "root.md", index)).toEqual({
      kind: "page",
      target: "root.md",
    });
    expect(resolveLink("/%2E%2E/x.md", "root.md", index)).toEqual({ kind: "broken" });
  });

  it("does not let an encoded slash fabricate a path separator", () => {
    expect(resolveLink("/terms%2Fbeta.md", "root.md", index)).toEqual({ kind: "broken" });
  });
});
