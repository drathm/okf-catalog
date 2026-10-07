import type { Nodes, Parent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { toString as mdastToString } from "mdast-util-to-string";
import { gfm } from "micromark-extension-gfm";

export interface BodyFacts {
  firstHeading: string | undefined;
  firstSentence: string | undefined;
  links: Array<{ url: string; text: string }>;
  footnoteReferences: string[];
  htmlBlocks: number;
  inlineHtml: number;
  hasScriptLike: boolean;
}

const SENTENCE_CAP = 200;
const SCRIPT_LIKE = /<\s*\/?\s*(script|style|iframe)\b/i;

function isParent(node: Nodes): node is Nodes & Parent {
  return "children" in node && Array.isArray((node as Parent).children);
}

function firstSentenceOf(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  const match = /^(.*?[.!?])(?=\s|$)/.exec(collapsed);
  const sentence = match?.[1] ?? collapsed;
  return sentence.length > SENTENCE_CAP ? sentence.slice(0, SENTENCE_CAP).trimEnd() : sentence;
}

/** Reads the facts the OKF layer needs from a Markdown body, parsed as GFM so tables and footnotes are what they are. */
export function readBody(body: string): BodyFacts {
  const tree = fromMarkdown(body, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  const definitions = new Map<string, string>();
  const facts: BodyFacts = {
    firstHeading: undefined,
    firstSentence: undefined,
    links: [],
    footnoteReferences: [],
    htmlBlocks: 0,
    inlineHtml: 0,
    hasScriptLike: false,
  };
  const pending: Array<{ identifier: string; position: number }> = [];

  const visit = (node: Nodes, parent: Nodes | undefined, inSkipped: boolean): void => {
    switch (node.type) {
      case "definition":
        definitions.set(node.identifier, node.url);
        break;
      case "heading":
        if (facts.firstHeading === undefined) facts.firstHeading = mdastToString(node).trim();
        break;
      case "paragraph":
        if (!inSkipped && facts.firstSentence === undefined) {
          const sentence = firstSentenceOf(mdastToString(node));
          if (sentence.length > 0) facts.firstSentence = sentence;
        }
        break;
      case "link":
        facts.links.push({ url: node.url, text: mdastToString(node) });
        break;
      case "linkReference":
        pending.push({ identifier: node.identifier, position: facts.links.length });
        facts.links.push({ url: "", text: mdastToString(node) });
        break;
      case "footnoteReference":
        facts.footnoteReferences.push(node.identifier);
        break;
      case "html": {
        if (parent !== undefined && parent.type === "paragraph") facts.inlineHtml += 1;
        else facts.htmlBlocks += 1;
        if (SCRIPT_LIKE.test(node.value)) facts.hasScriptLike = true;
        break;
      }
      default:
        break;
    }
    if (isParent(node)) {
      const skip = inSkipped || node.type === "footnoteDefinition" || node.type === "table";
      for (const child of node.children) visit(child as Nodes, node, skip);
    }
  };
  visit(tree, undefined, false);

  for (const ref of pending) {
    const url = definitions.get(ref.identifier);
    const slot = facts.links[ref.position];
    if (slot !== undefined) slot.url = url ?? "";
  }
  facts.links = facts.links.filter((l) => l.url !== "");
  return facts;
}
