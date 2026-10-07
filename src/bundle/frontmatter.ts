import { isMap, isScalar, parseDocument } from "yaml";

export function decodeUtf8(bytes: Uint8Array): { ok: true; text: string } | { ok: false } {
  try {
    return { ok: true, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { ok: false };
  }
}

/**
 * Splits a page into its frontmatter block and body. The block is present only when the text opens with
 * a `---` line and a later line is exactly `---` or `...`; fence lines and a trailing newline are dropped
 * from the block, the body is everything after the closing fence as written.
 */
export function splitFrontmatter(text: string): { block?: string; body: string } {
  const t = text.startsWith("﻿") ? text.slice(1) : text;
  const opening = /^---\r?\n/.exec(t);
  if (!opening) return { body: t };
  const start = opening[0].length;
  let i = start;
  for (;;) {
    const nl = t.indexOf("\n", i);
    const line = nl === -1 ? t.slice(i) : t.slice(i, nl);
    const bare = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (bare === "---" || bare === "...") {
      return {
        block: t.slice(start, i).replace(/\r?\n$/, ""),
        body: nl === -1 ? "" : t.slice(nl + 1),
      };
    }
    if (nl === -1) return { body: t };
    i = nl + 1;
  }
}

export type FrontmatterResult =
  | { ok: true; data: Record<string, unknown>; warnings: string[]; sources: Record<string, string> }
  | { ok: false; error: string };

/**
 * Parses a frontmatter block as YAML 1.2 with the core schema: dates stay strings, explicit tags are not
 * resolved, duplicate keys are errors, and a cycle or a non-mapping is an error. `sources` keeps the text
 * of each top-level scalar as written, so `type: 123` can still be read as "123".
 */
export function parseFrontmatter(block: string): FrontmatterResult {
  const doc = parseDocument(block, {
    version: "1.2",
    schema: "core",
    uniqueKeys: true,
    resolveKnownTags: false,
    logLevel: "silent",
  });
  if (doc.errors.length > 0) {
    const messages = doc.errors.map((e) =>
      e.code === "DUPLICATE_KEY"
        ? `duplicate key: ${e.message.split("\n")[0]}`
        : e.message.split("\n")[0],
    );
    return { ok: false, error: messages.join("; ") };
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
    warnings: doc.warnings.map((w) => w.message.split("\n")[0] ?? ""),
    sources,
  };
}
