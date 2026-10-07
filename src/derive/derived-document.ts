import type { Page, PagePath } from "../bundle/model.js";

/** What the engine indexes for one page: the fields that carry signal, the OKF metadata, and the body. */
export interface DerivedDocument {
  path: PagePath;
  title: string;
  description?: string;
  type: string;
  tags: string[];
  metadata: Record<string, string | string[] | number>;
  body: string;
}

const normalise = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

/** Removes a leading heading whose text equals the title, so the rendered copy carries the title once. */
function withoutDuplicateHeading(body: string, title: string): string {
  const match = /^\s*#{1,6}[ \t]+([^\n]*?)[ \t]*#*[ \t]*\n+/.exec(body);
  if (match === null || normalise(match[1] ?? "") !== normalise(title)) return body;
  return body.slice(match[0].length);
}

export function deriveDocument(page: Page): DerivedDocument {
  const metadata: Record<string, string | string[] | number> = {
    okf_type: page.type,
    okf_status: page.status,
    okf_tags: page.tags,
  };
  if (page.staleAfter !== undefined) metadata.okf_stale_after = page.staleAfter.raw;
  metadata.okf_trust = page.trust;
  if (page.latestVerification !== undefined) metadata.okf_verified_by = page.latestVerification.by;
  metadata.okf_source_count = page.sources.length;
  const doc: DerivedDocument = {
    path: page.path,
    title: page.title,
    type: page.type,
    tags: page.tags,
    metadata,
    body: withoutDuplicateHeading(page.body, page.title),
  };
  if (page.description !== undefined) doc.description = page.description;
  return doc;
}
