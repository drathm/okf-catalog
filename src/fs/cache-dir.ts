import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** The cache root: an absolute XDG_CACHE_HOME, else the platform's cache folder. A relative XDG value is ignored and noted. */
export function cacheRoot(input: {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  home: string;
}): { root: string; note?: string } {
  const xdg = input.env.XDG_CACHE_HOME;
  if (xdg !== undefined && xdg.length > 0) {
    if (isAbsolute(xdg)) return { root: xdg };
    return {
      root: fallbackRoot(input.platform, input.home),
      note: `XDG_CACHE_HOME is relative (${xdg}) and was ignored, as the specification requires`,
    };
  }
  return { root: fallbackRoot(input.platform, input.home) };
}

const fallbackRoot = (platform: NodeJS.Platform, home: string): string =>
  platform === "darwin" ? join(home, "Library", "Caches") : join(home, ".cache");

/** The okf-catalog cache folder under the cache root: every network's folder lies in it (D72). */
export function catalogCacheDir(root: string): string {
  return join(root, "okf-catalog");
}

/** The network's cache folder: its lock, its store, its private folders, and a folder per bundle (D72, D73). */
export function networkDir(root: string, network: string): string {
  return join(catalogCacheDir(root), network);
}

/** A bundle's folder under a work folder (the network's, or a private one): its clone, its trees and its generations. */
export function bundleWorkDir(work: string, bundle: string): string {
  return join(work, "bundles", bundle);
}

export interface FolderStat {
  uid: number;
  mode: number;
  isSymbolicLink: boolean;
}

/**
 * Why a folder cannot hold the cache, or `undefined` when it can. A pure rule, so every platform tests it: the
 * root may belong to anyone but must not be writable by everyone without the sticky bit; a folder the server
 * created or owns must be this user's, not a link, and not writable by its group or by everyone.
 */
export function judgeFolder(stat: FolderStat, uid: number, isRoot: boolean): string | undefined {
  if (stat.isSymbolicLink) return "is a symbolic link";
  if (isRoot) {
    if ((stat.mode & 0o002) !== 0 && (stat.mode & 0o1000) === 0) {
      return "is writable by everyone and has no sticky bit";
    }
    if (stat.uid !== uid && (stat.mode & 0o020) !== 0 && (stat.mode & 0o1000) === 0) {
      return "is owned by another user and writable by its group without the sticky bit";
    }
    return undefined;
  }
  if (stat.uid !== uid) return "is owned by another user";
  if ((stat.mode & 0o022) !== 0) return "is writable by its group or by everyone";
  return undefined;
}

/** Whether a folder lies inside another, or is it, by the paths as given (callers compare real paths, `realFolder`). */
export function folderInside(inner: string, outer: string): boolean {
  const rel = relative(resolve(outer), resolve(inner));
  // A sibling named "..out" is outside; only ".." itself or a "../" prefix leaves the folder.
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Whether one folder lies inside the other, or is it: two bundles never share a file (D76). */
export function foldersOverlap(one: string, other: string): boolean {
  return folderInside(one, other) || folderInside(other, one);
}

/**
 * A folder's real path: its links resolved and, where the file system ignores case, its name as stored
 * (`realpathSync.native`), so two spellings of one folder compare as one (D76; the fold of bite c's build reviews,
 * C-A-A6). The part of a path that does not exist yet is kept as written below its nearest existing folder's real
 * path.
 */
export function realFolder(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync.native(absolute);
  } catch {
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(realFolder(parent), basename(absolute));
  }
}

/** Whether one folder lies inside the other: the cache must never sit inside the bundle, nor the bundle inside the cache. */
export function cacheOverlapsBundle(cacheDir: string, bundleDir: string): boolean {
  return foldersOverlap(cacheDir, bundleDir);
}

/** `problem` is for the model and names no path; `detail` is for the log and does. */
export type EnsureResult = { ok: true } | { ok: false; problem: string; detail: string };

/**
 * Makes the network's folder under the cache root with mode 0700, tightens the folders it owns between the root
 * and the network's folder, and refuses when any of them fails the rule above. Windows is not a version 0 host.
 */
export function ensureCache(
  dir: string,
  root: string,
  options: { uid: number; platform: NodeJS.Platform },
): EnsureResult {
  const refuse = (problem: string, detail: string): EnsureResult => ({
    ok: false,
    problem,
    detail,
  });
  if (options.platform === "win32") {
    const text =
      "Windows is not a version 0 host: the cache folder's ownership and mode checks assume POSIX";
    return refuse(text, text);
  }
  // Judge what exists before anything is written: the root, then each existing folder down to the network's.
  const judgeRoot = (): EnsureResult | undefined => {
    try {
      const rootStat = lstatSync(realpathSync(root));
      const fault = judgeFolder(
        { uid: rootStat.uid, mode: rootStat.mode, isSymbolicLink: rootStat.isSymbolicLink() },
        options.uid,
        true,
      );
      if (fault !== undefined) {
        return refuse(
          `the cache root ${fault}; set XDG_CACHE_HOME to a folder only you can write`,
          `the cache root ${root} ${fault}`,
        );
      }
      return undefined;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "error";
      return refuse(
        `the cache root cannot be read (${code}); set XDG_CACHE_HOME to a folder you own`,
        `the cache root ${root} cannot be read (${code})`,
      );
    }
  };
  const rootExists = existsSync(root);
  if (rootExists) {
    const fault = judgeRoot();
    if (fault !== undefined) return fault;
  }
  const below = relative(root, dir)
    .split(sep)
    .filter((s) => s.length > 0);
  let current = root;
  for (const segment of below) {
    current = join(current, segment);
    let stat: ReturnType<typeof lstatSync> | undefined;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        const code = (error as NodeJS.ErrnoException).code ?? "error";
        return refuse(
          `a cache folder cannot be read (${code}); check the cache root's permissions`,
          `the cache folder ${current} cannot be read (${code})`,
        );
      }
    }
    if (stat?.isSymbolicLink()) {
      return refuse(
        "a cache folder is a symbolic link; remove it so the server can create its own",
        `the cache folder ${current} is a symbolic link`,
      );
    }
  }
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "error";
    return refuse(
      `the cache folder could not be created (${code}); check the cache root's permissions`,
      `the cache folder ${dir} could not be created (${code})`,
    );
  }
  if (!rootExists) {
    const fault = judgeRoot();
    if (fault !== undefined) return fault;
  }
  current = root;
  for (const segment of below) {
    current = join(current, segment);
    try {
      const stat = lstatSync(current);
      if (!stat.isSymbolicLink() && stat.uid === options.uid && (stat.mode & 0o777) !== 0o700) {
        chmodSync(current, 0o700);
      }
      const after = lstatSync(current);
      const fault = judgeFolder(
        { uid: after.uid, mode: after.mode, isSymbolicLink: after.isSymbolicLink() },
        options.uid,
        false,
      );
      if (fault !== undefined) {
        return refuse(
          `a cache folder ${fault}; remove it or fix it so the server can own it`,
          `the cache folder ${current} ${fault}`,
        );
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "error";
      return refuse(
        `a cache folder cannot be read (${code})`,
        `the cache folder ${current} cannot be read (${code})`,
      );
    }
  }
  return { ok: true };
}
