import type { Nodes, Parent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFootnoteFromMarkdown } from "mdast-util-gfm-footnote";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmFootnote } from "micromark-extension-gfm-footnote";
import { gfmTable } from "micromark-extension-gfm-table";

export interface BodyFacts {
  firstHeading: string | undefined;
  firstSentence: string | undefined;
  links: Array<{ url: string; text: string }>;
  footnoteReferences: string[];
  htmlBlocks: number;
  inlineHtml: number;
  hasScriptLike: boolean;
  /** The body nests deeper than the analyser allows; no facts were taken from it. */
  unanalysed: boolean;
  /** Only the first part of the body was analysed. */
  truncated: boolean;
}

const SENTENCE_CAP = 200;
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

/** The prose of a node, leaving out HTML and footnote marks, whitespace collapsed. */
function proseOf(node: Nodes): string {
  const parts: string[] = [];
  const stack: Nodes[] = [node];
  while (stack.length > 0) {
    const current = stack.pop() as Nodes;
    if (current.type === "html" || current.type === "footnoteReference") continue;
    if ("value" in current && typeof current.value === "string") parts.push(current.value);
    else if (isParent(current))
      for (let i = current.children.length - 1; i >= 0; i--)
        stack.push(current.children[i] as Nodes);
  }
  return parts.join("").replace(/\s+/g, " ").trim();
}

function firstSentenceOf(text: string): string {
  const match = /^(.*?[.!?])(?=\s|$)/.exec(text);
  const sentence = match?.[1] ?? text;
  return sentence.length > SENTENCE_CAP ? sentence.slice(0, SENTENCE_CAP).trimEnd() : sentence;
}

const EMPTY: Omit<BodyFacts, "unanalysed" | "truncated"> = {
  firstHeading: undefined,
  firstSentence: undefined,
  links: [],
  footnoteReferences: [],
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
    return { ...EMPTY, links: [], footnoteReferences: [], unanalysed: true, truncated };
  const tree = fromMarkdown(text, {
    extensions: [gfmFootnote(), gfmTable()],
    mdastExtensions: [gfmFootnoteFromMarkdown(), gfmTableFromMarkdown()],
  });
  const facts: BodyFacts = {
    ...EMPTY,
    links: [],
    footnoteReferences: [],
    unanalysed: false,
    truncated,
  };
  const definitions = new Map<string, string>();
  const references: Array<{ identifier: string; slot: number }> = [];
  const stack: Array<{ node: Nodes; parent: Nodes | undefined; skipped: boolean }> = [
    { node: tree, parent: undefined, skipped: false },
  ];
  while (stack.length > 0) {
    const { node, parent, skipped } = stack.pop() as {
      node: Nodes;
      parent: Nodes | undefined;
      skipped: boolean;
    };
    switch (node.type) {
      case "definition":
        definitions.set(node.identifier, node.url);
        break;
      case "heading":
        if (facts.firstHeading === undefined) facts.firstHeading = proseOf(node);
        break;
      case "paragraph":
        if (!skipped && facts.firstSentence === undefined) {
          const sentence = firstSentenceOf(proseOf(node));
          if (sentence.length > 0) facts.firstSentence = sentence;
        }
        break;
      case "link":
        facts.links.push({ url: node.url, text: proseOf(node) });
        break;
      case "linkReference":
        references.push({ identifier: node.identifier, slot: facts.links.length });
        facts.links.push({ url: "", text: proseOf(node) });
        break;
      case "footnoteReference":
        facts.footnoteReferences.push(node.identifier);
        break;
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
      for (let i = node.children.length - 1; i >= 0; i--)
        stack.push({ node: node.children[i] as Nodes, parent: node, skipped: skip });
    }
  }
  for (const ref of references) {
    const slot = facts.links[ref.slot];
    if (slot !== undefined) slot.url = definitions.get(ref.identifier) ?? "";
  }
  facts.links = facts.links.filter((l) => l.url !== "");
  return facts;
}
