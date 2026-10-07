import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
} from "node:fs";
import { join, sep } from "node:path";
import type { BundleFile, Caps, Refusal } from "../bundle/model.js";
import { byCodeUnit } from "../bundle/paths.js";

export interface WalkResult {
  files: BundleFile[];
  /** Dot-leading entries, as paths, never descended into or read. */
  hidden: string[];
  refusals: Refusal[];
  fatal?: Refusal;
}

/**
 * Reads a bundle folder into memory. Regular files only: a symbolic link is refused where it stands, a pipe,
 * socket or device is refused as a special file, and an oversize file is refused from its size without being
 * read. Dot-leading entries are returned as hidden paths and never opened, so a checkout's `.git` never
 * enters the walk. Files are opened without following links and without blocking, and read through the
 * descriptor that was checked. The root is resolved once; a folder whose real path leaves it is refused.
 */
export function walkBundle(root: string, caps: Caps): WalkResult {
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    throw new Error(`the bundle folder ${root} does not exist or cannot be read`);
  }
  const result: WalkResult = { files: [], hidden: [], refusals: [] };
  const refuse = (path: string, rule: Refusal["rule"], detail: string): void => {
    result.refusals.push({ path, rule, detail });
  };
  let total = 0;
  const pending: string[] = [""];
  while (pending.length > 0) {
    const relDir = pending.pop() as string;
    const absDir = relDir === "" ? realRoot : join(realRoot, relDir);
    const entries = readdirSync(absDir, { withFileTypes: true }).sort((a, b) =>
      byCodeUnit(a.name, b.name),
    );
    for (const entry of entries) {
      const rel = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
      if (entry.name.startsWith(".")) {
        result.hidden.push(rel);
        continue;
      }
      const abs = join(absDir, entry.name);
      const stat = lstatSync(abs);
      if (stat.isSymbolicLink()) {
        refuse(rel, "symlink", "symbolic links are not followed");
        continue;
      }
      if (stat.isDirectory()) {
        const real = realpathSync(abs);
        if (real !== realRoot && !real.startsWith(realRoot + sep)) {
          refuse(rel, "path-escape", "the folder's real path leaves the bundle");
          continue;
        }
        pending.push(rel);
        continue;
      }
      if (!stat.isFile()) {
        refuse(rel, "special-file", "not a regular file (a pipe, socket or device)");
        continue;
      }
      if (stat.size > caps.fileBytes) {
        refuse(rel, "oversize", `${stat.size} bytes exceeds the cap of ${caps.fileBytes}`);
        continue;
      }
      const bytes = readRegularFile(abs, caps.fileBytes);
      if (bytes === undefined) {
        refuse(rel, "special-file", "the entry changed under the walk and is not a regular file");
        continue;
      }
      if (bytes.length > caps.fileBytes) {
        refuse(rel, "oversize", `more than ${caps.fileBytes} bytes`);
        continue;
      }
      result.files.push({ path: rel, bytes });
      total += bytes.length;
      if (result.files.length > caps.files) {
        result.fatal = {
          path: "",
          rule: "too-many-files",
          detail: `more than ${caps.files} files`,
        };
        return result;
      }
      if (total > caps.treeBytes) {
        result.fatal = {
          path: "",
          rule: "tree-too-large",
          detail: `more than ${caps.treeBytes} bytes`,
        };
        return result;
      }
    }
  }
  result.files.sort((a, b) => byCodeUnit(a.path, b.path));
  return result;
}

/** Opens without following a link and without blocking, checks the descriptor, and reads at most `cap + 1` bytes. */
function readRegularFile(abs: string, cap: number): Uint8Array | undefined {
  const fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return undefined;
    const buffer = Buffer.alloc(Math.min(stat.size, cap + 1));
    let offset = 0;
    while (offset < buffer.length) {
      const n = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (n === 0) break;
      offset += n;
    }
    return buffer.subarray(0, offset);
  } finally {
    closeSync(fd);
  }
}
