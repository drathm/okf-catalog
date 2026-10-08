import type {
  LinkKind,
  Page,
  PagePath,
  PathEdge,
  Source,
  StaleAfter,
  Trust,
  UsageWindow,
} from "../bundle/model.js";
import type { Catalog } from "./model.js";
import {
  type DatedWindow,
  type EffectiveWindow,
  effectiveWindow,
  isOverdue,
  sourceWindow,
} from "./provenance.js";

/** Rows a list carries beside its total, the status lists' cap (issue 5); a provenance node's sources too. */
export const LIST_CAP = 50;
/** How many concepts deep `provenance` follows sources when the caller names no depth, and the most it will. */
export const DEFAULT_DEPTH = 4;
export const MAX_DEPTH = 8;
/** The most concepts one walk enters (D71); the start page is not counted. */
export const MAX_ENTERED = 200;

/** A body link's kind as `citations` returns it: a page link whose target is not admitted is `unserved`. */
export type MentionKind = LinkKind | "unserved";

export interface Mention {
  kind: MentionKind;
  raw: string;
  target?: string;
  text: string;
  heading?: string;
}

export interface InboundMention {
  from: PagePath;
  /** The pointing page's status, so a draft served in development mode or a deprecated page says so. */
  status: string;
  text: string;
  heading?: string;
}

/**
 * A source as the two tools return it: as written, with the window that frames its count (§5.1), an inherited one
 * named and not copied, since the page's own window is in the same result (D62).
 */
export interface SourceFacts {
  id?: string;
  resource: string;
  title?: string;
  author?: string;
  usageCount?: number;
  lastModified?: string;
  window?: EffectiveWindow;
}

/**
 * A footnote reference joined to the sources whose id it matches without regard to case (§5.1): the first 50 of
 * them in the page's order, beside how many there are (bite b's build reviews B-I-A1, B-I-E2).
 */
export interface Claim {
  footnote: string;
  block: string;
  heading?: string;
  /** One list per source id, built once and shared by every claim that cites the id. */
  sources: readonly SourceFacts[];
  sourcesTotal: number;
}

/** A footnote reference no source joins: not a claim. */
export interface Unjoined {
  footnote: string;
  block: string;
  heading?: string;
}

/**
 * A page whose `resource` or a source's `resource` names this one, with that source's signals; its window with its
 * dates, since the deriving page's own window is not in the result.
 */
export interface Derivation {
  from: PagePath;
  /** The deriving page's status, as an inbound mention carries it. */
  status: string;
  field: string;
  kind: "concept" | "ambiguous";
  author?: string;
  usageCount?: number;
  lastModified?: string;
  window?: DatedWindow;
}

/**
 * What a page cites and what cites it. Each list is whole but the claims, of which the first 50 are built, since a
 * join of every reference to every source of one id grows as their product; the projection caps and budgets the
 * rest.
 */
export interface Citations {
  path: PagePath;
  /** The page's shared window, once: the claims' and the bibliography's sources that inherit it name it. */
  usageWindow?: UsageWindow;
  /** The body was not analysed, or only its first part: mentions and claims cover what was. */
  partial: boolean;
  mentions: Mention[];
  inboundMentions: InboundMention[];
  /** The first 50 claims in document order. */
  claims: Claim[];
  /** How many footnote references join a source: the claims there are. */
  claimsTotal: number;
  bibliography: SourceFacts[];
  unjoined: Unjoined[];
  inboundDerivations: Derivation[];
}

const withHeading = <T extends object>(value: T, heading: string | undefined): T =>
  heading === undefined ? value : { ...value, heading };

/** A source's facts, its window taken by the one inheritance rule (D62): its own, else the page's, named. */
function sourceFacts(source: Source, pageWindow: UsageWindow | undefined): SourceFacts {
  const facts: SourceFacts = { resource: source.resource };
  if (source.id !== undefined) facts.id = source.id;
  if (source.title !== undefined) facts.title = source.title;
  if (source.author !== undefined) facts.author = source.author;
  if (source.usageCount !== undefined) facts.usageCount = source.usageCount;
  if (source.lastModified !== undefined) facts.lastModified = source.lastModified;
  const window = effectiveWindow(source, pageWindow);
  if (window !== undefined) facts.window = window;
  return facts;
}

/**
 * What a page cites and what cites it (issue 5), from what the loader stored: its body links in document order,
 * a link to a page that is not admitted called `unserved`; the body links of admitted pages that point at it;
 * its footnote references joined to its sources by id without regard to case, each with the block holding it and
 * the first 50 sources it matches beside their total, the first 50 such claims built and all of them counted; the
 * sources no footnote joins; the references no source joins; and the admitted pages whose `resource` or source
 * names it under the path-field classifier. Nothing is fetched or opened. The work is linear in the page's
 * references and sources: each source's facts are built once, and each id's list once (bite b's build reviews
 * B-I-A1, B-A-A1).
 */
export function citationsOf(catalog: Catalog, page: Page): Citations {
  const mentions = page.links.map((link): Mention => {
    const unserved =
      link.kind === "page" && link.target !== undefined && !catalog.pages.has(link.target);
    const mention: Mention = {
      kind: unserved ? "unserved" : link.kind,
      raw: link.raw,
      text: link.text,
    };
    if (link.target !== undefined) mention.target = link.target;
    return withHeading(mention, link.heading);
  });
  // An inbound row names its page's status (bite b's build review B-A-E5); the page is admitted, so it is there.
  const statusOf = (path: PagePath): string => catalog.pages.get(path)?.status ?? "stable";
  const inboundMentions = (catalog.graph.inboundMentions.get(page.path) ?? []).map(
    ({ from, link }): InboundMention =>
      withHeading({ from, status: statusOf(from), text: link.text }, link.heading),
  );
  const byId = new Map<string, number[]>();
  page.sources.forEach((source, i) => {
    if (source.id === undefined) return;
    const key = source.id.toLowerCase();
    const same = byId.get(key);
    if (same === undefined) byId.set(key, [i]);
    else same.push(i);
  });
  // Each source's facts are built once, when a list first needs them, and shared by reference.
  const facts: Array<SourceFacts | undefined> = [];
  const factsOf = (i: number): SourceFacts => {
    const built = facts[i] ?? sourceFacts(page.sources[i] as Source, page.usageWindow);
    facts[i] = built;
    return built;
  };
  // Each id's list, its first 50 sources and their total, is built when a claim first cites it.
  const lists = new Map<string, { sources: readonly SourceFacts[]; total: number }>();
  const joinedIds = new Set<string>();
  const claims: Claim[] = [];
  let claimsTotal = 0;
  const unjoined: Unjoined[] = [];
  for (const reference of page.footnoteReferences) {
    const key = reference.id.toLowerCase();
    const matches = byId.get(key);
    if (matches === undefined) {
      unjoined.push(
        withHeading({ footnote: reference.id, block: reference.block }, reference.heading),
      );
      continue;
    }
    joinedIds.add(key);
    claimsTotal += 1;
    if (claims.length >= LIST_CAP) continue;
    let list = lists.get(key);
    if (list === undefined) {
      list = { sources: matches.slice(0, LIST_CAP).map(factsOf), total: matches.length };
      lists.set(key, list);
    }
    claims.push(
      withHeading(
        {
          footnote: reference.id,
          block: reference.block,
          sources: list.sources,
          sourcesTotal: list.total,
        },
        reference.heading,
      ),
    );
  }
  // A source no reference joins: one with no id, or whose id no reference names.
  const bibliography: SourceFacts[] = [];
  page.sources.forEach((source, i) => {
    if (source.id === undefined || !joinedIds.has(source.id.toLowerCase()))
      bibliography.push(factsOf(i));
  });
  const inboundDerivations = (catalog.graph.inboundDerivations.get(page.path) ?? []).map(
    ({ from, edge }): Derivation => {
      const derivation: Derivation = {
        from,
        status: statusOf(from),
        field: edge.field,
        kind: edge.kind === "ambiguous" ? "ambiguous" : "concept",
      };
      const deriving = catalog.pages.get(from);
      const source = edge.source === undefined ? undefined : deriving?.sources[edge.source];
      if (source === undefined) return derivation;
      if (source.author !== undefined) derivation.author = source.author;
      if (source.usageCount !== undefined) derivation.usageCount = source.usageCount;
      if (source.lastModified !== undefined) derivation.lastModified = source.lastModified;
      const window = sourceWindow(source, deriving?.usageWindow);
      if (window !== undefined) derivation.window = window;
      return derivation;
    },
  );
  const result: Citations = {
    path: page.path,
    partial: page.degradations.some(
      (d) => d.code === "body-unanalysed" || d.code === "body-truncated",
    ),
    mentions,
    inboundMentions,
    claims,
    claimsTotal,
    bibliography,
    unjoined,
    inboundDerivations,
  };
  if (page.usageWindow !== undefined) result.usageWindow = { ...page.usageWindow };
  return result;
}

/**
 * What the walk did with an edge that could hop (a `resource` or a source naming one admitted page): entered the
 * concept; found it entered already by an earlier edge of the same page (listed twice); found it entered already
 * on another branch; found it on this branch (a cycle); or stopped at the depth or at the walk's 200 concepts.
 */
export type WalkOutcome =
  | "entered"
  | "listed-twice"
  | "already-entered"
  | "cycle"
  | "depth-limit"
  | "concept-limit";

/** One edge of a walk: the classified path field, a source's facts for a source edge, and what the walk did. */
export interface WalkEdge extends Omit<PathEdge, "source"> {
  id?: string;
  title?: string;
  author?: string;
  usageCount?: number;
  lastModified?: string;
  window?: EffectiveWindow;
  walk?: WalkOutcome;
}

export interface WalkNode {
  path: PagePath;
  /** Concepts entered on the branch from the start page to this one; the start page is 0. */
  level: number;
  /** The page whose edge entered this one; absent for the start page. */
  parent?: PagePath;
  /** The page's status: a draft entered in development mode, or a deprecated page, says so (B-A-E5). */
  status: string;
  trust: Trust;
  recheck?: { raw: string; form: StaleAfter["form"]; overdue: boolean };
  /** The page's shared window, once: its edges whose source inherits it name it. */
  usageWindow?: UsageWindow;
  /** The page's sources, of which the first 50 are walked and listed. */
  sourcesTotal: number;
  /**
   * The depth stopped this branch at an edge that would have entered a new concept. Issue 5 calls it `truncated`;
   * the name is the result's own cut (D82), so the node's is `atDepthLimit` (bite b's build review B-A-E7).
   */
  atDepthLimit: boolean;
  edges: WalkEdge[];
}

export interface Walk {
  path: PagePath;
  depth: number;
  /** Every page of the walk in the order it was entered: breadth first, in edge order, each once. */
  nodes: WalkNode[];
  /** The walk entered its 200 concepts and stopped entering. */
  capped: boolean;
}

/** An edge the walk may follow: the start's resource or a source, naming one admitted page. */
const hops = (edge: PathEdge): boolean =>
  (edge.role === "resource" || edge.role === "source") &&
  edge.kind === "concept" &&
  edge.target !== undefined;

/** The edges a node lists: the start page's resource, sources and contract fields; an entered page's sources. */
function listedEdges(page: Page, start: boolean): PathEdge[] {
  const listed: PathEdge[] = [];
  let sources = 0;
  for (const edge of page.pathEdges) {
    if (edge.role === "source") {
      sources += 1;
      if (sources <= LIST_CAP) listed.push(edge);
    } else if (start) listed.push(edge);
  }
  return listed;
}

function walkEdge(edge: PathEdge, page: Page): WalkEdge {
  const { source: index, candidates, ...rest } = edge;
  const row: WalkEdge =
    candidates === undefined ? { ...rest } : { ...rest, candidates: [...candidates] };
  const source = index === undefined ? undefined : page.sources[index];
  if (source === undefined) return row;
  const facts = sourceFacts(source, page.usageWindow);
  if (facts.id !== undefined) row.id = facts.id;
  if (facts.title !== undefined) row.title = facts.title;
  if (facts.author !== undefined) row.author = facts.author;
  if (facts.usageCount !== undefined) row.usageCount = facts.usageCount;
  if (facts.lastModified !== undefined) row.lastModified = facts.lastModified;
  if (facts.window !== undefined) row.window = facts.window;
  return row;
}

/**
 * Where a page's sources lead (issue 5, D71). The start page lists its `resource`, its sources (the first 50) and
 * its contract fields; a `resource` or source that names one admitted page enters it, and an entered page lists
 * its own sources only, never its resource or contract fields. The walk is breadth first in edge order and enters
 * each concept once, at its least depth: a later branch that reaches it records the edge, with the same source
 * fields, and does not expand it; an edge to the page itself or an ancestor on its branch is a cycle, recorded
 * and not followed; an edge to a page this page's earlier edge entered says it is listed twice. `depth` (0 to 8)
 * counts the concepts entered on a branch; a branch it stops is `atDepthLimit`.
 * At most 200 concepts are entered, then the walk is `capped`. Each page carries its status, trust tier and recheck date;
 * `usage_count` is returned and orders nothing. Nothing is fetched, opened or run.
 */
export function walkProvenance(catalog: Catalog, start: Page, depth: number, now: Date): Walk {
  const limit = Math.max(0, Math.min(MAX_DEPTH, Math.floor(depth)));
  const nodes: WalkNode[] = [];
  const pages: Page[] = [];
  const parents: number[] = [];
  const entered = new Map<PagePath, number>();
  const enter = (page: Page, level: number, parent: number): void => {
    const node: WalkNode = {
      path: page.path,
      level,
      status: page.status,
      trust: page.trust,
      sourcesTotal: page.sources.length,
      atDepthLimit: false,
      edges: [],
    };
    const from = nodes[parent];
    if (from !== undefined) node.parent = from.path;
    if (page.usageWindow !== undefined) node.usageWindow = { ...page.usageWindow };
    if (page.staleAfter !== undefined)
      node.recheck = {
        raw: page.staleAfter.raw,
        form: page.staleAfter.form,
        overdue: isOverdue(page.staleAfter, now),
      };
    entered.set(page.path, nodes.length);
    nodes.push(node);
    pages.push(page);
    parents.push(parent);
  };
  /** Whether a path is the node's own or an ancestor's on its branch. */
  const onBranch = (index: number, path: PagePath): boolean => {
    for (let i = index; i >= 0; i = parents[i] ?? -1) if (nodes[i]?.path === path) return true;
    return false;
  };
  enter(start, 0, -1);
  let count = 0;
  let capped = false;
  // The node list is the queue: nodes are expanded in the order they were entered.
  for (let n = 0; n < nodes.length; n++) {
    const node = nodes[n] as WalkNode;
    const page = pages[n] as Page;
    for (const edge of listedEdges(page, n === 0)) {
      const row = walkEdge(edge, page);
      node.edges.push(row);
      if (!hops(edge)) continue;
      const target = edge.target as PagePath;
      const next = catalog.pages.get(target);
      const earlier = entered.get(target);
      if (onBranch(n, target)) row.walk = "cycle";
      // An earlier edge of this page entered it: the page lists it twice (bite b's build review B-A-A9).
      else if (earlier !== undefined)
        row.walk = parents[earlier] === n ? "listed-twice" : "already-entered";
      else if (node.level + 1 > limit) {
        row.walk = "depth-limit";
        node.atDepthLimit = true;
      } else if (count >= MAX_ENTERED) {
        row.walk = "concept-limit";
        capped = true;
      } else if (next !== undefined) {
        enter(next, node.level + 1, n);
        count += 1;
        row.walk = "entered";
      }
    }
  }
  return { path: start.path, depth: limit, nodes, capped };
}
