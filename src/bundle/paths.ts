/** Path helpers shared by the core. Bundle paths are POSIX, relative, and never contain a backslash. */

export const BOM = "﻿";

export function folderOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

export const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

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
