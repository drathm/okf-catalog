import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_CAPS } from "../../src/bundle/model.js";
import { walkBundle } from "../../src/fs/walk.js";

/** A hostile tree, built at run time because its symbolic links and named pipe cannot be committed safely. */
let work: string;
let root: string;
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "okf-catalog-walk-"));
  root = join(work, "bundle");
  mkdirSync(join(root, "terms"), { recursive: true });
  mkdirSync(join(root, ".git", "objects"), { recursive: true });
  mkdirSync(join(root, ".qmd"), { recursive: true });
  mkdirSync(join(work, "outside"), { recursive: true });
  writeFileSync(join(root, "index.md"), "# Index\n");
  writeFileSync(join(root, "terms", "alpha.md"), "---\ntype: Term\n---\n# Alpha\n");
  writeFileSync(join(root, "terms", "big.md"), "x".repeat(300));
  writeFileSync(join(root, ".git", "objects", "pack.bin"), "y".repeat(5000));
  writeFileSync(join(root, ".qmd", "index.yml"), "collections: {}\n");
  writeFileSync(join(work, "outside", "secret.md"), "---\ntype: Secret\n---\n");
  symlinkSync(join(work, "outside", "secret.md"), join(root, "terms", "link.md"));
  symlinkSync(join(work, "outside"), join(root, "linked-folder"));
  execFileSync("mkfifo", [join(root, "terms", "pipe.md")]);
});
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

const caps = { ...DEFAULT_CAPS, fileBytes: 200 };

describe("walkBundle", () => {
  it("reads regular files only, never descends into or reads a dot-leading entry, and returns their paths", () => {
    const r = walkBundle(root, caps);
    expect(r.files.map((f) => f.path)).toEqual(["index.md", "terms/alpha.md"]);
    expect(r.hidden.sort()).toEqual([".git", ".qmd"]);
    expect(r.fatal).toBeUndefined();
  });

  it("refuses symbolic links, a named pipe and an oversize file without reading them", () => {
    const r = walkBundle(root, caps);
    expect(r.refusals.map((x) => [x.path, x.rule]).sort()).toEqual([
      ["linked-folder", "symlink"],
      ["terms/big.md", "oversize"],
      ["terms/link.md", "symlink"],
      ["terms/pipe.md", "special-file"],
    ]);
  });

  it("stops with a fatal refusal when the file count or the tree size exceeds the caps", () => {
    expect(walkBundle(root, { ...caps, files: 1 }).fatal).toMatchObject({ rule: "too-many-files" });
    expect(
      walkBundle(root, { fileBytes: 1_000_000, files: 1000, treeBytes: 100 }).fatal,
    ).toMatchObject({ rule: "tree-too-large" });
  });

  it("accepts a root given through a symbolic link, as macOS temp folders are", () => {
    expect(realpathSync(root)).not.toBe(root.replace("/private", "")); // on macOS the two differ, elsewhere they are equal
    const r = walkBundle(root, caps);
    expect(r.files.length).toBe(2);
  });

  it("returns an environment error for a root that does not exist", () => {
    expect(() => walkBundle(join(work, "missing"), caps)).toThrow(/does not exist|no such/i);
  });
});
