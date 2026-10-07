import { isMap, isScalar, parseDocument } from "yaml";
import { BOM } from "./paths.js";

export function decodeUtf8(bytes: Uint8Array): { ok: true; text: string } | { ok: false } {
  try {
    return { ok: true, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { ok: false };
  }
}

export interface Split {
  block?: string;
  body: string;
  /** True when a fence opened the file and no line closed it. */
  unclosed?: boolean;
}

/**
 * Splits a page into its frontmatter block and body. The block is present only when the text opens with
 * a `---` line and a later line is exactly `---` or `...`; both fences may carry trailing spaces or tabs, as
 * the OKF checkers accept. Fence lines and a trailing newline are dropped from the block; the body is
 * everything after the closing fence as written.
 */
export function splitFrontmatter(text: string): Split {
  const t = text.startsWith(BOM) ? text.slice(1) : text;
  const opening = /^---[ \t]*\r?\n/.exec(t);
  if (!opening) return { body: t };
  const start = opening[0].length;
  let i = start;
  for (;;) {
    const nl = t.indexOf("\n", i);
    const line = nl === -1 ? t.slice(i) : t.slice(i, nl);
    const bare = line.replace(/[ \t\r]+$/, "");
    if (bare === "---" || bare === "...") {
      return {
        block: t.slice(start, i).replace(/\r?\n$/, ""),
        body: nl === -1 ? "" : t.slice(nl + 1),
      };
    }
    if (nl === -1) return { body: t, unclosed: true };
    i = nl + 1;
  }
}

export type FrontmatterResult =
  | { ok: true; data: Record<string, unknown>; warnings: string[]; sources: Record<string, string> }
  | { ok: false; error: string };

interface Diagnostic {
  code: string;
  message: string;
  linePos?: Array<{ line: number; col: number }>;
  pos?: [number, number];
}

/** A YAML diagnostic as a file position: the block starts on the line after the opening fence. */
function describe(e: Diagnostic, fenceLine: number, block: string): string {
  const pos = e.linePos?.[0];
  const where = pos === undefined ? "" : ` at line ${pos.line + fenceLine}, column ${pos.col}`;
  if (e.code === "DUPLICATE_KEY") {
    // The parser's position covers one character of the repeated key; the key is the text before the colon on that line.
    const line = pos === undefined ? undefined : block.split("\n")[pos.line - 1];
    const key =
      line === undefined
        ? ""
        : (/^\s*(?:-\s*)?["']?([^"':]+?)["']?\s*:/.exec(line)?.[1] ?? "").trim();
    return key.length === 0 ? `duplicate key${where}` : `duplicate key "${key}"${where}`;
  }
  const first =
    e.message
      .split("\n")[0]
      ?.replace(/\s+at line \d+, column \d+:?\s*$/, "")
      .replace(/:\s*$/, "") ?? e.code;
  return `${first}${where}`;
}

/**
 * Parses a frontmatter block as YAML 1.2 with the core schema: dates stay strings, explicit tags are not
 * resolved, duplicate keys are errors, and a cycle or a non-mapping is an error. `sources` keeps the text
 * of each top-level scalar as written, so `type: 123` can still be read as "123". `fenceLine` is the file
 * line of the opening fence, so diagnostics point at file lines.
 */
export function parseFrontmatter(block: string, fenceLine = 1): FrontmatterResult {
  const doc = parseDocument(block, {
    version: "1.2",
    schema: "core",
    uniqueKeys: true,
    resolveKnownTags: false,
    logLevel: "silent",
  });
  if (doc.errors.length > 0) {
    return { ok: false, error: doc.errors.map((e) => describe(e, fenceLine, block)).join("; ") };
  }
  let data: unknown;
  try {
    data = doc.toJS({ maxAliasCount: 100 });
  } catch (error) {
    return { ok: false, error: `frontmatter could not be read: ${(error as Error).message}` };
  }
  if (data === null || data === undefined) data = {};
  if (typeof data !== "object" || Array.isArray(data))
    return { ok: false, error: "frontmatter is not a mapping" };
  try {
    JSON.stringify(data);
  } catch {
    return { ok: false, error: "frontmatter contains a cycle" };
  }
  const sources: Record<string, string> = Object.create(null) as Record<string, string>;
  if (isMap(doc.contents)) {
    for (const pair of doc.contents.items) {
      if (isScalar(pair.key) && isScalar(pair.value) && typeof pair.value.source === "string") {
        sources[String(pair.key.value)] = pair.value.source;
      }
    }
  }
  return {
    ok: true,
    data: data as Record<string, unknown>,
    warnings: doc.warnings.map((w) => describe(w, fenceLine, block)),
    sources,
  };
}
