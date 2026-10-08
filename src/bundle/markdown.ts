import type { Nodes, Parent, Root } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFootnoteFromMarkdown } from "mdast-util-gfm-footnote";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmFootnote } from "micromark-extension-gfm-footnote";
import { gfmTable } from "micromark-extension-gfm-table";
import { ellipsised } from "./cut.js";

/** A link as the body writes it: its URL, its text, and the nearest heading at or before it (issue 5). */
export interface BodyLink {
  url: string;
  /** The link's prose, whitespace collapsed, cut at 500 characters with an ellipsis. */
  text: string;
  /**
   * The prose of the last heading that starts at or before the link (the link's own heading when it sits in one),
   * cut as the text is; absent before any heading, or when that heading has no text.
   */
  heading?: string;
}

/** A footnote reference: the identifier GFM records (lower-cased), the block holding it, and the nearest heading. */
export interface BodyFootnoteReference {
  id: string;
  /**
   * The prose of the smallest paragraph, heading, list item, block quote or table cell holding the reference,
   * whitespace collapsed and cut at 500 characters with an ellipsis: the sentence the footnote supports, never the
   * footnote's definition.
   */
  block: string;
  heading?: string;
}

export interface BodyFacts {
  firstHeading: string | undefined;
  firstSentence: string | undefined;
  links: BodyLink[];
  footnoteReferences: BodyFootnoteReference[];
  /**
   * The items of the lists under a level-one `Citations` heading, up to the next heading: the OKF 0.1 provenance
   * list (§13.1). An item with exactly one link carries its URL; the page decides whether they are sources (D63).
   */
  citations: Array<{ text: string; url?: string }>;
  htmlBlocks: number;
  inlineHtml: number;
  hasScriptLike: boolean;
  /** The body nests deeper than the analyser allows; no facts were taken from it. */
  unanalysed: boolean;
  /** Only the first part of the body was analysed. */
  truncated: boolean;
  /** The body's text with blocks separated by one space, HTML and footnote marks left out; absent when unanalysed. */
  prose?: string;
}

const SENTENCE_CAP = 200;
/**
 * Characters of a prose value kept at load, then an ellipsis: a claim's block, the sentence a footnote supports
 * and not the page around it (issue 5), and a link's text and a heading, so that no row of `citations` carries a
 * value of any length (bite b's build reviews B-I-A3, B-A-A2). The same bound cuts an OKF 0.1 citation item read as
 * a source (D63, bite a's build review I-E2).
 */
export const BLOCK_CAP = 500;
export const ANALYSIS_BUDGET = 256 * 1024;
const MAX_NESTING = 256;
const MAX_EMPHASIS_RUNS = 2000;
const MAX_DEFINITIONS = 1000;
const SCRIPT_LIKE = /<\s*\/?\s*(script|style|iframe)\b/i;
const DELIMITER_RUN = /[*_]+/g;
const DEFINITION_LINE = /^ {0,3}\[[^\]]{1,999}\]:/;

/** An emphasis delimiter run that could open or close: one not wedged between two word characters. */
function isFlankingRun(text: string, start: number, end: number): boolean {
  const before = start === 0 ? " " : (text[start - 1] ?? " ");
  const after = end >= text.length ? " " : (text[end] ?? " ");
  const wordy = (c: string): boolean => /[\p{L}\p{N}]/u.test(c);
  return !(wordy(before) && wordy(after));
}

/**
 * Why a body must not be parsed, or `undefined` when it may be. The parser's cost grows with the square of the
 * number of emphasis delimiter runs and of link reference definitions, and its stack with nesting depth, so
 * each is counted before any parse. The counts are deterministic and cheap.
 */
export function analysisBounds(text: string): "nesting" | "emphasis" | "definitions" | undefined {
  if (nestingDepth(text) > MAX_NESTING) return "nesting";
  let runs = 0;
  for (const match of text.matchAll(DELIMITER_RUN)) {
    if (isFlankingRun(text, match.index, match.index + match[0].length)) runs += 1;
    if (runs > MAX_EMPHASIS_RUNS) return "emphasis";
  }
  let definitions = 0;
  for (const line of text.split("\n")) {
    if (DEFINITION_LINE.test(line)) definitions += 1;
    if (definitions > MAX_DEFINITIONS) return "definitions";
  }
  return undefined;
}

/** The deepest run of block-quote markers or unclosed brackets, measured before any parse so the bound is deterministic. */
export function nestingDepth(body: string): number {
  let deepest = 0;
  let brackets = 0;
  for (const line of body.split("\n")) {
    const quotes = (/^[ \t>]*/.exec(line)?.[0].match(/>/g) ?? []).length;
    if (quotes > deepest) deepest = quotes;
    for (const ch of line) {
      if (ch === "[") brackets += 1;
      else if (ch === "]" && brackets > 0) brackets -= 1;
      if (brackets > deepest) deepest = brackets;
    }
  }
  return deepest;
}

function isParent(node: Nodes): node is Nodes & Parent {
  return "children" in node && Array.isArray((node as Parent).children);
}

/**
 * The prose of a node, leaving out HTML and footnote marks, whitespace collapsed; a hard line break is a space, so
 * the words on either side of it stay apart (bite b's build review B-I-A5).
 */
function proseOf(node: Nodes): string {
  const parts: string[] = [];
  const stack: Nodes[] = [node];
  while (stack.length > 0) {
    const current = stack.pop() as Nodes;
    if (current.type === "html" || current.type === "footnoteReference") continue;
    if (current.type === "break") {
      parts.push(" ");
      continue;
    }
    if ("value" in current && typeof current.value === "string") parts.push(current.value);
    else if (isParent(current))
      for (let i = current.children.length - 1; i >= 0; i--)
        stack.push(current.children[i] as Nodes);
  }
  return parts.join("").replace(/\s+/g, " ").trim();
}

const BLOCKS = new Set([
  "paragraph",
  "heading",
  "blockquote",
  "list",
  "listItem",
  "code",
  "table",
  "tableRow",
  "tableCell",
  "thematicBreak",
  "footnoteDefinition",
]);

/**
 * The whole tree's prose, one space between blocks and at a hard line break, HTML and footnote marks left out,
 * whitespace collapsed.
 */
function proseWithBlocks(tree: Nodes): string {
  const parts: string[] = [];
  const stack: Nodes[] = [tree];
  while (stack.length > 0) {
    const current = stack.pop() as Nodes;
    if (current.type === "html" || current.type === "footnoteReference") continue;
    if (current.type === "break") {
      parts.push(" ");
      continue;
    }
    if (BLOCKS.has(current.type)) parts.push(" ");
    if ("value" in current && typeof current.value === "string") parts.push(current.value);
    else if (isParent(current)) {
      for (let i = current.children.length - 1; i >= 0; i--)
        stack.push(current.children[i] as Nodes);
    }
    if (BLOCKS.has(current.type)) parts.push(" ");
  }
  return parts.join("").replace(/\s+/g, " ").trim();
}

/** The blocks a footnote reference's sentence is taken from; the innermost one holding it is the one used. */
const CLAIM_BLOCKS = new Set(["paragraph", "heading", "listItem", "blockquote", "tableCell"]);

function firstSentenceOf(text: string): string {
  const match = /^(.*?[.!?])(?=\s|$)/.exec(text);
  const sentence = match?.[1] ?? text;
  return sentence.length > SENTENCE_CAP ? sentence.slice(0, SENTENCE_CAP).trimEnd() : sentence;
}

/** The URLs of the links inside a node, reference links resolved against the body's definitions. */
function urlsIn(node: Nodes, definitions: ReadonlyMap<string, string>): string[] {
  const urls: string[] = [];
  const stack: Nodes[] = [node];
  while (stack.length > 0) {
    const current = stack.pop() as Nodes;
    if (current.type === "link") urls.push(current.url);
    else if (current.type === "linkReference") {
      const url = definitions.get(current.identifier);
      if (url !== undefined) urls.push(url);
    }
    if (isParent(current))
      for (let i = current.children.length - 1; i >= 0; i--)
        stack.push(current.children[i] as Nodes);
  }
  return urls;
}

/**
 * The OKF 0.1 `# Citations` list (§13.1, D63): the items of every list that follows a level-one heading reading
 * `Citations` (case ignored) at the top of the body, up to the next heading of any level. A `## Citations`
 * subsection is a v0.2 page's own prose and is never read.
 */
function citationsOf(
  tree: Root,
  definitions: ReadonlyMap<string, string>,
): Array<{ text: string; url?: string }> {
  const items: Array<{ text: string; url?: string }> = [];
  let inside = false;
  for (const node of tree.children) {
    if (node.type === "heading") {
      inside = node.depth === 1 && proseOf(node).toLowerCase() === "citations";
      continue;
    }
    if (!inside || node.type !== "list") continue;
    for (const item of node.children) {
      const text = proseWithBlocks(item);
      if (text.length === 0) continue;
      const urls = urlsIn(item, definitions);
      items.push(urls.length === 1 ? { text, url: urls[0] as string } : { text });
    }
  }
  return items;
}

/** The value with its heading, or without the key when there is none. */
function withHeading<T extends object>(
  value: T,
  heading: string | undefined,
): T & { heading?: string } {
  return heading === undefined ? value : { ...value, heading };
}

const EMPTY: Omit<BodyFacts, "unanalysed" | "truncated"> = {
  firstHeading: undefined,
  firstSentence: undefined,
  links: [],
  footnoteReferences: [],
  citations: [],
  htmlBlocks: 0,
  inlineHtml: 0,
  hasScriptLike: false,
};

/**
 * Reads the facts the OKF layer needs from a Markdown body: CommonMark with footnotes and tables, never the
 * autolink extension, whose cost grows without bound on nested brackets. A body nested past the limit is left
 * unanalysed rather than parsed; a body past the budget is analysed up to it. The tree is walked iteratively.
 */
export function readBody(body: string): BodyFacts {
  const truncated = body.length > ANALYSIS_BUDGET;
  const text = truncated ? body.slice(0, ANALYSIS_BUDGET) : body;
  if (analysisBounds(text) !== undefined)
    return {
      ...EMPTY,
      links: [],
      footnoteReferences: [],
      citations: [],
      unanalysed: true,
      truncated,
    };
  const tree = fromMarkdown(text, {
    extensions: [gfmFootnote(), gfmTable()],
    mdastExtensions: [gfmFootnoteFromMarkdown(), gfmTableFromMarkdown()],
  });
  const facts: BodyFacts = {
    ...EMPTY,
    links: [],
    footnoteReferences: [],
    citations: [],
    unanalysed: false,
    truncated,
  };
  const definitions = new Map<string, string>();
  const references: Array<{ identifier: string; slot: number }> = [];
  // The walk is in document order, so the heading seen last is the nearest one at or before what follows; a
  // heading's own links and references see it, since a node is visited before its children.
  let heading: string | undefined;
  // One block's prose is taken once and shared by every reference it holds.
  const blockProse = new Map<Nodes, string>();
  const stack: Array<{
    node: Nodes;
    parent: Nodes | undefined;
    skipped: boolean;
    /** Inside a footnote definition, whose prose is never a claim's sentence. */
    defining: boolean;
    block: Nodes | undefined;
  }> = [{ node: tree, parent: undefined, skipped: false, defining: false, block: undefined }];
  while (stack.length > 0) {
    const { node, parent, skipped, defining, block } = stack.pop() as (typeof stack)[number];
    switch (node.type) {
      case "definition":
        definitions.set(node.identifier, node.url);
        break;
      case "heading": {
        const prose = proseOf(node);
        if (facts.firstHeading === undefined) facts.firstHeading = prose;
        heading = prose.length > 0 ? ellipsised(prose, BLOCK_CAP) : undefined;
        break;
      }
      case "paragraph":
        if (!skipped && facts.firstSentence === undefined) {
          const sentence = firstSentenceOf(proseOf(node));
          if (sentence.length > 0) facts.firstSentence = sentence;
        }
        break;
      case "link":
        facts.links.push(
          withHeading({ url: node.url, text: ellipsised(proseOf(node), BLOCK_CAP) }, heading),
        );
        break;
      case "linkReference":
        references.push({ identifier: node.identifier, slot: facts.links.length });
        facts.links.push(
          withHeading({ url: "", text: ellipsised(proseOf(node), BLOCK_CAP) }, heading),
        );
        break;
      case "footnoteReference": {
        // A reference written inside a footnote's definition, its own or another's, supports no sentence of the
        // page: the definition's prose is never a claim's (issue 5; bite b's build reviews B-I-A6, B-A-A9).
        if (defining) break;
        let prose = "";
        if (block !== undefined) {
          prose = blockProse.get(block) ?? ellipsised(proseOf(block), BLOCK_CAP);
          blockProse.set(block, prose);
        }
        facts.footnoteReferences.push(withHeading({ id: node.identifier, block: prose }, heading));
        break;
      }
      case "html":
        if (parent !== undefined && parent.type === "paragraph") facts.inlineHtml += 1;
        else facts.htmlBlocks += 1;
        if (SCRIPT_LIKE.test(node.value)) facts.hasScriptLike = true;
        break;
      default:
        break;
    }
    if (isParent(node)) {
      const skip = skipped || node.type === "footnoteDefinition" || node.type === "table";
      const inDefinition = defining || node.type === "footnoteDefinition";
      const inner = CLAIM_BLOCKS.has(node.type) ? node : block;
      for (let i = node.children.length - 1; i >= 0; i--)
        stack.push({
          node: node.children[i] as Nodes,
          parent: node,
          skipped: skip,
          defining: inDefinition,
          block: inner,
        });
    }
  }
  for (const ref of references) {
    const slot = facts.links[ref.slot];
    if (slot !== undefined) slot.url = definitions.get(ref.identifier) ?? "";
  }
  facts.links = facts.links.filter((l) => l.url !== "");
  facts.citations = citationsOf(tree, definitions);
  facts.prose = proseWithBlocks(tree);
  return facts;
}
