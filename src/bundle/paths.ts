/** Path helpers shared by the core. Bundle paths are POSIX, relative, and never contain a backslash. */

export const BOM = "﻿";

export function folderOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

export const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A bundle-relative path: no leading slash, no backslash, no NUL, no empty, `.`, `..` or `__proto__` segment. */
export function isSafeRelativePath(path: string): boolean {
  if (path.length === 0 || path.startsWith("/") || /[\\\0]/.test(path)) return false;
  return path
    .split("/")
    .every(
      (segment) => segment !== "" && segment !== "." && segment !== ".." && segment !== "__proto__",
    );
}
