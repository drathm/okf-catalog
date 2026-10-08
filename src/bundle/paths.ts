/** Path helpers shared by the core. Bundle paths are POSIX, relative, and never contain a backslash. */

export const BOM = "﻿";

export function folderOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

export const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The two files a name can mean (§2): the path as written, and the file whose concept id it is, the path with
 * `.md` removed. The one two-name rule: `get_page`'s resolver uses it, and the path-field classifier will (D60).
 */
export const conceptNames = (name: string): [string, string] => [name, `${name}.md`];

// biome-ignore lint/suspicious/noControlCharactersInRegex: a path holding one is refused
const PATH_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** A bundle-relative path: no leading slash, no backslash, no control or line-separator character, no empty, `.`, `..` or `__proto__` segment. */
export function isSafeRelativePath(path: string): boolean {
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    PATH_CONTROLS.test(path)
  ) {
    return false;
  }
  return path
    .split("/")
    .every(
      (segment) => segment !== "" && segment !== "." && segment !== ".." && segment !== "__proto__",
    );
}

/** Two paths that agree under this key would be one file to the engine (and to a case-folding file system). */
export const collisionKey = (path: string): string =>
  path.normalize("NFC").toUpperCase().toLowerCase();

/** The first pair of paths the engine's key folds together, or undefined when every path is distinct under it. */
export function findCollision(paths: readonly string[]): [string, string] | undefined {
  const seen = new Map<string, string>();
  for (const path of paths) {
    const key = collisionKey(path);
    const other = seen.get(key);
    if (other !== undefined) return [other, path];
    seen.set(key, path);
  }
  return undefined;
}
