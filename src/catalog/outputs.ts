import { z } from "zod/v4";
import { ellipsised } from "../bundle/cut.js";
import type { Page, ReservedFile } from "../bundle/model.js";
import { byCodeUnit } from "../bundle/paths.js";
import type { SearchResponse } from "../search/search.js";
import { snippet } from "../search/snippet.js";
import {
  type Citations,
  LIST_CAP,
  type SourceFacts,
  type Walk,
  type WalkEdge,
  type WalkNode,
} from "./graph.js";
import type { Catalog } from "./model.js";
import { type DatedWindow, type EffectiveWindow, provenanceOf } from "./provenance.js";
import type {
  BundleRuntimeStatus,
  Generation,
  LockOwnerStatus,
  RuntimeStatus,
  ToolOptions,
} from "./runtime.js";
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
  pageWindowLine,
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
/**
 * The window that frames a source's count where its page's own window is in the same result (D62, merge ruling 1
 * of bite b's fold): the source's own window with its dates, or the page's named and not copied, its dates being
 * that page's `usageWindow`; or the note past the cap (D78). get_page's sources, a claim's sources, the
 * bibliography and a walk edge carry it.
 */
const EffectiveWindowSchema = orOmitted(
  z.union([
    z.strictObject({ from: z.string(), to: z.string(), inherited: z.literal(false) }),
    z.strictObject({ inherited: z.literal(true) }),
  ]),
);
/**
 * The window that frames a source's count on a row from another page, whose window the result does not carry: the
 * dates always, and whether they are that page's shared window (an inbound derivation); or the note past the cap.
 */
const DatedWindowSchema = orOmitted(
  z.strictObject({ from: z.string(), to: z.string(), inherited: z.boolean() }),
);
const SourceSchema = z.strictObject({
  resource: z.string(),
  id: z.string().optional(),
  title: z.string().optional(),
  author: z.string().optional(),
  usageCount: z.number().optional(),
  lastModified: z.string().optional(),
  /** The source's own window as written, or its note past D78's cap. */
  usageWindow: orOmitted(Window).optional(),
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
  /** The admission list's words, other than the known statuses, that no page carries (D77). */
  unmatchedAdmits: list(z.string()),
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
  /** The page's shared window, once: the sources of its claims and bibliography that inherit it name it (D62). */
  usageWindow: orOmitted(Window).optional(),
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
    z.strictObject({
      from: z.string(),
      /** The pointing page's status (bite b's build review B-A-E5). */
      status: Status,
      text: z.string(),
      heading: z.string().optional(),
    }),
  ),
  claims: cappedList(
    z.strictObject({
      footnote: z.string(),
      block: z.string(),
      heading: z.string().optional(),
      /** The first 50 sources the reference joins; `sourcesTotal` says how many there are. */
      sources: z.array(SourceFactsSchema),
      sourcesTotal: z.number(),
    }),
  ),
  bibliography: cappedList(SourceFactsSchema),
  unjoined: cappedList(
    z.strictObject({ footnote: z.string(), block: z.string(), heading: z.string().optional() }),
  ),
  inboundDerivations: cappedList(
    z.strictObject({
      from: z.string(),
      /** The deriving page's status (B-A-E5). */
      status: Status,
      field: z.string(),
      kind: z.enum(["concept", "ambiguous"]),
      author: z.string().optional(),
      usageCount: z.number().optional(),
      lastModified: z.string().optional(),
      window: DatedWindowSchema.optional(),
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
  walk: z
    .enum(["entered", "listed-twice", "already-entered", "cycle", "depth-limit", "concept-limit"])
    .optional(),
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
      /** The page's status: a draft in development mode, or a deprecated page, says so (B-A-E5). */
      status: Status,
      trust: Trust,
      recheck: z.strictObject({ raw: z.string(), form: Form, overdue: z.boolean() }).optional(),
      /** The page's shared window, once: its edges whose source inherits it name it (D62). */
      usageWindow: orOmitted(Window).optional(),
      sourcesTotal: z.number(),
      /** The depth stopped this branch (issue 5's `truncated`; renamed, bite b's build review B-A-E7). */
      atDepthLimit: z.boolean(),
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

/**
 * Characters of a page-written value a row carries in the structured output (an id, a path, a raw value, a title,
 * an author, a last change, a recheck date) before it is cut with an ellipsis, D78's number, so that any row fits
 * the result (bite b's build reviews B-I-A3, B-A-A2). Text lines print at most 500 of them.
 */
export const FIELD_CAP = 2_000;

/** Characters of one page-written value a page header prints; the provenance falls back to it too (B-I-A2). */
const HEADER_FIELD_CAP = 200;

/** A value cut at the field cap with an ellipsis. */
export const capField = (value: string): string => ellipsised(value, FIELD_CAP);

/** A copy of a row with the named string fields cut at `cap`, the field cap unless said; absent fields stay absent. */
function capFields<T extends object, K extends keyof T>(
  row: T,
  keys: readonly K[],
  cap: number = FIELD_CAP,
): T {
  const out = { ...row };
  for (const key of keys) {
    const value = out[key];
    if (typeof value === "string") out[key] = ellipsised(value, cap) as T[K];
  }
  return out;
}

/** A typed field as a result carries it: whole within its budget, else its own note (D78). */
function typedField<T>(field: string, value: T): T | { omitted: string } {
  return JSON.stringify(value).length > TYPED_FIELD_BUDGET
    ? {
        omitted: `the ${field} field is over ${TYPED_FIELD_BUDGET} characters and is not returned here`,
      }
    : value;
}

/** The most verifications `get_page` lists, the latest ones, before the budget is spent (bite b's build review B-A-E4). */
const VERIFIED_SHOWN = 20;

/**
 * The verifications a result lists: the latest 20 by their instant (one with no readable date counts as the
 * earliest, and of two at one instant the later in the page wins), in the page's order, so that a long history
 * of verifications never leaves the sources without room (B-A-E4).
 */
function latestVerified<T>(page: Page, entries: readonly T[]): T[] {
  if (entries.length <= VERIFIED_SHOWN) return [...entries];
  const instant = (i: number): number =>
    page.verified[i]?.at?.at?.getTime() ?? Number.NEGATIVE_INFINITY;
  const latest = entries
    .map((_, i) => i)
    .sort((a, b) => instant(b) - instant(a) || b - a)
    .slice(0, VERIFIED_SHOWN)
    .sort((a, b) => a - b);
  return latest.map((i) => entries[i] as T);
}

/**
 * The provenance as `get_page` returns it: the frontmatter replaced by its note past its budget, every typed field
 * held to its own budget, so a page's typed fields survive the frontmatter's omission (D62, D78), and every other
 * page-written value cut at `cap` characters with an ellipsis (2 000, D78's number; bite b's build reviews B-I-A2,
 * B-I-A3); the latest 20 verifications (B-A-E4).
 */
function projectProvenance(page: Page, now: Date, cap: number): ProjectedProvenance {
  const { sources, usageWindow, contract, timestamp, ...rest } = provenanceOf(page, now);
  const capped = <T extends object, K extends keyof T>(row: T, keys: readonly K[]): T =>
    capFields(row, keys, cap);
  const projected: ProjectedProvenance = {
    ...capped(rest, ["path", "title", "type", "status", "resource", "replacement"]),
    ...(rest.generated === undefined ? {} : { generated: capped(rest.generated, ["by", "at"]) }),
    ...(rest.latestVerification === undefined
      ? {}
      : { latestVerification: capped(rest.latestVerification, ["by", "at"]) }),
    ...(rest.staleAfter === undefined ? {} : { staleAfter: capped(rest.staleAfter, ["raw"]) }),
    // Each row's page-written values cut too, so one long value never crowds out the rest (B-I-A3).
    verified: latestVerified(page, rest.verified).map((v) => capped(v, ["by", "at"])),
    sources: sources.map(({ effectiveWindow, usageWindow: own, ...source }) => ({
      ...capped(source, ["id", "resource", "title", "author", "lastModified"]),
      ...(own === undefined ? {} : { usageWindow: typedField("usageWindow", own) }),
      ...(effectiveWindow === undefined
        ? {}
        : { effectiveWindow: typedField("effectiveWindow", effectiveWindow) }),
    })),
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

/** The provenance with its two lists empty: what it costs before a verification or a source is kept. */
const listless = (projected: ProjectedProvenance): number =>
  JSON.stringify({ ...projected, verified: [], sources: [] }).length;

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

/** The fewest characters of body a result carries, two, so a cut never splits a surrogate pair. */
const BODY_MINIMUM = 2;

/**
 * The longest body cut from `offset` that fits both channels: `textRoom` raw characters for the text block and
 * `jsonRoom` characters once escaped for the structured output, which counts a quotation mark, a backslash or a
 * line break twice and a control character six times. The escaped length grows with the cut, so the longest cut
 * whose escaped length fits is found by binary search (bite b's build review B-A-A3). When not even the minimum
 * fits, the body is cut to its minimum, which the rest of the result leaves room for.
 */
function cutBody(body: string, offset: number, textRoom: number, jsonRoom: number): Cut {
  const fits = (cut: Cut): boolean => JSON.stringify(cut.slice).length - 2 <= jsonRoom;
  const most = Math.max(BODY_MINIMUM, textRoom);
  const whole = cutText(body, offset, most);
  if (fits(whole)) return whole;
  let low = BODY_MINIMUM;
  let high = most - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(cutText(body, offset, mid))) low = mid;
    else high = mid - 1;
  }
  return cutText(body, offset, low);
}

/**
 * The page header within a quarter of the budget in both channels (D82; bite b's build review B-I-A2): it names at
 * most ten of the sources the provenance kept, or, when escaping lengthens them past that quarter, as many of them
 * as fit, then says how many more there are; every other page-written value in it is cut at 200 characters.
 */
function headerWithin(
  page: Page,
  now: Date,
  options: LineOptions,
  kept: number,
  room: number,
): string {
  const header = (shown: number): string =>
    pageHeader(page, now, { ...options, sourcesShown: shown });
  const fits = (line: string): boolean =>
    line.length <= room && JSON.stringify(line).length <= room;
  const whole = header(kept);
  if (fits(whole)) return whole;
  let best = header(0);
  let low = 1;
  let high = kept - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = header(mid);
    if (fits(candidate)) {
      best = candidate;
      low = mid + 1;
    } else high = mid - 1;
  }
  return best;
}

/** The room a body has in the structured result: the budget less the result with an empty body. */
const jsonRoomOf = (frame: PageOutput, budget: number): number =>
  budget -
  JSON.stringify({ ...frame, body: "", truncated: true, nextOffset: Number.MAX_SAFE_INTEGER })
    .length;

/**
 * A page as `get_page` returns it, the whole result within the budget in both channels (D82): the provenance
 * takes at most half, its latest 20 verifications then its sources cut in order with their totals, every value cut
 * at 2 000 characters, and at 200 when the provenance would not fit its half otherwise; the header names at most
 * ten of the sources the provenance kept, within a quarter in both channels; the body takes the rest, the longest
 * cut that fits both channels, and says where to continue.
 */
export function projectPage(
  page: Page,
  now: Date,
  offset: number,
  budget: number,
  options: LineOptions = {},
): PageOutput {
  const half = Math.floor(budget / 2);
  let projected = projectProvenance(page, now, FIELD_CAP);
  // Many values at the field cap at once: each is cut again, to what a header prints, so the half holds.
  if (listless(projected) > half) projected = projectProvenance(page, now, HEADER_FIELD_CAP);
  const provenance = fitProvenance(projected, half);
  const citation = headerWithin(
    page,
    now,
    options,
    provenance.sources.length,
    Math.floor(budget / 4),
  );
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

/** What the status projection reads of the runtime: the network's lock and refusal, and the bundle's attempts and poller. */
export type StatusFacts = Omit<RuntimeStatus, "bundles" | "loaded"> &
  Partial<Omit<BundleRuntimeStatus, "id">> & { lockOwner?: LockOwnerStatus | null };

export function projectStatus(
  generation: Generation,
  runtime: StatusFacts,
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
    unmatchedAdmits: capped(r.unmatchedAdmits),
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
  // One and many, the irregular ones written out (build review A-D8).
  const n = (count: number, one: string, many = `${one}s`): string =>
    `${count} ${count === 1 ? one : many}`;
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
    `${n(out.unknownTypes.count, "unknown type")}, ${n(out.unknownStatuses.count, "unknown status", "unknown statuses")}, ${n(out.brokenLinks.count, "broken link")}, ${n(out.linksToUnserved.count, "link to an unserved page", "links to an unserved page")}, ${n(out.foldersWithoutIndex.count, "folder without an index", "folders without an index")}, ${n(out.missingOnDisk.count, "manifest entry missing on disk", "manifest entries missing on disk")}, ${n(out.unmatchedAdmits.count, "admitted status that matches no page", "admitted statuses that match no page")}`,
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

/** A row's window as a result carries it: whole within its cap, else its note (D78). */
const windowOut = <W extends EffectiveWindow | DatedWindow>(
  window: W | undefined,
): { window?: W | { omitted: string } } =>
  window === undefined ? {} : { window: typedField("window", window) };

type CitationList = Exclude<
  keyof CitationsOutput,
  "path" | "summary" | "notice" | "usageWindow" | "partial" | "truncated"
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

/** The text block of `citations`: the header, the notice, the page's window, then each list's heading and its rows. */
export function citationsText(output: CitationsOutput): string {
  const lines = [output.summary, output.notice];
  if (output.usageWindow !== undefined) lines.push(pageWindowLine(output.usageWindow));
  for (const list of CITATION_LISTS) {
    const { total, rows } = output[list];
    lines.push(listHeading(CITATION_HEADINGS[list], total, rows.length));
    const line = CITATION_LINES[list] as (row: unknown) => string;
    for (const row of rows) lines.push(line(row));
  }
  return lines.join("\n");
}

type ClaimRow = Rows["claims"][number];
type Space = { json: number; text: number };

/** A source's facts as a row carries them: each page-written value cut at the field cap, the window at D78's. */
const sourceFactsOut = ({ window, ...source }: SourceFacts): Rows["bibliography"][number] => ({
  ...capFields(source, ["id", "resource", "title", "author", "lastModified"]),
  ...windowOut(window),
});

/**
 * The largest first part of a claim's sources that fits the space in both channels, as a walk's last page keeps
 * the edges that fit (D82); the row says how many sources there are. Undefined when not even the claim fits.
 */
function fitClaim(row: ClaimRow, space: Space): { row: ClaimRow; cost: Space } | undefined {
  const costOf = (part: ClaimRow): Space => ({
    json: JSON.stringify(part).length + 1,
    text: claimLine(part).length + 1,
  });
  const with_ = (count: number): ClaimRow => ({ ...row, sources: row.sources.slice(0, count) });
  const fits = (cost: Space) => cost.json <= space.json && cost.text <= space.text;
  if (!fits(costOf(with_(0)))) return undefined;
  let low = 0;
  let high = row.sources.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(costOf(with_(mid)))) low = mid;
    else high = mid - 1;
  }
  const part = with_(low);
  return { row: part, cost: costOf(part) };
}

/**
 * The result of `citations` (issue 5): every list in its order, at most 50 rows beside its total, and the whole
 * result, text and structured, within the budget (D82). Every page-written value of a row is cut at 2 000
 * characters (link text, headings and blocks at 500 at load), so one long value never fills the result. Each list
 * that has rows gets an equal share of what the frame leaves, in both channels, and keeps its first rows within
 * its share and what the lists before it left unused; what the last list leaves goes back, in order, to the lists
 * cut before it, so no list starves another (bite b's build reviews B-I-A3, B-A-A2, B-I-E1). A claim too large for
 * its room keeps its first sources, with their total. Every cut list keeps its total, and the result says
 * `truncated`.
 */
export function projectCitations(citations: Citations, budget: number): CitationsOutput {
  // Only the rows a list can carry are projected (at most 50 each); each claim's list of sources is projected once
  // per id and shared, as the graph shares it (bite b's build reviews B-I-A1, B-A-A1).
  const first = <T>(rows: readonly T[]): readonly T[] => rows.slice(0, LIST_CAP);
  const projectedSources = new Map<readonly SourceFacts[], ClaimRow["sources"]>();
  const sourcesOut = (sources: readonly SourceFacts[]): ClaimRow["sources"] => {
    const done = projectedSources.get(sources);
    if (done !== undefined) return done;
    const projected = sources.map(sourceFactsOut);
    projectedSources.set(sources, projected);
    return projected;
  };
  const all: Rows = {
    mentions: first(citations.mentions).map((m) => capFields(m, ["raw", "target"])),
    inboundMentions: first(citations.inboundMentions).map((m) => capFields(m, ["from"])),
    claims: first(citations.claims).map(({ sources, ...claim }) => ({
      ...capFields(claim, ["footnote"]),
      sources: sourcesOut(sources),
    })),
    bibliography: first(citations.bibliography).map(sourceFactsOut),
    unjoined: first(citations.unjoined).map((u) => capFields(u, ["footnote"])),
    inboundDerivations: first(citations.inboundDerivations).map(({ window, ...derivation }) => ({
      ...capFields(derivation, ["from", "author", "lastModified"]),
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
      mentions: citations.mentions.length,
      inboundMentions: citations.inboundMentions.length,
      claims: citations.claimsTotal,
      bibliography: citations.bibliography.length,
      unjoined: citations.unjoined.length,
      inboundDerivations: citations.inboundDerivations.length,
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
      ...(citations.usageWindow === undefined
        ? {}
        : { usageWindow: typedField("usageWindow", citations.usageWindow) }),
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
  // The room the frame (the header, the notice, the page window, the list headings) leaves, in both channels.
  const frame = build(true);
  const room: Space = {
    json: Math.max(0, budget - JSON.stringify(frame).length),
    text: Math.max(0, budget - citationsText(frame).length),
  };
  const next: Record<CitationList, number> = {
    mentions: 0,
    inboundMentions: 0,
    claims: 0,
    bibliography: 0,
    unjoined: 0,
    inboundDerivations: 0,
  };
  // A list that ended in a claim cut short is finished: no later claim follows a cut one.
  const finished = new Set<CitationList>();
  /** Adds a list's next rows, in order, while they fit the space; returns what is left of it. */
  const fill = (list: CitationList, space: Space): Space => {
    const rows = all[list] as unknown[];
    const target = kept[list] as unknown[];
    const line = CITATION_LINES[list] as (row: unknown) => string;
    const left = { ...space };
    while (next[list] < rows.length) {
      const row = rows[next[list]];
      const cost = { json: JSON.stringify(row).length + 1, text: line(row).length + 1 };
      if (cost.json <= left.json && cost.text <= left.text) {
        target.push(row);
        left.json -= cost.json;
        left.text -= cost.text;
        next[list] += 1;
        continue;
      }
      if (list === "claims") {
        const part = fitClaim(row as ClaimRow, left);
        if (part !== undefined) {
          target.push(part.row);
          left.json -= part.cost.json;
          left.text -= part.cost.text;
          finished.add(list);
        }
      }
      break;
    }
    return left;
  };
  const lists = CITATION_LISTS.filter((list) => all[list].length > 0);
  const share: Space = {
    json: Math.floor(room.json / Math.max(1, lists.length)),
    text: Math.floor(room.text / Math.max(1, lists.length)),
  };
  let carry: Space = { json: 0, text: 0 };
  for (const list of lists)
    carry = fill(list, { json: share.json + carry.json, text: share.text + carry.text });
  // What the last list leaves goes back to the lists the budget cut, in their order.
  for (const list of lists)
    if (!finished.has(list) && next[list] < all[list].length) carry = fill(list, carry);
  const truncated = lists.some((list) => finished.has(list) || next[list] < all[list].length);
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

/** An edge as the result carries it, each page-written value cut at the field cap (B-I-A3, B-A-A2). */
function edgeOut({ window, candidates, ...edge }: WalkEdge): EdgeOut {
  return {
    ...capFields(edge, ["raw", "target", "id", "title", "author", "lastModified"]),
    ...(candidates === undefined ? {} : { candidates: candidates.map(capField) }),
    ...windowOut(window),
  };
}

function nodeOut({ edges, recheck, usageWindow, ...node }: WalkNode): NodeOut {
  return {
    ...capFields(node, ["path", "parent"]),
    ...(recheck === undefined ? {} : { recheck: { ...recheck, raw: capField(recheck.raw) } }),
    ...(usageWindow === undefined ? {} : { usageWindow: typedField("usageWindow", usageWindow) }),
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
        branchesStopped: all.some((node) => node.atDepthLimit),
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
