import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

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

export function companyDir(root: string, company: string): string {
  return join(root, "okf-catalog", company);
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
    return undefined;
  }
  if (stat.uid !== uid) return "is owned by another user";
  if ((stat.mode & 0o022) !== 0) return "is writable by its group or by everyone";
  return undefined;
}

export type EnsureResult = { ok: true } | { ok: false; problem: string };

/**
 * Makes the company folder under the cache root with mode 0700, tightens the folders it owns between the root
 * and the company folder, and refuses when any of them fails the rule above. Windows is not a version 0 host.
 */
export function ensureCache(
  dir: string,
  root: string,
  options: { uid: number; platform: NodeJS.Platform },
): EnsureResult {
  if (options.platform === "win32") {
    return {
      ok: false,
      problem:
        "Windows is not a version 0 host: the cache folder's ownership and mode checks assume POSIX",
    };
  }
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    return {
      ok: false,
      problem: `the cache folder ${dir} could not be created (${(error as NodeJS.ErrnoException).code ?? "error"})`,
    };
  }
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
    const rootStat = lstatSync(realRoot);
    const fault = judgeFolder(
      { uid: rootStat.uid, mode: rootStat.mode, isSymbolicLink: rootStat.isSymbolicLink() },
      options.uid,
      true,
    );
    if (fault !== undefined) return { ok: false, problem: `the cache root ${root} ${fault}` };
  } catch (error) {
    return {
      ok: false,
      problem: `the cache root ${root} cannot be read (${(error as NodeJS.ErrnoException).code ?? "error"})`,
    };
  }
  // Every folder between the root and the company folder, nearest the root first.
  const below = relative(root, dir)
    .split(sep)
    .filter((s) => s.length > 0);
  let current = root;
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
        return { ok: false, problem: `the cache folder ${current} ${fault}; remove it or fix it` };
      }
    } catch (error) {
      return {
        ok: false,
        problem: `the cache folder ${current} cannot be read (${(error as NodeJS.ErrnoException).code ?? "error"})`,
      };
    }
  }
  return { ok: true };
}
