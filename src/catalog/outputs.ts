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
  searchHeader,
} from "./text.js";

/** Characters a result may carry before it is cut and told where to continue (Claude Code saves longer results to a file). */
export const RESULT_BUDGET = 40_000;
/** Entries a status list carries beside its count. */
export const STATUS_LIST_CAP = 50;

export interface Cut {
  slice: string;
  truncated: boolean;
  nextOffset?: number;
}

/** The text from `offset`, cut at a line boundary within `budget` when it does not fit. */
export function cutText(text: string, offset: number, budget: number): Cut {
  const from = Math.max(0, Math.floor(offset));
  if (from >= text.length) return { slice: "", truncated: false };
  const rest = text.slice(from);
  if (rest.length <= budget) return { slice: rest, truncated: false };
  const newline = rest.lastIndexOf("\n", budget - 1);
  const end = newline > 0 ? newline + 1 : budget;
  return { slice: rest.slice(0, end), truncated: true, nextOffset: from + end };
}

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
    encodedFolders: z.array(z.string()),
    resetOnOpen: z.string().nullable(),
  }),
  lock: z.enum(["exclusive", "private"]),
  lastAttempt: z
    .strictObject({ at: z.string(), outcome: z.enum(["swapped", "fatal", "failed"]) })
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

export function projectPage(page: Page, now: Date, offset: number, budget: number): PageOutput {
  const cut = cutText(page.body, offset, budget);
  const output: PageOutput = {
    path: page.path,
    kind: "page",
    provenance: provenanceOf(page, now),
    citation: pageHeader(page, now),
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
  const cut = cutText(file.body, offset, budget);
  const output: PageOutput = {
    path: file.path,
    kind: file.kind,
    source,
    citation: reservedHeader(file.kind, source, file.folder),
    notice: NOTICE,
    body: cut.slice,
    truncated: cut.truncated,
  };
  if (cut.nextOffset !== undefined) output.nextOffset = cut.nextOffset;
  return PageOutputSchema.parse(output);
}

/** A folder's catalog: its entries from the catalog's own pages, and the index text framed by the marker. Undefined for an unknown folder. */
export function projectCatalog(
  catalog: Catalog,
  folder: string,
  offset: number,
  budget: number,
): CatalogOutput | undefined {
  const entry = catalog.folders.get(folder);
  if (entry === undefined) return undefined;
  const entries = [...entry.pages].sort(byCodeUnit).map((path) => {
    const page = catalog.pages.get(path);
    return { path, title: page?.title ?? path, description: page?.description ?? null };
  });
  const text = `${MARKER}\n${entry.index?.body ?? ""}`;
  const cut = cutText(text, offset, budget);
  const output: CatalogOutput = {
    folder,
    source: entry.indexSource,
    entries,
    notice: NOTICE,
    text: cut.slice,
    truncated: cut.truncated,
  };
  if (cut.nextOffset !== undefined) output.nextOffset = cut.nextOffset;
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
): StatusOutput {
  const r = generation.report;
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
      encodedFolders: generation.index.encodedFolders,
      resetOnOpen: null,
    },
    lock: runtime.lock,
    lastAttempt:
      runtime.lastAttempt === undefined
        ? null
        : { at: runtime.lastAttempt.at.toISOString(), outcome: runtime.lastAttempt.outcome },
    refusing: runtime.refusing ?? null,
  });
}

/** One line for the `status` text block. */
export function statusSummary(out: StatusOutput): string {
  const parts = [
    `${out.company}: ${out.admitted} pages admitted, ${out.excludedByStatus} excluded by status, ${out.refusals.count} refused, ${out.degradations.count} degraded`,
    `integrity ${out.integrity}`,
    `${out.engine.documents} documents indexed`,
    `lock ${out.lock}`,
    `loaded ${out.loadedAt}`,
  ];
  if (out.fatal !== null)
    parts.push(
      `FATAL ${out.fatal.rule}${out.fatal.path ? ` (${out.fatal.path})` : ""}: ${out.fatal.detail}`,
    );
  if (out.refusing !== null) parts.push(`refusing: ${out.refusing}`);
  return parts.join("; ");
}
