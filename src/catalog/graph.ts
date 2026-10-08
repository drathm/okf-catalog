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
import { type EffectiveWindow, effectiveWindow, isOverdue } from "./provenance.js";

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
  text: string;
  heading?: string;
}

/** A source as the two tools return it: as written, with the window that frames its count (§5.1). */
export interface SourceFacts {
  id?: string;
  resource: string;
  title?: string;
  author?: string;
  usageCount?: number;
  lastModified?: string;
  window?: EffectiveWindow;
}

/** A footnote reference joined to every source whose id it matches without regard to case (§5.1). */
export interface Claim {
  footnote: string;
  block: string;
  heading?: string;
  sources: SourceFacts[];
}

/** A footnote reference no source joins: not a claim. */
export interface Unjoined {
  footnote: string;
  block: string;
  heading?: string;
}

/** A page whose `resource` or a source's `resource` names this one, with that source's signals. */
export interface Derivation {
  from: PagePath;
  field: string;
  kind: "concept" | "ambiguous";
  author?: string;
  usageCount?: number;
  lastModified?: string;
  window?: EffectiveWindow;
}

/** What a page cites and what cites it, each list whole: the projection caps and budgets them. */
export interface Citations {
  path: PagePath;
  /** The body was not analysed, or only its first part: mentions and claims cover what was. */
  partial: boolean;
  mentions: Mention[];
  inboundMentions: InboundMention[];
  claims: Claim[];
  bibliography: SourceFacts[];
  unjoined: Unjoined[];
  inboundDerivations: Derivation[];
}

const withHeading = <T extends object>(value: T, heading: string | undefined): T =>
  heading === undefined ? value : { ...value, heading };

/** A source's facts, its window taken by the one inheritance rule (D62): its own, else the page's. */
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
 * every source it matches; the sources no footnote joins; the references no source joins; and the admitted pages
 * whose `resource` or source names it under the path-field classifier. Nothing is fetched or opened.
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
  const inboundMentions = (catalog.graph.inboundMentions.get(page.path) ?? []).map(
    ({ from, link }): InboundMention => withHeading({ from, text: link.text }, link.heading),
  );
  const byId = new Map<string, number[]>();
  page.sources.forEach((source, i) => {
    if (source.id === undefined) return;
    const key = source.id.toLowerCase();
    byId.set(key, [...(byId.get(key) ?? []), i]);
  });
  const joined = new Set<number>();
  const claims: Claim[] = [];
  const unjoined: Unjoined[] = [];
  for (const reference of page.footnoteReferences) {
    const matches = byId.get(reference.id.toLowerCase()) ?? [];
    if (matches.length === 0) {
      unjoined.push(
        withHeading({ footnote: reference.id, block: reference.block }, reference.heading),
      );
      continue;
    }
    for (const i of matches) joined.add(i);
    claims.push(
      withHeading(
        {
          footnote: reference.id,
          block: reference.block,
          sources: matches.map((i) => sourceFacts(page.sources[i] as Source, page.usageWindow)),
        },
        reference.heading,
      ),
    );
  }
  const bibliography = page.sources
    .filter((_, i) => !joined.has(i))
    .map((source) => sourceFacts(source, page.usageWindow));
  const inboundDerivations = (catalog.graph.inboundDerivations.get(page.path) ?? []).map(
    ({ from, edge }): Derivation => {
      const derivation: Derivation = {
        from,
        field: edge.field,
        kind: edge.kind === "ambiguous" ? "ambiguous" : "concept",
      };
      const deriving = catalog.pages.get(from);
      const source = edge.source === undefined ? undefined : deriving?.sources[edge.source];
      if (source === undefined) return derivation;
      if (source.author !== undefined) derivation.author = source.author;
      if (source.usageCount !== undefined) derivation.usageCount = source.usageCount;
      if (source.lastModified !== undefined) derivation.lastModified = source.lastModified;
      const window = effectiveWindow(source, deriving?.usageWindow);
      if (window !== undefined) derivation.window = window;
      return derivation;
    },
  );
  return {
    path: page.path,
    partial: page.degradations.some(
      (d) => d.code === "body-unanalysed" || d.code === "body-truncated",
    ),
    mentions,
    inboundMentions,
    claims,
    bibliography,
    unjoined,
    inboundDerivations,
  };
}

/**
 * What the walk did with an edge that could hop (a `resource` or a source naming one admitted page): entered the
 * concept; found it entered already on another branch; found it on this branch (a cycle); or stopped at the depth
 * or at the walk's 200 concepts.
 */
export type WalkOutcome = "entered" | "already-entered" | "cycle" | "depth-limit" | "concept-limit";

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
  trust: Trust;
  recheck?: { raw: string; form: StaleAfter["form"]; overdue: boolean };
  /** The page's sources, of which the first 50 are walked and listed. */
  sourcesTotal: number;
  /** The depth stopped this branch at an edge that would have entered a new concept. */
  truncated: boolean;
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
 * and not followed. `depth` (0 to 8) counts the concepts entered on a branch; a branch it stops is `truncated`.
 * At most 200 concepts are entered, then the walk is `capped`. Each page carries its trust tier and recheck date;
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
      trust: page.trust,
      sourcesTotal: page.sources.length,
      truncated: false,
      edges: [],
    };
    const from = nodes[parent];
    if (from !== undefined) node.parent = from.path;
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
      if (onBranch(n, target)) row.walk = "cycle";
      else if (entered.has(target)) row.walk = "already-entered";
      else if (node.level + 1 > limit) {
        row.walk = "depth-limit";
        node.truncated = true;
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
