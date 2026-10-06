import type { LinkKind } from "./model.js";

export interface LinkIndex {
  pages: Set<string>;
  reserved: Set<string>;
  attachments: Set<string>;
  folders: Set<string>;
}

export type ResolvedLink = { kind: LinkKind; target?: string };

const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/**
 * Resolves a Markdown link against the bundle. Bundle-absolute links start with a slash; relative links
 * resolve against the page's folder. Fragments and queries are dropped, segments are percent-decoded, and
 * a path that climbs above the root is broken. The result says what the link points at: a page, a folder,
 * a reserved file, an attachment, a same-page anchor, something external, or nothing.
 */
export function resolveLink(url: string, fromPath: string, index: LinkIndex): ResolvedLink {
  const trimmed = url.trim();
  if (trimmed.startsWith("#")) return { kind: "anchor" };
  if (SCHEME.test(trimmed) || trimmed.startsWith("//")) return { kind: "external" };
  const withoutFragment = trimmed.split("#")[0]?.split("?")[0] ?? "";
  if (withoutFragment.length === 0) return { kind: "broken" };
  const folderHint = withoutFragment.endsWith("/");
  const absolute = withoutFragment.startsWith("/");
  const base = absolute ? [] : fromPath.split("/").slice(0, -1);
  const stack = [...base];
  for (const rawSegment of withoutFragment.split("/")) {
    if (rawSegment === "" || rawSegment === ".") continue;
    if (rawSegment === "..") {
      if (stack.length === 0) return { kind: "broken" };
      stack.pop();
      continue;
    }
    let segment: string;
    try {
      segment = decodeURIComponent(rawSegment);
    } catch {
      return { kind: "broken" };
    }
    stack.push(segment);
  }
  const target = stack.join("/");
  if (folderHint) {
    if (index.folders.has(target) || index.reserved.has(`${target}/index.md`))
      return { kind: "folder", target };
    return { kind: "broken" };
  }
  if (index.pages.has(target)) return { kind: "page", target };
  if (index.reserved.has(target)) return { kind: "reserved", target };
  if (index.attachments.has(target)) return { kind: "attachment", target };
  if (index.folders.has(target)) return { kind: "folder", target };
  return { kind: "broken" };
}
