import type { Caps, Refusal } from "./model.js";
import { collisionKey, isSafeRelativePath } from "./paths.js";

/** One record of `git ls-tree -r -t -l -z --full-tree <commit>`. */
export interface TreeEntry {
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  /** Blob size in bytes; absent for a tree or a commit, which ls-tree prints as `-`. */
  size?: number;
  path: string;
}

const RECORD_HEAD = /^([0-7]{6}) (blob|tree|commit) ([0-9a-f]{40,64}) +(\d+|-)$/;
const utf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * Parses the NUL-terminated records of `ls-tree -z` with `-l`: `<mode> <type> <sha> <size padded>\t<path>`. The
 * path is verbatim, so only the first tab separates it. A record that does not fit is an error, never a guess.
 */
export function parseLsTree(bytes: Uint8Array): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let start = 0;
  for (let i = 0; i <= bytes.length; i++) {
    if (i < bytes.length && bytes[i] !== 0) continue;
    if (i === start) {
      start = i + 1;
      continue;
    }
    let record: string;
    try {
      record = utf8.decode(bytes.subarray(start, i));
    } catch {
      throw new Error("ls-tree printed a path that is not valid UTF-8");
    }
    const tab = record.indexOf("\t");
    const head = tab === -1 ? record : record.slice(0, tab);
    const match = RECORD_HEAD.exec(head);
    if (tab === -1 || match === null)
      throw new Error(`ls-tree printed a record this reader cannot parse`);
    const [, mode, type, sha, size] = match as unknown as [
      string,
      string,
      TreeEntry["type"],
      string,
      string,
    ];
    const entry: TreeEntry = { mode, type, sha, path: record.slice(tab + 1) };
    if (size !== "-") entry.size = Number(size);
    entries.push(entry);
    start = i + 1;
  }
  return entries;
}

/** Code points git's HFS+ protection ignores when it compares a name with `.git`. */
const HFS_IGNORABLE = /[‌-‏‪-‮⁪-⁯﻿]/gu;

/** Whether a path segment is `.git`, or one of the spellings a file system would fold onto it. */
export function isDotGitSegment(segment: string): boolean {
  const lowered = segment.normalize("NFC").toLowerCase();
  if (/^\.git[. ]*$/.test(lowered)) return true;
  if (lowered === "git~1") return true;
  return lowered.replace(HFS_IGNORABLE, "") === ".git";
}

const refuse = (path: string, rule: Refusal["rule"], detail: string): Refusal => ({
  path,
  rule,
  detail,
});

/**
 * Judges a fetched commit's tree before anything is written (D43): a symbolic link or a gitlink, a blob over the
 * file cap, more entries than the file cap, more blob bytes than the tree cap, a path the manifest rule would
 * refuse or that a file system would fold onto `.git`, a segment over 255 bytes, a name not in normalisation form
 * C, two names the engine's key folds together, or a bundle path that names no tree, each refuse the whole commit.
 */
export function validateTree(
  entries: readonly TreeEntry[],
  caps: Caps,
  bundlePath: string,
): Refusal | undefined {
  const seen = new Map<string, string>();
  let total = 0;
  let bundleFound = bundlePath === ".";
  if (entries.length > caps.files)
    return refuse(
      "",
      "too-many-files",
      `${entries.length} tree entries, over the cap of ${caps.files}`,
    );
  for (const entry of entries) {
    if (entry.mode === "120000")
      return refuse(entry.path, "symlink", "a symbolic link in the published tree");
    if (entry.type === "commit" || entry.mode === "160000")
      return refuse(entry.path, "gitlink", "a submodule in the published tree");
    if (!isSafeRelativePath(entry.path))
      return refuse(entry.path, "path-escape", "not a safe bundle-relative path");
    if (entry.path !== entry.path.normalize("NFC"))
      return refuse(entry.path, "path-escape", "not in Unicode normalisation form C");
    for (const segment of entry.path.split("/")) {
      if (isDotGitSegment(segment))
        return refuse(entry.path, "path-escape", "a segment a file system would read as .git");
      if (Buffer.byteLength(segment, "utf8") > 255)
        return refuse(entry.path, "path-escape", "a segment over 255 bytes");
    }
    const key = collisionKey(entry.path);
    const other = seen.get(key);
    if (other !== undefined)
      return refuse(
        entry.path,
        "path-escape",
        `collides with ${other} under case folding or normalisation`,
      );
    seen.set(key, entry.path);
    if (entry.type === "blob") {
      const size = entry.size ?? 0;
      if (size > caps.fileBytes)
        return refuse(entry.path, "oversize", `${size} bytes, over the cap of ${caps.fileBytes}`);
      total += size;
      if (total > caps.treeBytes)
        return refuse(
          entry.path,
          "tree-too-large",
          `the blobs total more than ${caps.treeBytes} bytes`,
        );
    } else if (entry.path === bundlePath) bundleFound = true;
  }
  if (!bundleFound)
    return refuse(
      bundlePath,
      "bundle-path-missing",
      "the configured bundle path is not a folder of the published tree",
    );
  return undefined;
}
