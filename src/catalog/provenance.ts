import type {
  Contract,
  Page,
  PagePath,
  Source,
  StaleAfter,
  Trust,
  UsageWindow,
} from "../bundle/model.js";

/** The window that frames a source's `usage_count`, and whether it is the page's shared one (§5.1). */
export interface EffectiveWindow {
  from: string;
  to: string;
  inherited: boolean;
}

export interface Provenance {
  path: PagePath;
  title: string;
  type: string;
  status: string;
  trust: Trust;
  generated?: { by: string; at?: string };
  verified: Array<{ by: string; at?: string }>;
  /** The verification with the latest instant, the one "how recently" means. */
  latestVerification?: { by: string; at?: string };
  staleAfter?: { raw: string; form: StaleAfter["form"]; overdue: boolean };
  /** Each source as written, with the window that frames its count, computed here and never stored (D62). */
  sources: Array<Source & { effectiveWindow?: EffectiveWindow }>;
  /** The page's shared window, kept apart from the frontmatter so it survives that object's omission. */
  usageWindow?: UsageWindow;
  /** The contract fields (§10.2), typed, for a page of any type. */
  contract?: Contract;
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

/**
 * The one inheritance rule for a source's usage window (§5.1, D62): the entry's own window when it carries one,
 * else the page's shared `usage_window`, saying which; none when neither exists. Computed when a page is projected;
 * the stored sources are never given a copy.
 */
export function effectiveWindow(
  source: Source,
  pageWindow: UsageWindow | undefined,
): EffectiveWindow | undefined {
  if (source.usageWindow !== undefined) return { ...source.usageWindow, inherited: false };
  if (pageWindow !== undefined) return { ...pageWindow, inherited: true };
  return undefined;
}

/** The provenance view of a page. Returns copies, so a caller cannot change the catalog through it. */
export function provenanceOf(page: Page, now: Date): Provenance {
  const provenance: Provenance = {
    path: page.path,
    title: page.title,
    type: page.type,
    status: page.status,
    trust: page.trust,
    verified: page.verified.map(asWritten),
    sources: page.sources.map((s) => {
      const window = effectiveWindow(s, page.usageWindow);
      return window === undefined
        ? structuredClone(s)
        : { ...structuredClone(s), effectiveWindow: window };
    }),
    frontmatter: structuredClone(page.frontmatter),
  };
  if (page.usageWindow !== undefined) provenance.usageWindow = { ...page.usageWindow };
  if (page.contract !== undefined) provenance.contract = structuredClone(page.contract);
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
