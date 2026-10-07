import { z } from "zod/v4";
import type { Page, ReservedFile } from "../bundle/model.js";
import { byCodeUnit } from "../bundle/paths.js";
import type { SearchResponse } from "../search/search.js";
import { snippet } from "../search/snippet.js";
import type { Catalog } from "./model.js";
import { provenanceOf } from "./provenance.js";
import type { Generation, RuntimeStatus, ToolOptions } from "./runtime.js";
import {
  DATA_SENTENCE,
  hitLine,
  MARKER,
  pageHeader,
  reservedHeader,
  safe,
  searchHeader,
} from "./text.js";

/** Characters a result may carry before it is cut and told where to continue (Claude Code saves longer results to a file). */
export const RESULT_BUDGET = 40_000;
/** Entries a status list carries beside its count. */
export const STATUS_LIST_CAP = 50;
/** The most characters of a refusing text that reach the model, after escaping. */
export const REFUSING_CAP = 1_000;

/** A refusing text as the model may see it: made safe (one line, controls escaped) and cut at the cap. */
export function refusingText(text: string): string {
  const made = safe(text);
  if (made.length <= REFUSING_CAP) return made;
  const end = isHighSurrogate(made, REFUSING_CAP - 1) ? REFUSING_CAP - 1 : REFUSING_CAP;
  return `${made.slice(0, end)}…`;
}

export interface Cut {
  slice: string;
  truncated: boolean;
  nextOffset?: number;
}

const isHighSurrogate = (text: string, at: number): boolean => {
  const code = text.charCodeAt(at);
  return code >= 0xd800 && code <= 0xdbff;
};

/** The text from `offset`, cut at a line boundary within `budget` when it does not fit, never inside a surrogate pair. */
export function cutText(text: string, offset: number, budget: number): Cut {
  const from = Math.max(0, Math.floor(offset));
  if (from >= text.length) return { slice: "", truncated: false };
  const rest = text.slice(from);
  const room = Math.max(1, budget);
  if (rest.length <= room) return { slice: rest, truncated: false };
  const newline = rest.lastIndexOf("\n", room - 1);
  let end = newline > 0 ? newline + 1 : room;
  if (end > 1 && isHighSurrogate(rest, end - 1)) end -= 1;
  return { slice: rest.slice(0, end), truncated: true, nextOffset: from + end };
}

/** Characters a provenance's frontmatter may take in a result before it is replaced by a note. */
export const FRONTMATTER_BUDGET = 8_000;
/** Characters of a catalog entry's description kept in a result. */
const ENTRY_DESCRIPTION_CAP = 200;

const Status = z.enum(["draft", "stable", "deprecated"]);
const Trust = z.enum(["unverified", "machine-confirmed", "human-reviewed"]);
const Rung = z.enum(["all-terms", "relaxed"]);
const Form = z.enum(["date", "datetime", "unparseable"]);
const Verification = z.strictObject({ by: z.string(), at: z.string().optional() });
const SourceSchema = z.strictObject({
  resource: z.string(),
  id: z.string().optional(),
  title: z.string().optional(),
  author: z.string().optional(),
  usageCount: z.number().optional(),
  lastModified: z.string().optional(),
  usageWindow: z.strictObject({ from: z.string(), to: z.string() }).optional(),
});

export const ProvenanceSchema = z.strictObject({
  path: z.string(),
  title: z.string(),
  type: z.string(),
  status: Status,
  trust: Trust,
  generated: Verification.optional(),
  verified: z.array(Verification),
  latestVerification: Verification.optional(),
  staleAfter: z.strictObject({ raw: z.string(), form: Form, overdue: z.boolean() }).optional(),
  sources: z.array(SourceSchema),
  resource: z.string().optional(),
  replacement: z.string().optional(),
  frontmatter: z.record(z.string(), z.unknown()),
});

export const SearchOutputSchema = z.strictObject({
  hits: z.array(
    z.strictObject({
      path: z.string(),
      title: z.string(),
      type: z.string(),
      status: Status,
      trust: Trust,
      recheck: z.strictObject({
        raw: z.string().nullable(),
        form: Form.nullable(),
        overdue: z.boolean(),
      }),
      replacement: z.string().nullable(),
      sources: z.number(),
      resource: z.string().nullable(),
      rung: Rung,
      termsMatched: z.number().nullable(),
      snippet: z.string(),
      citation: z.string(),
    }),
  ),
  summary: z.string(),
  strategy: z.enum(["all-terms", "relaxed", "none"]),
  terms: z.array(z.string()),
  dropped: z.array(z.string()),
  floored: z.array(z.string()),
  considered: z.number(),
  filteredOut: z.strictObject({
    type: z.number(),
    topic: z.number(),
    stale: z.number(),
    unknown: z.number(),
  }),
  topicExhausted: z.boolean(),
});
export type SearchOutput = z.infer<typeof SearchOutputSchema>;

export const PageOutputSchema = z.strictObject({
  path: z.string(),
  kind: z.enum(["page", "index", "log"]),
  source: z.enum(["file", "generated"]).optional(),
  provenance: ProvenanceSchema.optional(),
  citation: z.string(),
  notice: z.string(),
  body: z.string(),
  truncated: z.boolean(),
  nextOffset: z.number().optional(),
});
export type PageOutput = z.infer<typeof PageOutputSchema>;

export const CatalogOutputSchema = z.strictObject({
  folder: z.string(),
  source: z.enum(["file", "generated"]),
  entries: z.array(
    z.strictObject({ path: z.string(), title: z.string(), description: z.string().nullable() }),
  ),
  notice: z.string(),
  text: z.string(),
  truncated: z.boolean(),
  nextOffset: z.number().optional(),
});
export type CatalogOutput = z.infer<typeof CatalogOutputSchema>;

const list = <T extends z.ZodTypeAny>(item: T) =>
  z.strictObject({ count: z.number(), first: z.array(item) });

export const StatusOutputSchema = z.strictObject({
  company: z.string(),
  source: z.string(),
  commit: z.string().nullable(),
  loadedAt: z.string(),
  dev: z.boolean(),
  integrity: z.enum(["checked", "skipped"]),
  admitted: z.number(),
  excludedByStatus: z.number(),
  attachments: z.number(),
  hidden: z.number(),
  /** Served pages past their recheck date at the time of the call (intent §6). */
  overdue: z.number(),
  refusals: list(z.strictObject({ path: z.string(), rule: z.string(), detail: z.string() })),
  degradations: list(z.strictObject({ path: z.string(), code: z.string(), field: z.string() })),
  unknownTypes: list(z.string()),
  unknownStatuses: list(z.strictObject({ path: z.string(), value: z.string() })),
  brokenLinks: list(z.strictObject({ from: z.string(), raw: z.string() })),
  linksToUnserved: list(z.strictObject({ from: z.string(), raw: z.string(), target: z.string() })),
  foldersWithoutIndex: list(z.string()),
  missingOnDisk: list(z.string()),
  fatal: z.strictObject({ rule: z.string(), path: z.string(), detail: z.string() }).nullable(),
  engine: z.strictObject({
    documents: z.number(),
    notIndexed: z.number(),
    collisions: z.number(),
    encodedFolders: list(z.string()),
    resetOnOpen: z.string().nullable(),
  }),
  lock: z.enum(["exclusive", "private"]),
  /** The process holding the company lock while this one runs in the private fallback. */
  lockOwner: z
    .strictObject({ pid: z.number(), startedAt: z.string(), alive: z.boolean() })
    .nullable(),
  /** The fetched commit of the published branch and when it was fetched; null for a local source. */
  published: z.strictObject({ commit: z.string(), fetchedAt: z.string() }).nullable(),
  poller: z
    .strictObject({
      intervalMs: z.number(),
      lastTick: z.string().nullable(),
      lastOutcome: z.enum(["unchanged", "refreshed", "failed", "gone", "skipped"]).nullable(),
    })
    .nullable(),
  lastAttempt: z
    .strictObject({ at: z.string(), outcome: z.enum(["swapped", "fatal", "failed"]) })
    .nullable(),
  /** The last load the loader refused: the commit when there is one, the rule, the path and the detail. */
  lastRefusal: z
    .strictObject({
      commit: z.string().nullable(),
      rule: z.string(),
      path: z.string(),
      detail: z.string(),
    })
    .nullable(),
  refusing: z.string().nullable(),
});
export type StatusOutput = z.infer<typeof StatusOutputSchema>;

export const NOTICE = `${MARKER} ${DATA_SENTENCE}`;

/** The search response as the tool returns it: every hit with its citation and snippet, the header as the summary. */
export function projectSearch(
  response: SearchResponse,
  catalog: Catalog,
  now: Date,
  options: { dev: boolean },
): SearchOutput {
  void now;
  const hits = response.hits.map((hit) => {
    const page = catalog.pages.get(hit.path);
    const text = snippet(page ?? {}, response.terms);
    return {
      path: hit.path,
      title: hit.title,
      type: hit.type,
      status: hit.status,
      trust: hit.trust,
      recheck: {
        raw: hit.staleAfter ?? null,
        form: page?.staleAfter?.form ?? null,
        overdue: hit.overdue,
      },
      replacement: hit.replacement ?? null,
      sources: hit.sources,
      resource: hit.resource ?? null,
      rung: hit.rung,
      termsMatched: hit.termsMatched ?? null,
      snippet: text,
      citation: hitLine(hit, text, page?.staleAfter?.form),
    };
  });
  return SearchOutputSchema.parse({
    hits,
    summary: searchHeader(response, options.dev),
    strategy: response.strategy,
    terms: response.terms,
    dropped: response.dropped,
    floored: response.floored,
    considered: response.considered,
    filteredOut: response.filteredOut,
    topicExhausted: response.topicExhausted,
  });
}

/** Room left for a body once the citation, the notice and a truncation tail are counted inside the budget. */
const bodyRoom = (budget: number, citation: string): number =>
  Math.max(1, budget - citation.length - NOTICE.length - 80);

export function projectPage(page: Page, now: Date, offset: number, budget: number): PageOutput {
  const citation = pageHeader(page, now);
  const cut = cutText(page.body, offset, bodyRoom(budget, citation));
  const provenance = provenanceOf(page, now);
  if (JSON.stringify(provenance.frontmatter).length > FRONTMATTER_BUDGET) {
    provenance.frontmatter = {
      omitted: `the frontmatter is over ${FRONTMATTER_BUDGET} characters and is not returned here`,
    };
  }
  const output: PageOutput = {
    path: page.path,
    kind: "page",
    provenance,
    citation,
    notice: NOTICE,
    body: cut.slice,
    truncated: cut.truncated,
  };
  if (cut.nextOffset !== undefined) output.nextOffset = cut.nextOffset;
  return PageOutputSchema.parse(output);
}

export function projectReserved(
  file: ReservedFile,
  source: "file" | "generated",
  offset: number,
  budget: number,
): PageOutput {
  const citation = reservedHeader(file.kind, source, file.folder);
  const cut = cutText(file.body, offset, bodyRoom(budget, citation));
  const output: PageOutput = {
    path: file.path,
    kind: file.kind,
    source,
    citation,
    notice: NOTICE,
    body: cut.slice,
    truncated: cut.truncated,
  };
  if (cut.nextOffset !== undefined) output.nextOffset = cut.nextOffset;
  return PageOutputSchema.parse(output);
}

/**
 * A folder's catalog: its entries from the catalog's own pages and the index text framed by the marker, the whole
 * result held within the budget. `offset` counts entries first, then characters of the text: a cut result says
 * where to continue, and the continuation carries the remaining entries, then the remaining text. Undefined for
 * an unknown folder.
 */
export function projectCatalog(
  catalog: Catalog,
  folder: string,
  offset: number,
  budget: number,
): CatalogOutput | undefined {
  const entry = catalog.folders.get(folder);
  if (entry === undefined) return undefined;
  const all = [...entry.pages].sort(byCodeUnit).map((path) => {
    const page = catalog.pages.get(path);
    const description = page?.description ?? null;
    return {
      path,
      title: page?.title ?? path,
      description:
        description !== null && description.length > ENTRY_DESCRIPTION_CAP
          ? `${description.slice(0, ENTRY_DESCRIPTION_CAP)}…`
          : description,
    };
  });
  const from = Math.max(0, Math.floor(offset));
  const base: Omit<CatalogOutput, "entries" | "text" | "truncated"> = {
    folder,
    source: entry.indexSource,
    notice: NOTICE,
  };
  const frame =
    JSON.stringify({ ...base, entries: [], text: "", truncated: true, nextOffset: 0 }).length + 80;
  const entries: CatalogOutput["entries"] = [];
  let used = frame;
  let index = Math.min(from, all.length);
  while (index < all.length) {
    const item = all[index] as CatalogOutput["entries"][number];
    const cost = JSON.stringify(item).length + 1;
    if (used + cost > budget && entries.length > 0) break;
    entries.push(item);
    used += cost;
    index += 1;
  }
  const fullText = `${MARKER}\n${entry.index?.body ?? ""}`;
  // Text offsets start where the entries end: `all.length` entries consumed, then characters of the text.
  const textFrom = Math.max(0, from - all.length);
  const output: CatalogOutput = {
    ...base,
    entries,
    text: "",
    truncated: false,
  };
  if (index < all.length) {
    // The entries alone filled the budget: the text comes with a later continuation.
    output.truncated = true;
    output.nextOffset = index;
    return CatalogOutputSchema.parse(output);
  }
  const cut = cutText(fullText, textFrom, Math.max(1, budget - used));
  output.text = cut.slice;
  output.truncated = cut.truncated;
  if (cut.nextOffset !== undefined) output.nextOffset = all.length + cut.nextOffset;
  return CatalogOutputSchema.parse(output);
}

const capped = <T>(items: readonly T[]): { count: number; first: T[] } => ({
  count: items.length,
  first: items.slice(0, STATUS_LIST_CAP),
});

export function projectStatus(
  generation: Generation,
  runtime: RuntimeStatus,
  options: ToolOptions,
  now: Date,
): StatusOutput {
  const r = generation.report;
  let overdue = 0;
  for (const page of generation.catalog.pages.values()) {
    if (page.staleAfter?.at !== undefined && now.getTime() >= page.staleAfter.at.getTime())
      overdue += 1;
  }
  return StatusOutputSchema.parse({
    company: options.company,
    source: options.source,
    commit: r.commit ?? null,
    loadedAt: generation.loadedAt.toISOString(),
    dev: generation.dev,
    integrity: generation.integrity,
    admitted: r.admitted,
    excludedByStatus: r.excludedByStatus,
    attachments: r.attachments,
    hidden: r.hidden,
    overdue,
    refusals: capped(r.refusals.map((x) => ({ path: x.path, rule: x.rule, detail: x.detail }))),
    degradations: capped(
      r.degradations.map((x) => ({ path: x.path, code: x.code, field: x.field })),
    ),
    unknownTypes: capped(r.unknownTypes),
    unknownStatuses: capped(r.unknownStatuses),
    brokenLinks: capped(r.brokenLinks),
    linksToUnserved: capped(r.linksToUnserved),
    foldersWithoutIndex: capped(r.foldersWithoutIndex),
    missingOnDisk: capped(r.missingOnDisk),
    fatal:
      r.fatal === undefined
        ? null
        : { rule: r.fatal.rule, path: r.fatal.path, detail: r.fatal.detail },
    engine: {
      documents: generation.index.documents,
      notIndexed: generation.index.notIndexed.length,
      collisions: generation.index.collisions.length,
      encodedFolders: capped(generation.index.encodedFolders),
      resetOnOpen: runtime.resetOnOpen === undefined ? null : safe(runtime.resetOnOpen),
    },
    lock: runtime.lock,
    lockOwner:
      runtime.lockOwner === undefined || runtime.lockOwner === null
        ? null
        : {
            pid: runtime.lockOwner.pid,
            startedAt: safe(runtime.lockOwner.startedAt),
            alive: runtime.lockOwner.alive,
          },
    published:
      generation.published === undefined
        ? null
        : {
            commit: generation.published.commit,
            fetchedAt: generation.published.fetchedAt.toISOString(),
          },
    poller:
      runtime.poller === undefined || runtime.poller === null
        ? null
        : {
            intervalMs: runtime.poller.intervalMs,
            lastTick: runtime.poller.lastTick?.toISOString() ?? null,
            lastOutcome: runtime.poller.lastOutcome ?? null,
          },
    lastAttempt:
      runtime.lastAttempt === undefined
        ? null
        : { at: runtime.lastAttempt.at.toISOString(), outcome: runtime.lastAttempt.outcome },
    lastRefusal:
      runtime.lastRefusal === undefined
        ? null
        : {
            commit: runtime.lastRefusal.commit ?? null,
            rule: safe(runtime.lastRefusal.rule),
            path: safe(runtime.lastRefusal.path),
            detail: safe(runtime.lastRefusal.detail),
          },
    refusing: runtime.refusing === undefined ? null : refusingText(runtime.refusing),
  });
}

/** One line for the `status` text block: the counts, the engine, the lock, the last attempt, and the report's lists as counts. */
export function statusSummary(out: StatusOutput): string {
  const n = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;
  const parts = [
    `${out.company}: ${out.admitted} pages admitted, ${out.excludedByStatus} excluded by status, ${n(out.overdue, "overdue page")}, ${n(out.refusals.count, "refusal")}, ${n(out.degradations.count, "degradation")}`,
    `integrity ${out.integrity}`,
    `${out.engine.documents} documents indexed, ${out.engine.notIndexed} not indexed, ${n(out.engine.collisions, "collision")}`,
    out.lock === "private"
      ? out.lockOwner === null
        ? "lock private (holder unreadable)"
        : `lock private (held by pid ${out.lockOwner.pid} since ${out.lockOwner.startedAt}, ${out.lockOwner.alive ? "alive" : "not alive"})`
      : `lock ${out.lock}`,
    `loaded ${out.loadedAt}`,
    ...(out.published === null
      ? []
      : [`published ${out.published.commit.slice(0, 12)} fetched ${out.published.fetchedAt}`]),
    ...(out.poller === null
      ? []
      : [
          `poller every ${Math.round(out.poller.intervalMs / 1000)} s${out.poller.lastTick === null ? ", no tick yet" : `, last tick ${out.poller.lastOutcome ?? "?"} at ${out.poller.lastTick}`}`,
        ]),
    ...(out.engine.resetOnOpen === null
      ? []
      : [`engine store rebuilt at open: ${out.engine.resetOnOpen}`]),
    `${n(out.unknownTypes.count, "unknown type")}, ${n(out.unknownStatuses.count, "unknown status")}, ${n(out.brokenLinks.count, "broken link")}, ${n(out.linksToUnserved.count, "link to an unserved page")}, ${n(out.foldersWithoutIndex.count, "folder without an index")}, ${n(out.missingOnDisk.count, "manifest entry missing on disk")}`,
  ];
  if (out.lastAttempt !== null)
    parts.push(`last attempt ${out.lastAttempt.outcome} at ${out.lastAttempt.at}`);
  if (out.lastRefusal !== null)
    parts.push(
      `last refusal ${out.lastRefusal.commit === null ? "" : `${out.lastRefusal.commit.slice(0, 12)} `}${out.lastRefusal.rule}${out.lastRefusal.path ? ` (${out.lastRefusal.path})` : ""}`,
    );
  if (out.fatal !== null) {
    parts.push(
      `FATAL ${safe(out.fatal.rule)}${out.fatal.path ? ` (${safe(out.fatal.path)})` : ""}: ${safe(out.fatal.detail)}`,
    );
  }
  if (out.refusing !== null) parts.push(`refusing: ${safe(out.refusing)}`);
  return parts.join("; ");
}
