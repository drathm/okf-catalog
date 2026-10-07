import type { Page, PagePath, Trust } from "../bundle/model.js";
import { byCodeUnit } from "../bundle/paths.js";
import type { Catalog } from "../catalog/model.js";
import { isOverdue } from "../catalog/provenance.js";
import type { Engine, EngineHit } from "./engine.js";
import { normaliseQuestion, tokenize } from "./query.js";

export type Rung = "all-terms" | "relaxed";

export interface SearchRequest {
  question: string;
  type?: string;
  topic?: string;
  includeStale: boolean;
  limit: number;
  /** Run the relaxed rung when the first rung leaves the answer short (default true); the benchmark turns it off. */
  relax?: boolean;
  /** The per-term pool on the relaxed rung; defaults to the pool the first rung ended with. A tuning knob (D31). */
  relaxedPool?: number;
}

export interface SearchHit {
  path: PagePath;
  title: string;
  description?: string;
  type: string;
  /** The page's status as it is served: one of the three known values, or the company's own word (D61). */
  status: string;
  trust: Trust;
  staleAfter?: string;
  overdue: boolean;
  replacement?: PagePath;
  /** How many sources the page lists (intent §6: the count travels on hits). */
  sources: number;
  /** The page's `resource`, when it has one. */
  resource?: string;
  /** Raw BM25. On the all-terms rung it includes the type and topic tokens once; on the relaxed rung it is the sum of the content terms' scores. */
  score: number;
  rung: Rung;
  /** Relaxed rung only: how many informative terms list this page among their best matches (their per-term pool). The first sort key; a term the page holds outside that pool does not count. */
  termsMatched?: number;
}

export interface SearchResponse {
  hits: SearchHit[];
  /** The rung that answered: the rung of the first hit; `none` when nothing was found or the question had no content terms. */
  strategy: Rung | "none";
  reason?: "no-content-terms";
  terms: string[];
  dropped: string[];
  /** Terms the relaxed rung ignored because the engine scores them at its frequency floor (present in at least half the pages). */
  floored: string[];
  /** Distinct engine hits examined across every query. */
  considered: number;
  /** Distinct pages the filters removed, per reason. */
  filteredOut: { type: number; topic: number; stale: number; unknown: number };
  /** The pool size the first rung ended with. */
  pool: number;
  /** Engine queries made and rows they returned, for cost accounting: every row carries its page body. */
  engineQueries: number;
  rowsFetched: number;
  /** A topic filter was set, the pool reached its cap, and the answer is still short: the topic may hold more. */
  topicExhausted: boolean;
}

const POOL_FACTOR = 4;
const POOL_CAP = 500;
const LIMIT_CAP = 25;
const RELAXED_FLOOR = 0.01;
/** Below this, a term's best BM25 is SQLite's floored inverse document frequency: the term is in at least half the pages. */
const FREQUENCY_FLOOR = 1e-3;
const TIE = 1e-9;
const TRUST_RANK: Record<Trust, number> = {
  "human-reviewed": 0,
  "machine-confirmed": 1,
  unverified: 2,
};

interface Candidate {
  page: Page;
  score: number;
  matched: number;
}

function topicPrefix(topic: string | undefined): string | undefined {
  if (topic === undefined) return undefined;
  const trimmed = topic.replace(/^\/+|\/+$/g, "");
  return trimmed.length === 0 ? undefined : `${trimmed}/`;
}

function order(a: Candidate, b: Candidate): number {
  if (Math.abs(b.score - a.score) > TIE) return b.score - a.score;
  const trust = TRUST_RANK[a.page.trust] - TRUST_RANK[b.page.trust];
  return trust !== 0 ? trust : byCodeUnit(a.page.path, b.page.path);
}

interface CompletedPool {
  hits: EngineHit[];
  /** True when the engine had nothing beyond these rows. */
  exhausted: boolean;
}

interface QueryCost {
  queries: number;
  rows: number;
}

/**
 * Asks the engine for `pool` rows and completes the tie group at the cut. qmd orders equal scores by insertion
 * order, which differs from one index build to the next, so a pool that cuts inside a group of equal scores
 * would make the answer depend on the build. One extra row shows whether the cut fell inside a group; when it
 * did, the request widens until a row below the cut's score is seen, the engine runs out, or the cap is
 * reached. Rows below the cut's score are dropped. At the cap the group is cut as the engine cut it, which is
 * the one residual the engine's order can still reach.
 */
async function lexComplete(
  engine: Engine,
  terms: readonly string[],
  pool: number,
  cost: QueryCost,
): Promise<CompletedPool> {
  let ask = pool + 1;
  for (;;) {
    const rows = await engine.lex(terms, ask);
    cost.queries += 1;
    cost.rows += rows.length;
    if (rows.length <= pool) return { hits: rows, exhausted: true };
    const cut = (rows[pool - 1] as EngineHit).bm25;
    let end = pool;
    while (end < rows.length && Math.abs((rows[end] as EngineHit).bm25 - cut) <= TIE) end += 1;
    if (end < rows.length) return { hits: rows.slice(0, end), exhausted: false };
    if (rows.length < ask) return { hits: rows, exhausted: true };
    if (ask > POOL_CAP) return { hits: rows, exhausted: false };
    ask = Math.min(ask * POOL_FACTOR, POOL_CAP + 1);
  }
}

/**
 * Searches the catalog through the engine. The first rung sends every content term, plus the topic's path
 * segments and the type value, as one query, widening the pool while the filters leave it short and the engine
 * returned a full pool. When still short, the relaxed rung sends one query per content term and fuses by
 * summed BM25, ranked by terms matched. Every engine query completes the tie group at its cut, so the answer
 * does not depend on the engine's order among equal scores. Hits carry provenance and their rung; the response
 * says what was filtered and why.
 */
export async function search(
  catalog: Catalog,
  engine: Engine,
  request: SearchRequest,
  now: Date,
): Promise<SearchResponse> {
  const { terms, dropped } = normaliseQuestion(request.question);
  const limit = Number.isFinite(request.limit)
    ? Math.min(LIMIT_CAP, Math.max(1, Math.floor(request.limit)))
    : 1;
  const removed = {
    type: new Set<PagePath>(),
    topic: new Set<PagePath>(),
    stale: new Set<PagePath>(),
    unknown: new Set<PagePath>(),
  };
  const filteredOut = () => ({
    type: removed.type.size,
    topic: removed.topic.size,
    stale: removed.stale.size,
    unknown: removed.unknown.size,
  });
  if (terms.length === 0) {
    return {
      hits: [],
      strategy: "none",
      reason: "no-content-terms",
      terms,
      dropped,
      floored: [],
      considered: 0,
      filteredOut: filteredOut(),
      pool: 0,
      engineQueries: 0,
      rowsFetched: 0,
      topicExhausted: false,
    };
  }
  const cost: QueryCost = { queries: 0, rows: 0 };
  const prefix = topicPrefix(request.topic);
  const wantedType = request.type?.trim().toLowerCase();
  const extra = [
    ...(prefix === undefined ? [] : tokenize(prefix.replace(/\//g, " "))),
    ...(wantedType === undefined ? [] : tokenize(wantedType)),
  ];
  const considered = new Set<PagePath>();

  /** Applies the filters to one engine hit; returns the page when it survives. */
  const admit = (hit: EngineHit): Page | undefined => {
    considered.add(hit.path);
    const page = catalog.pages.get(hit.path);
    if (page === undefined) {
      removed.unknown.add(hit.path);
      return undefined;
    }
    if (wantedType !== undefined && page.type.toLowerCase() !== wantedType) {
      removed.type.add(hit.path);
      return undefined;
    }
    if (prefix !== undefined && !page.path.startsWith(prefix)) {
      removed.topic.add(hit.path);
      return undefined;
    }
    if (!request.includeStale && isOverdue(page.staleAfter, now)) {
      removed.stale.add(hit.path);
      return undefined;
    }
    return page;
  };

  // First rung: all terms, widening while short and the engine still had more to give.
  let pool = Math.min(limit * POOL_FACTOR, POOL_CAP);
  let first: Candidate[] = [];
  for (;;) {
    const { hits: engineHits, exhausted } = await lexComplete(
      engine,
      [...terms, ...extra],
      pool,
      cost,
    );
    first = [];
    for (const hit of engineHits) {
      const page = admit(hit);
      if (page !== undefined) first.push({ page, score: hit.bm25, matched: terms.length });
    }
    if (first.length >= limit || exhausted || pool >= POOL_CAP) break;
    pool = Math.min(pool * POOL_FACTOR, POOL_CAP);
  }
  first.sort(order);
  const hits: SearchHit[] = first
    .slice(0, limit)
    .map((c) => shape(c.page, c.score, "all-terms", now));

  // Relaxed rung: one query per content term, fused by summed BM25, ranked by terms matched then by the sum.
  // The type and topic tokens stay out of these queries: BM25 adds up across terms, so a token present in every
  // candidate would be added once per matched term and move the order within a bucket. The filters still apply.
  // The per-term pool is `limit × 4`, not the widened pool: every row carries its page body, and twelve terms
  // at the cap would materialise thousands of them. A term the engine scores at its frequency floor is in at
  // least half the pages and says nothing about which; it is skipped and named, so the company's own name in
  // every path cannot vote.
  const floored: string[] = [];
  if (request.relax !== false && hits.length < limit && terms.length > 1) {
    const relaxedPool = Math.max(1, Math.min(request.relaxedPool ?? limit * POOL_FACTOR, POOL_CAP));
    const taken = new Set(hits.map((h) => h.path));
    const fused = new Map<PagePath, Candidate>();
    for (const term of terms) {
      const rows = (await lexComplete(engine, [term], relaxedPool, cost)).hits;
      if (rows.length > 0 && (rows[0] as EngineHit).bm25 < FREQUENCY_FLOOR) {
        floored.push(term);
        continue;
      }
      for (const hit of rows) {
        if (taken.has(hit.path)) continue;
        const page = admit(hit);
        if (page === undefined) continue;
        const entry = fused.get(hit.path) ?? { page, score: 0, matched: 0 };
        entry.score += hit.bm25;
        entry.matched += 1;
        fused.set(hit.path, entry);
      }
    }
    const best = Math.max(0, ...[...fused.values()].map((e) => e.score));
    const relaxed = [...fused.values()]
      .filter((e) => e.score >= best * RELAXED_FLOOR)
      .sort((a, b) => b.matched - a.matched || order(a, b));
    for (const e of relaxed) {
      if (hits.length >= limit) break;
      hits.push({ ...shape(e.page, e.score, "relaxed", now), termsMatched: e.matched });
    }
  }

  const strategy: Rung | "none" = hits[0]?.rung ?? "none";
  return {
    hits,
    strategy,
    terms,
    dropped,
    floored,
    considered: considered.size,
    filteredOut: filteredOut(),
    pool,
    engineQueries: cost.queries,
    rowsFetched: cost.rows,
    topicExhausted: prefix !== undefined && pool >= POOL_CAP && hits.length < limit,
  };
}

function shape(page: Page, score: number, rung: Rung, now: Date): SearchHit {
  const hit: SearchHit = {
    path: page.path,
    title: page.title,
    type: page.type,
    status: page.status,
    trust: page.trust,
    overdue: isOverdue(page.staleAfter, now),
    sources: page.sources.length,
    score,
    rung,
  };
  if (page.resource !== undefined) hit.resource = page.resource;
  if (page.description !== undefined) hit.description = page.description;
  if (page.staleAfter !== undefined) hit.staleAfter = page.staleAfter.raw;
  if (page.replacement !== undefined) hit.replacement = page.replacement;
  return hit;
}
