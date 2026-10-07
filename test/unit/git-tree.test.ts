import { describe, expect, it } from "vitest";
import { parseLsTree, type TreeEntry, validateTree } from "../../src/bundle/git-tree.js";
import { DEFAULT_CAPS } from "../../src/bundle/model.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const record = (mode: string, type: string, size: string, path: string): string =>
  `${mode} ${type} ${SHA} ${size.padStart(7, " ")}\t${path}\0`;
const listing = (...records: string[]): Uint8Array => Buffer.from(records.join(""), "utf8");

const blob = (path: string, size = 10): TreeEntry => ({
  mode: "100644",
  type: "blob",
  sha: SHA,
  size,
  path,
});
const tree = (path: string): TreeEntry => ({ mode: "040000", type: "tree", sha: SHA, path });

describe("parseLsTree", () => {
  it("reads the NUL-separated records of ls-tree -r -t -l -z, with padded sizes and verbatim paths", () => {
    const entries = parseLsTree(
      listing(
        record("100644", "blob", "31", ".gitattributes"),
        record("040000", "tree", "-", "kb"),
        record("160000", "commit", "-", "sub"),
        record("120000", "blob", "5", "link"),
        record("100644", "blob", "12345678", "big.bin"),
        record("100644", "blob", "3", "kb/odd name\twith tab.md"),
      ),
    );
    expect(entries).toEqual([
      { mode: "100644", type: "blob", sha: SHA, size: 31, path: ".gitattributes" },
      { mode: "040000", type: "tree", sha: SHA, path: "kb" },
      { mode: "160000", type: "commit", sha: SHA, path: "sub" },
      { mode: "120000", type: "blob", sha: SHA, size: 5, path: "link" },
      { mode: "100644", type: "blob", sha: SHA, size: 12345678, path: "big.bin" },
      { mode: "100644", type: "blob", sha: SHA, size: 3, path: "kb/odd name\twith tab.md" },
    ]);
  });
  it("rejects a record it cannot read instead of guessing", () => {
    expect(() => parseLsTree(Buffer.from("garbage\0"))).toThrow(/ls-tree/);
  });
});

describe("validateTree", () => {
  const caps = DEFAULT_CAPS;
  it("accepts a clean tree and finds the bundle path among its trees", () => {
    expect(validateTree([tree("kb"), blob("kb/a.md"), blob("kb/b.md")], caps, ".")).toBeUndefined();
    expect(validateTree([tree("kb"), blob("kb/a.md")], caps, "kb")).toBeUndefined();
    expect(validateTree([tree("kb"), blob("kb/a.md")], caps, "docs")?.rule).toBe(
      "bundle-path-missing",
    );
    expect(validateTree([blob("kb")], caps, "kb")?.rule).toBe("bundle-path-missing");
  });
  it("refuses symbolic links and gitlinks by mode", () => {
    const link = validateTree(
      [{ mode: "120000", type: "blob", sha: SHA, size: 4, path: "l" }],
      caps,
      ".",
    );
    expect(link).toMatchObject({ rule: "symlink", path: "l" });
    const sub = validateTree(
      [{ mode: "160000", type: "commit", sha: SHA, path: "vendor" }],
      caps,
      ".",
    );
    expect(sub).toMatchObject({ rule: "gitlink", path: "vendor" });
  });
  it("applies the caps to blobs, entries and the total", () => {
    expect(validateTree([blob("big", caps.fileBytes + 1)], caps, ".")).toMatchObject({
      rule: "oversize",
      path: "big",
    });
    const small = { ...caps, files: 2 };
    expect(validateTree([blob("a"), blob("b"), blob("c")], small, ".")?.rule).toBe(
      "too-many-files",
    );
    const tiny = { ...caps, treeBytes: 15 };
    expect(validateTree([blob("a", 10), blob("b", 10)], tiny, ".")?.rule).toBe("tree-too-large");
  });
  it("refuses unsafe paths: escapes, controls, backslashes, .git and its disguises, long segments, non-NFC names", () => {
    for (const path of [
      "../x",
      "a/../b",
      "/abs",
      "a\\b",
      "ctl\u0001.md",
      "nl\n.md",
      ".git/config",
      ".GIT/config",
      "kb/.git",
      "git~1/x",
      ".g‌it/x",
      ".git./x",
      ".git /x",
      `${"a".repeat(256)}/x`,
      "café.md",
    ])
      expect(validateTree([blob(path)], caps, "."), JSON.stringify(path)).toMatchObject({
        rule: "path-escape",
      });
  });
  it("refuses two paths that collide under the engine's key", () => {
    const byCase = validateTree([blob("A.md"), blob("a.md")], caps, ".");
    expect(byCase?.rule).toBe("path-escape");
    expect(byCase?.detail).toMatch(/A\.md/);
    expect(validateTree([blob("x/é.md"), blob("X/É.md")], caps, ".")?.rule).toBe("path-escape");
  });
});
