import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bundleWorkDir,
  cacheRoot,
  ensureCache,
  judgeFolder,
  networkDir,
} from "../../src/fs/cache-dir.js";

describe("cacheRoot and networkDir", () => {
  it("uses an absolute XDG_CACHE_HOME, ignores a relative one with a note, and falls back per platform", () => {
    expect(
      cacheRoot({ env: { XDG_CACHE_HOME: "/var/cache/me" }, platform: "linux", home: "/home/me" }),
    ).toEqual({ root: "/var/cache/me" });
    const relative = cacheRoot({
      env: { XDG_CACHE_HOME: "cache" },
      platform: "linux",
      home: "/home/me",
    });
    expect(relative.root).toBe("/home/me/.cache");
    expect(relative.note).toMatch(/XDG_CACHE_HOME/);
    expect(cacheRoot({ env: {}, platform: "darwin", home: "/Users/me" }).root).toBe(
      "/Users/me/Library/Caches",
    );
    expect(cacheRoot({ env: {}, platform: "linux", home: "/home/me" }).root).toBe(
      "/home/me/.cache",
    );
  });
  it("places a network under okf-catalog in the root, and each bundle under bundles/<id> in its work folder", () => {
    expect(networkDir("/home/me/.cache", "acme")).toBe("/home/me/.cache/okf-catalog/acme");
    expect(bundleWorkDir("/home/me/.cache/okf-catalog/acme", "handbook")).toBe(
      "/home/me/.cache/okf-catalog/acme/bundles/handbook",
    );
  });
});

describe("judgeFolder (pure)", () => {
  const me = 501;
  it("accepts a folder of this user with no group or other write bits, and names each fault", () => {
    expect(
      judgeFolder({ uid: me, mode: 0o40700, isSymbolicLink: false }, me, false),
    ).toBeUndefined();
    expect(
      judgeFolder({ uid: me, mode: 0o40755, isSymbolicLink: false }, me, false),
    ).toBeUndefined();
    expect(judgeFolder({ uid: me, mode: 0o40775, isSymbolicLink: false }, me, false)).toMatch(
      /writable/,
    );
    expect(judgeFolder({ uid: 0, mode: 0o40700, isSymbolicLink: false }, me, false)).toMatch(
      /owned/,
    );
    expect(judgeFolder({ uid: me, mode: 0o40700, isSymbolicLink: true }, me, false)).toMatch(
      /link/,
    );
  });
  it("accepts a world-writable root only with the sticky bit", () => {
    expect(judgeFolder({ uid: 0, mode: 0o41777, isSymbolicLink: false }, me, true)).toBeUndefined();
    expect(judgeFolder({ uid: 0, mode: 0o40777, isSymbolicLink: false }, me, true)).toMatch(
      /sticky|writable/,
    );
  });
});

describe("ensureCache on real folders", () => {
  let work: string;
  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), "okf-catalog-cache-"));
  });
  afterAll(() => {
    rmSync(work, { recursive: true, force: true });
  });
  const uid = process.getuid?.() ?? 0;

  it("creates the company folder with mode 0700 and accepts it", () => {
    const root = join(work, "root1");
    const dir = networkDir(root, "acme");
    const r = ensureCache(dir, root, { uid, platform: "darwin" });
    expect(r).toEqual({ ok: true });
    expect(lstatSync(dir).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(root, "okf-catalog")).mode & 0o777).toBe(0o700);
  });
  it("tightens an existing company folder of this user to 0700", () => {
    const root = join(work, "root2");
    mkdirSync(join(root, "okf-catalog", "acme"), { recursive: true, mode: 0o755 });
    chmodSync(join(root, "okf-catalog", "acme"), 0o755);
    const r = ensureCache(networkDir(root, "acme"), root, { uid, platform: "linux" });
    expect(r).toEqual({ ok: true });
    expect(lstatSync(join(root, "okf-catalog", "acme")).mode & 0o777).toBe(0o700);
  });
  it("refuses a link where okf-catalog should be", () => {
    const root = join(work, "root3");
    mkdirSync(root, { recursive: true });
    mkdirSync(join(work, "elsewhere"), { recursive: true });
    symlinkSync(join(work, "elsewhere"), join(root, "okf-catalog"));
    const r = ensureCache(networkDir(root, "acme"), root, { uid, platform: "linux" });
    expect(!r.ok && r.problem).toMatch(/link/);
  });
  it("refuses a world-writable root without the sticky bit, and Windows outright", () => {
    const root = join(work, "root4");
    mkdirSync(root, { recursive: true });
    chmodSync(root, 0o777);
    const r = ensureCache(networkDir(root, "acme"), root, { uid, platform: "linux" });
    expect(!r.ok && r.problem).toMatch(/writable|sticky/);
    const win = ensureCache(networkDir(join(work, "root5"), "acme"), join(work, "root5"), {
      uid,
      platform: "win32",
    });
    expect(!win.ok && win.problem).toMatch(/Windows/);
  });
});

describe("ensureCache: no write before the judgement (bite 4 build review)", () => {
  it("leaves the target of a link at okf-catalog untouched when it refuses", () => {
    const work = mkdtempSync(join(tmpdir(), "okf-catalog-cache2-"));
    const root = join(work, "root");
    const elsewhere = join(work, "elsewhere");
    mkdirSync(root);
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(root, "okf-catalog"));
    const r = ensureCache(networkDir(root, "acme"), root, {
      uid: process.getuid?.() ?? 0,
      platform: "linux",
    });
    expect(r.ok).toBe(false);
    expect(readdirSync(elsewhere)).toEqual([]);
    rmSync(work, { recursive: true, force: true });
  });
});
