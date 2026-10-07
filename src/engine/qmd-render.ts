/**
 * The pure half of the qmd adapter: the text qmd indexes for a derived document, and the codec that keeps
 * bundle paths out of the way of qmd's indexer. Imports no qmd, so golden tests and `check` can use it.
 */
import { stringify } from "yaml";
import type { DerivedDocument } from "../derive/derived-document.js";

/** Folder names qmd's indexer skips at any depth, exact and case-sensitive. */
export const SKIPPED_SEGMENTS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  ".cache",
  "vendor",
  "dist",
  "build",
]);

const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();

/**
 * `# <title>` first, because qmd takes the first heading as the title and weights it four times the body; then
 * the description, the type value and the tag values on their own lines, with no label words, since a word
 * present in every page would be a universal token; then a blank line and the body.
 */
export function renderDocument(
  doc: DerivedDocument,
  options: { metadataBlock?: boolean } = {},
): string {
  const lines = [`# ${collapse(doc.title)}`];
  const description = doc.description === undefined ? "" : collapse(doc.description);
  if (description.length > 0) lines.push(description);
  const type = collapse(doc.type);
  if (type.length > 0) lines.push(type);
  const tags = doc.tags.map(collapse).filter((t) => t.length > 0);
  if (tags.length > 0) lines.push(tags.join(" "));
  const body = `${lines.join("\n")}\n\n${doc.body}`;
  if (options.metadataBlock !== true) return body;
  return `---\n${stringify({ qmd: { metadata: doc.metadata } })}---\n${body}`;
}

/** `%`, `\` and `:` are percent-encoded: qmd splits on the backslash and reads a leading `X:` as a Windows drive. */
function encodeSegment(segment: string): string {
  const escaped = segment.replace(/%/g, "%25").replace(/\\/g, "%5C").replace(/:/g, "%3A");
  return SKIPPED_SEGMENTS.has(escaped) || escaped.startsWith("_") ? `_${escaped}` : escaped;
}

function decodeSegment(segment: string): string {
  const unprefixed = segment.startsWith("_") ? segment.slice(1) : segment;
  return unprefixed.replace(/%3A/g, ":").replace(/%5C/g, "\\").replace(/%25/g, "%");
}

/** A bundle path as it is written into the generation tree. */
export function encodePath(path: string): string {
  return path.split("/").map(encodeSegment).join("/");
}

/** A generation-tree path back to its bundle path. */
export function decodePath(path: string): string {
  return path.split("/").map(decodeSegment).join("/");
}
