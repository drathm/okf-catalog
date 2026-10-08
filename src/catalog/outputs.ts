import { z } from "zod/v4";
import type { Page, ReservedFile } from "../bundle/model.js";
import { byCodeUnit } from "../bundle/paths.js";
import type { SearchResponse } from "../search/search.js";
import { snippet } from "../search/snippet.js";
import { type Citations, LIST_CAP, type Walk, type WalkEdge, type WalkNode } from "./graph.js";
import type { Catalog } from "./model.js";
import { type EffectiveWindow, provenanceOf } from "./provenance.js";
import type { Generation, RuntimeStatus, ToolOptions } from "./runtime.js";
import {
  citationsHeader,
  claimLine,
  DATA_SENTENCE,
  derivationLine,
  hitLine,
  inboundMentionLine,
  type LineOptions,
  listHeading,
  MARKER,
  mentionLine,
  pageHeader,
  provenanceHeader,
  reservedHeader,
  safe,
  searchHeader,
  sourceLine,
  unjoinedLine,
  walkEdgeLine,
  walkNodeLine,
} from "./text.js";

/** Characters a result may carry before it is cut and told where to continue (Claude Code saves longer results to a file). */
export const RESULT_BUDGET = 40_000;
/** Entries a status list carries beside its count; the citation lists and a provenance node's sources share it. */
export const STATUS_LIST_CAP = LIST_CAP;
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
/**
 * Characters each typed field rescued from the frontmatter (the contract's five, the usage windows, the v0.1
 * timestamp) may take, serialised, before it is replaced by a note of its own (D78), so no field is a second
 * unbounded channel and one long field never hides the rest.
 */
export const TYPED_FIELD_BUDGET = 2_000;
/** Characters of a catalog entry's description kept in a result. */
const ENTRY_DESCRIPTION_CAP = 200;

/** Any word: the three known values, or the company's own word for a page it admits (D61, D77). */
const Status = z.string();
const Trust = z.enum(["unverified", "machine-confirmed", "human-reviewed"]);
const Rung = z.enum(["all-terms", "relaxed"]);
const Form = z.enum(["date", "datetime", "unparseable"]);
const Verification = z.strictObject({ by: z.string(), at: z.string().optional() });
/** The note a typed field over its budget is replaced by (D78), the frontmatter note's form. */
const Omitted = z.strictObject({ omitted: z.string() });
const orOmitted = <T extends z.ZodTypeAny>(schema: T) => z.union([schema, Omitted]);
const Window = z.strictObject({ from: z.string(), to: z.string() });
/** The window that frames a source's count, its own or the page's (D62), or its note past the cap (D78). */
const EffectiveWindowSchema = orOmitted(
  z.strictObject({ from: z.string(), to: z.string(), inherited: z.boolean() }),
);
const SourceSchema = z.strictObject({
  resource: z.string(),
  id: z.string().optional(),
  title: z.string().optional(),
  author: z.string().optional(),
  usageCount: z.number().optional(),
  lastModified: z.string().optional(),
  usageWindow: Window.optional(),
  effectiveWindow: EffectiveWindowSchema.optional(),
});
const ContractSchema = z.strictObject({
  runtime: orOmitted(z.string()).optional(),
  parameters: orOmitted(
    z.array(
      z.strictObject({
        name: z.string(),
        type: z.string().optional(),
        required: z.boolean().optional(),
      }),
    ),
  ).optional(),
  computation: orOmitted(z.string()).optional(),
  executor: orOmitted(
    z.strictObject({ resource: z.string().optional(), receipt: z.array(z.string()).optional() }),
  ).optional(),
  attester: orOmitted(z.strictObject({ resource: z.string().optional() })).optional(),
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
  /** How many verifications and sources the page has; the lists hold those that fit half the result budget (D82). */
  verifiedTotal: z.number(),
  sourcesTotal: z.number(),
  usageWindow: orOmitted(Window).optional(),
  contract: ContractSchema.optional(),
  timestamp: orOmitted(z.string()).optional(),
  resource: z.string().optional(),
  replacement: z.string().optional(),
  frontmatter: z.record(z.string(), z.unknown()),
});
type ProjectedProvenance = z.infer<typeof ProvenanceSchema>;

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
    tag: z.number(),
    status: z.number(),
    trust: z.number(),
    stale: z.number(),
    unknown: z.number(),
  }),
  topicExhausted: z.boolean(),
  filtersExhausted: z.boolean(),
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

/** A list of `citations`: at most 50 rows, in its order, beside the total it had before any cut (issue 5, D82). */
const cappedList = <T extends z.ZodTypeAny>(row: T) =>
  z.strictObject({ total: z.number(), rows: z.array(row) });
const SourceFactsSchema = z.strictObject({
  id: z.string().optional(),
  resource: z.string(),
  title: z.string().optional(),
  author: z.string().optional(),
  usageCount: z.number().optional(),
  lastModified: z.string().optional(),
  window: EffectiveWindowSchema.optional(),
});

export const CitationsOutputSchema = z.strictObject({
  path: z.string(),
  summary: z.string(),
  notice: z.string(),
  /** The body was not analysed, or only its first part: mentions and claims cover what was. */
  partial: z.boolean(),
  /** The result budget cut rows: each list keeps its order and its total. */
  truncated: z.boolean(),
  mentions: cappedList(
    z.strictObject({
      kind: z.enum([
        "page",
        "unserved",
        "folder",
        "reserved",
        "attachment",
        "anchor",
        "external",
        "broken",
      ]),
      raw: z.string(),
      target: z.string().optional(),
      text: z.string(),
      heading: z.string().optional(),
    }),
  ),
  inboundMentions: cappedList(
    z.strictObject({ from: z.string(), text: z.string(), heading: z.string().optional() }),
  ),
  claims: cappedList(
    z.strictObject({
      footnote: z.string(),
      block: z.string(),
      heading: z.string().optional(),
      sources: z.array(SourceFactsSchema),
    }),
  ),
  bibliography: cappedList(SourceFactsSchema),
  unjoined: cappedList(
    z.strictObject({ footnote: z.string(), block: z.string(), heading: z.string().optional() }),
  ),
  inboundDerivations: cappedList(
    z.strictObject({
      from: z.string(),
      field: z.string(),
      kind: z.enum(["concept", "ambiguous"]),
      author: z.string().optional(),
      usageCount: z.number().optional(),
      lastModified: z.string().optional(),
      window: EffectiveWindowSchema.optional(),
    }),
  ),
});
export type CitationsOutput = z.infer<typeof CitationsOutputSchema>;

const WalkEdgeSchema = z.strictObject({
  role: z.enum(["resource", "source", "computation", "executor", "attester"]),
  field: z.string(),
  raw: z.string(),
  kind: z.enum([
    "url",
    "concept",
    "reserved",
    "attachment",
    "folder",
    "ambiguous",
    "unserved",
    "scope",
    "unresolved",
  ]),
  target: z.string().optional(),
  candidates: z.array(z.string()).optional(),
  fromRoot: z.boolean().optional(),
  id: z.string().optional(),
  title: z.string().optional(),
  author: z.string().optional(),
  usageCount: z.number().optional(),
  lastModified: z.string().optional(),
  window: EffectiveWindowSchema.optional(),
  walk: z.enum(["entered", "already-entered", "cycle", "depth-limit", "concept-limit"]).optional(),
});

export const ProvenanceOutputSchema = z.strictObject({
  path: z.string(),
  depth: z.number(),
  summary: z.string(),
  notice: z.string(),
  /** The walk's pages in the order they were entered; the start page first. */
  nodes: z.array(
    z.strictObject({
      path: z.string(),
      level: z.number(),
      parent: z.string().optional(),
      trust: Trust,
      recheck: z.strictObject({ raw: z.string(), form: Form, overdue: z.boolean() }).optional(),
      sourcesTotal: z.number(),
      /** The depth stopped this branch. */
      truncated: z.boolean(),
      edges: z.array(WalkEdgeSchema),
    }),
  ),
  nodesTotal: z.number(),
  /** The walk entered its 200 concepts and entered no more (D71). */
  capped: z.boolean(),
  /** The result budget cut the walk: `nodes` holds its first pages, the last perhaps with its first edges only. */
  truncated: z.boolean(),
});
export type ProvenanceOutput = z.infer<typeof ProvenanceOutputSchema>;

export const NOTICE = `${MARKER} ${DATA_SENTENCE}`;

/** The search response as the tool returns it: every hit with its citation and snippet, the header as the summary. */
export function projectSearch(
  response: SearchResponse,
  catalog: Catalog,
  now: Date,
  options: { dev: boolean } & LineOptions,
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
      citation: hitLine(hit, text, page?.staleAfter?.form, options),
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
    filtersExhausted: response.filtersExhausted,
  });
}

/** A typed field as a result carries it: whole within its budget, else its own note (D78). */
function typedField<T>(field: string, value: T): T | { omitted: string } {
  return JSON.stringify(value).length > TYPED_FIELD_BUDGET
    ? {
        omitted: `the ${field} field is over ${TYPED_FIELD_BUDGET} characters and is not returned here`,
      }
    : value;
}

/**
 * The provenance as `get_page` returns it: the frontmatter replaced by its note past its budget, and every typed
 * field held to its own budget, so a page's typed fields survive the frontmatter's omission (D62, D78).
 */
function projectProvenance(page: Page, now: Date): ProjectedProvenance {
  const { sources, usageWindow, contract, timestamp, ...rest } = provenanceOf(page, now);
  const projected: ProjectedProvenance = {
    ...rest,
    sources: sources.map(({ effectiveWindow, ...source }) =>
      effectiveWindow === undefined
        ? source
        : { ...source, effectiveWindow: typedField("effectiveWindow", effectiveWindow) },
    ),
    verifiedTotal: rest.verified.length,
    sourcesTotal: sources.length,
  };
  if (JSON.stringify(projected.frontmatter).length > FRONTMATTER_BUDGET) {
    projected.frontmatter = {
      omitted: `the frontmatter is over ${FRONTMATTER_BUDGET} characters and is not returned here`,
    };
  }
  if (usageWindow !== undefined) projected.usageWindow = typedField("usageWindow", usageWindow);
  if (timestamp !== undefined) projected.timestamp = typedField("timestamp", timestamp);
  if (contract !== undefined) {
    const typed: NonNullable<ProjectedProvenance["contract"]> = {};
    if (contract.runtime !== undefined) typed.runtime = typedField("runtime", contract.runtime);
    if (contract.parameters !== undefined)
      typed.parameters = typedField("parameters", contract.parameters);
    if (contract.computation !== undefined)
      typed.computation = typedField("computation", contract.computation);
    if (contract.executor !== undefined) typed.executor = typedField("executor", contract.executor);
    if (contract.attester !== undefined) typed.attester = typedField("attester", contract.attester);
    projected.contract = typed;
  }
  return projected;
}

/** Room left for a body once the citation, the notice and a truncation tail are counted inside the budget. */
const bodyRoom = (budget: number, citation: string): number =>
  Math.max(1, budget - citation.length - NOTICE.length - 80);

/**
 * `get_page`'s provenance within its share of the budget (D82): whole when it fits, else `verified` then
 * `sources` kept in their order until the share is spent, the totals saying how many there are.
 */
function fitProvenance(projected: ProjectedProvenance, share: number): ProjectedProvenance {
  if (JSON.stringify(projected).length <= share) return projected;
  const kept: ProjectedProvenance = { ...projected, verified: [], sources: [] };
  let used = JSON.stringify(kept).length;
  for (const verification of projected.verified) {
    const cost = JSON.stringify(verification).length + 1;
    if (used + cost > share) return kept;
    kept.verified.push(verification);
    used += cost;
  }
  for (const source of projected.sources) {
    const cost = JSON.stringify(source).length + 1;
    if (used + cost > share) return kept;
    kept.sources.push(source);
    used += cost;
  }
  return kept;
}

/**
 * A body cut from `offset` to fit both channels: `textRoom` raw characters for the text block and `jsonRoom`
 * characters once escaped for the structured output, which counts a quotation mark or a line break twice. When the
 * rest of the structured result alone passes the budget (`jsonRoom` not positive), the text block decides.
 */
function cutBody(body: string, offset: number, textRoom: number, jsonRoom: number): Cut {
  let room = Math.max(2, jsonRoom > 0 ? Math.min(textRoom, jsonRoom) : textRoom);
  let cut = cutText(body, offset, room);
  while (jsonRoom > 0 && room > 2) {
    const excess = JSON.stringify(cut.slice).length - 2 - jsonRoom;
    if (excess <= 0) break;
    room = Math.max(2, room - excess);
    cut = cutText(body, offset, room);
  }
  return cut;
}

/** The room a body has in the structured result: the budget less the result with an empty body. */
const jsonRoomOf = (frame: PageOutput, budget: number): number =>
  budget -
  JSON.stringify({ ...frame, body: "", truncated: true, nextOffset: Number.MAX_SAFE_INTEGER })
    .length;

/**
 * A page as `get_page` returns it, the whole result within the budget in both channels (D82): the provenance
 * takes at most half, its `verified` then `sources` cut in order with their totals, and the header names the
 * sources the provenance kept; the body takes the rest and says where to continue.
 */
export function projectPage(
  page: Page,
  now: Date,
  offset: number,
  budget: number,
  options: LineOptions = {},
): PageOutput {
  const provenance = fitProvenance(projectProvenance(page, now), Math.floor(budget / 2));
  const citation = pageHeader(page, now, { ...options, sourcesShown: provenance.sources.length });
  const output: PageOutput = {
    path: page.path,
    kind: "page",
    provenance,
    citation,
    notice: NOTICE,
    body: "",
    truncated: false,
  };
  const cut = cutBody(page.body, offset, bodyRoom(budget, citation), jsonRoomOf(output, budget));
  output.body = cut.slice;
  output.truncated = cut.truncated;
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
  const output: PageOutput = {
    path: file.path,
    kind: file.kind,
    source,
    citation,
    notice: NOTICE,
    body: "",
    truncated: false,
  };
  const cut = cutBody(file.body, offset, bodyRoom(budget, citation), jsonRoomOf(output, budget));
  output.body = cut.slice;
  output.truncated = cut.truncated;
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

type WindowOut = z.infer<typeof EffectiveWindowSchema>;
const windowOut = (window: EffectiveWindow | undefined): { window?: WindowOut } =>
  window === undefined ? {} : { window: typedField("window", window) };

type CitationList = Exclude<
  keyof CitationsOutput,
  "path" | "summary" | "notice" | "partial" | "truncated"
>;
/** The lists of `citations` in the order issue 5 gives them, which is the order the budget spends (D82). */
const CITATION_LISTS: readonly CitationList[] = [
  "mentions",
  "inboundMentions",
  "claims",
  "bibliography",
  "unjoined",
  "inboundDerivations",
];
type Rows = { [K in CitationList]: CitationsOutput[K]["rows"] };

/** Each list's line in the text block, the same function for the budget and for the text. */
const CITATION_LINES: { [K in CitationList]: (row: Rows[K][number]) => string } = {
  mentions: mentionLine,
  inboundMentions: inboundMentionLine,
  claims: claimLine,
  bibliography: sourceLine,
  unjoined: unjoinedLine,
  inboundDerivations: derivationLine,
};
const CITATION_HEADINGS: Record<CitationList, string> = {
  mentions: "mentions",
  inboundMentions: "inbound mentions",
  claims: "claims",
  bibliography: "bibliography",
  unjoined: "unjoined footnotes",
  inboundDerivations: "inbound derivations",
};

/** The text block of `citations`: the header, the notice, then each list's heading and its rows. */
export function citationsText(output: CitationsOutput): string {
  const lines = [output.summary, output.notice];
  for (const list of CITATION_LISTS) {
    const { total, rows } = output[list];
    lines.push(listHeading(CITATION_HEADINGS[list], total, rows.length));
    const line = CITATION_LINES[list] as (row: unknown) => string;
    for (const row of rows) lines.push(line(row));
  }
  return lines.join("\n");
}

/**
 * The result of `citations` (issue 5): every list in its order, at most 50 rows beside its total, and the whole
 * result, text and structured, within the budget (D82): rows are kept list by list in issue 5's order until the
 * budget is spent, every cut list keeping its total, and the result says `truncated`.
 */
export function projectCitations(citations: Citations, budget: number): CitationsOutput {
  const all: Rows = {
    mentions: citations.mentions.map((m) => ({ ...m })),
    inboundMentions: citations.inboundMentions.map((m) => ({ ...m })),
    claims: citations.claims.map(({ sources, ...claim }) => ({
      ...claim,
      sources: sources.map(({ window, ...source }) => ({ ...source, ...windowOut(window) })),
    })),
    bibliography: citations.bibliography.map(({ window, ...source }) => ({
      ...source,
      ...windowOut(window),
    })),
    unjoined: citations.unjoined.map((u) => ({ ...u })),
    inboundDerivations: citations.inboundDerivations.map(({ window, ...derivation }) => ({
      ...derivation,
      ...windowOut(window),
    })),
  };
  const kept: Rows = {
    mentions: [],
    inboundMentions: [],
    claims: [],
    bibliography: [],
    unjoined: [],
    inboundDerivations: [],
  };
  const build = (truncated: boolean): CitationsOutput => {
    const totals = {
      mentions: all.mentions.length,
      inboundMentions: all.inboundMentions.length,
      claims: all.claims.length,
      bibliography: all.bibliography.length,
      unjoined: all.unjoined.length,
      inboundDerivations: all.inboundDerivations.length,
    };
    return {
      path: citations.path,
      summary: citationsHeader({
        path: citations.path,
        partial: citations.partial,
        truncated,
        totals,
        listCap: LIST_CAP,
      }),
      notice: NOTICE,
      partial: citations.partial,
      truncated,
      mentions: { total: totals.mentions, rows: kept.mentions },
      inboundMentions: { total: totals.inboundMentions, rows: kept.inboundMentions },
      claims: { total: totals.claims, rows: kept.claims },
      bibliography: { total: totals.bibliography, rows: kept.bibliography },
      unjoined: { total: totals.unjoined, rows: kept.unjoined },
      inboundDerivations: { total: totals.inboundDerivations, rows: kept.inboundDerivations },
    };
  };
  const over = (output: CitationsOutput): boolean =>
    JSON.stringify(output).length > budget || citationsText(output).length > budget;
  // Rows are added while both channels stay within the budget, measured from the frame with no rows.
  const frame = build(true);
  let json = JSON.stringify(frame).length;
  let text = citationsText(frame).length;
  let truncated = false;
  spend: for (const list of CITATION_LISTS) {
    const line = CITATION_LINES[list] as (row: unknown) => string;
    const target = kept[list] as unknown[];
    for (const row of (all[list] as unknown[]).slice(0, LIST_CAP)) {
      const jsonCost = JSON.stringify(row).length + 1;
      const textCost = line(row).length + 1;
      if (json + jsonCost > budget || text + textCost > budget) {
        truncated = true;
        break spend;
      }
      target.push(row);
      json += jsonCost;
      text += textCost;
    }
  }
  // The measure above is close, not exact (a list heading's digits); the last rows go until the result fits.
  let output = build(truncated);
  while (over(output)) {
    const last = [...CITATION_LISTS].reverse().find((list) => kept[list].length > 0);
    if (last === undefined) break;
    kept[last].pop();
    output = build(true);
  }
  return CitationsOutputSchema.parse(output);
}

type NodeOut = ProvenanceOutput["nodes"][number];
type EdgeOut = NodeOut["edges"][number];

function edgeOut({ window, candidates, ...edge }: WalkEdge): EdgeOut {
  return {
    ...edge,
    ...(candidates === undefined ? {} : { candidates: [...candidates] }),
    ...windowOut(window),
  };
}

function nodeOut({ edges, recheck, ...node }: WalkNode): NodeOut {
  return {
    ...node,
    ...(recheck === undefined ? {} : { recheck: { ...recheck } }),
    edges: edges.map(edgeOut),
  };
}

/** The text block of `provenance`: the header, the notice, then each page and its edges. */
export function walkText(output: ProvenanceOutput): string {
  const lines = [output.summary, output.notice];
  for (const node of output.nodes) {
    lines.push(walkNodeLine(node, LIST_CAP));
    for (const edge of node.edges) lines.push(walkEdgeLine(edge));
  }
  return lines.join("\n");
}

/**
 * The result of `provenance` (issue 5): the walk's pages in walk order, the whole result, text and structured,
 * within the budget (D82). Pages are kept in walk order until the budget is spent; the page the budget runs out in
 * keeps as many of its edges, in order, as fit; the result says `truncated` and keeps the walk's total.
 */
export function projectWalk(walk: Walk, budget: number): ProvenanceOutput {
  const all = walk.nodes.map(nodeOut);
  const kept: NodeOut[] = [];
  const build = (truncated: boolean): ProvenanceOutput => {
    const last = kept.at(-1);
    const lastCut =
      last !== undefined && last.edges.length < (all[kept.length - 1]?.edges.length ?? 0);
    return {
      path: walk.path,
      depth: walk.depth,
      summary: provenanceHeader({
        path: walk.path,
        depth: walk.depth,
        nodesTotal: all.length,
        returned: kept.length,
        lastCut,
        capped: walk.capped,
        branchesStopped: all.some((node) => node.truncated),
        truncated,
      }),
      notice: NOTICE,
      nodes: kept,
      nodesTotal: all.length,
      capped: walk.capped,
      truncated,
    };
  };
  const nodeText = (node: NodeOut): number =>
    walkNodeLine(node, LIST_CAP).length +
    1 +
    node.edges.reduce((sum, edge) => sum + walkEdgeLine(edge).length + 1, 0);
  const over = (output: ProvenanceOutput): boolean =>
    JSON.stringify(output).length > budget || walkText(output).length > budget;
  const frame = build(true);
  let json = JSON.stringify(frame).length;
  let text = walkText(frame).length;
  let truncated = false;
  for (const node of all) {
    const jsonCost = JSON.stringify(node).length + 1;
    const textCost = nodeText(node);
    if (json + jsonCost <= budget && text + textCost <= budget) {
      kept.push(node);
      json += jsonCost;
      text += textCost;
      continue;
    }
    // The page the budget runs out in keeps the edges that fit, in order, when its own line fits.
    truncated = true;
    const shell: NodeOut = { ...node, edges: [] };
    json += JSON.stringify(shell).length + 1;
    text += nodeText(shell);
    if (json > budget || text > budget) break;
    for (const edge of node.edges) {
      const edgeJson = JSON.stringify(edge).length + 1;
      const edgeText = walkEdgeLine(edge).length + 1;
      if (json + edgeJson > budget || text + edgeText > budget) break;
      shell.edges.push(edge);
      json += edgeJson;
      text += edgeText;
    }
    kept.push(shell);
    break;
  }
  let output = build(truncated);
  while (over(output)) {
    const last = kept.at(-1);
    if (last === undefined) break;
    if (last.edges.length > 0) kept[kept.length - 1] = { ...last, edges: last.edges.slice(0, -1) };
    else kept.pop();
    output = build(true);
  }
  return ProvenanceOutputSchema.parse(output);
}
