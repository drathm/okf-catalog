import type { Page, PagePath, Source, StaleAfter, Status, Trust } from "../bundle/model.js";

export interface Provenance {
  path: PagePath;
  title: string;
  type: string;
  status: Status;
  trust: Trust;
  generated?: { by: string; at?: string };
  verified: Array<{ by: string; at?: string }>;
  /** The verification with the latest instant, the one "how recently" means. */
  latestVerification?: { by: string; at?: string };
  staleAfter?: { raw: string; form: StaleAfter["form"]; overdue: boolean };
  sources: Source[];
  resource?: string;
  replacement?: PagePath;
  /** A copy of the page's frontmatter in full, so nothing the page carries is lost. */
  frontmatter: Record<string, unknown>;
}

/** A page is overdue from its recheck instant: the start of the UTC day for a date, the instant itself for a datetime. */
export function isOverdue(staleAfter: StaleAfter | undefined, now: Date): boolean {
  if (staleAfter?.at === undefined) return false;
  return now.getTime() >= staleAfter.at.getTime();
}

const asWritten = (v: { by: string; at?: { raw: string } }): { by: string; at?: string } =>
  v.at === undefined ? { by: v.by } : { by: v.by, at: v.at.raw };

/** The provenance view of a page. Returns copies, so a caller cannot change the catalog through it. */
export function provenanceOf(page: Page, now: Date): Provenance {
  const provenance: Provenance = {
    path: page.path,
    title: page.title,
    type: page.type,
    status: page.status,
    trust: page.trust,
    verified: page.verified.map(asWritten),
    sources: page.sources.map((s) => ({ ...s })),
    frontmatter: structuredClone(page.frontmatter),
  };
  if (page.generated !== undefined) provenance.generated = asWritten(page.generated);
  if (page.latestVerification !== undefined)
    provenance.latestVerification = asWritten(page.latestVerification);
  if (page.staleAfter !== undefined) {
    provenance.staleAfter = {
      raw: page.staleAfter.raw,
      form: page.staleAfter.form,
      overdue: isOverdue(page.staleAfter, now),
    };
  }
  if (page.resource !== undefined) provenance.resource = page.resource;
  if (page.replacement !== undefined) provenance.replacement = page.replacement;
  return provenance;
}
