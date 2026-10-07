import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
    expect(r.hiddenFolders.sort()).toEqual([".git", ".qmd"]);
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
    const link = join(work, "root-link");
    symlinkSync(root, link);
    const direct = walkBundle(root, caps);
    const viaLink = walkBundle(link, caps);
    expect(viaLink.files.map((f) => f.path)).toEqual(direct.files.map((f) => f.path));
    expect(viaLink.refusals).toEqual(direct.refusals);
  });

  it.skipIf(process.getuid?.() === 0)(
    "refuses a file or folder it cannot read and still reports the rest",
    () => {
      const dir = join(work, "unreadable");
      mkdirSync(join(dir, "sealed"), { recursive: true });
      writeFileSync(join(dir, "ok.md"), "---\ntype: T\n---\n");
      writeFileSync(join(dir, "locked.md"), "---\ntype: T\n---\n");
      writeFileSync(join(dir, "sealed", "inner.md"), "---\ntype: T\n---\n");
      chmodSync(join(dir, "locked.md"), 0o000);
      chmodSync(join(dir, "sealed"), 0o000);
      try {
        const r = walkBundle(dir, caps);
        expect(r.files.map((f) => f.path)).toEqual(["ok.md"]);
        expect(r.refusals.map((x) => [x.path, x.rule])).toEqual([
          ["locked.md", "unreadable"],
          ["sealed", "unreadable"],
        ]);
        expect(r.refusals[0]?.detail).toMatch(/EACCES/);
        expect(r.fatal).toBeUndefined();
      } finally {
        chmodSync(join(dir, "sealed"), 0o700);
        chmodSync(join(dir, "locked.md"), 0o600);
      }
    },
  );

  it("counts every directory entry toward the file cap, links and hidden entries included", () => {
    const dir = join(work, "many-links");
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 5; i++) {
      symlinkSync(join(work, "outside", "secret.md"), join(dir, `l${i}.md`));
    }
    expect(walkBundle(dir, { ...caps, files: 3 }).fatal).toMatchObject({ rule: "too-many-files" });
    expect(walkBundle(dir, { ...caps, files: 5 }).fatal).toBeUndefined();
  });

  it("returns an environment error for a root that does not exist", () => {
    expect(() => walkBundle(join(work, "missing"), caps)).toThrow(/does not exist|no such/i);
  });
});
