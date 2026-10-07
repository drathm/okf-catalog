import type { ListItem, Nodes, Parent, PhrasingContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { toString as mdastToString } from "mdast-util-to-string";
import { byCodeUnit } from "./paths.js";

export interface IndexEntry {
  title: string;
  href: string;
  description?: string;
}

export interface IndexSection {
  heading: string;
  entries: IndexEntry[];
}

const SEPARATOR = /^\s*[-–—]\s*/;

function entryOf(item: ListItem): IndexEntry | undefined {
  const paragraph = item.children.find((c) => c.type === "paragraph");
  if (paragraph === undefined) return undefined;
  const children = paragraph.children as PhrasingContent[];
  const at = children.findIndex((c) => c.type === "link");
  const link = children[at];
  if (link === undefined || link.type !== "link") return undefined;
  const rest = children
    .slice(at + 1)
    .map((c) => mdastToString(c))
    .join("")
    .replace(SEPARATOR, "")
    .trim();
  const entry: IndexEntry = { title: mdastToString(link).trim(), href: link.url };
  if (rest.length > 0) entry.description = rest;
  return entry;
}

/** Reads a §8 index body: headings open sections, list items with a link are entries, `- description` follows the link. */
export function parseIndex(body: string): IndexSection[] {
  const tree = fromMarkdown(body);
  const sections: IndexSection[] = [];
  let current: IndexSection | undefined;
  const open = (heading: string): IndexSection => {
    const section: IndexSection = { heading, entries: [] };
    sections.push(section);
    return section;
  };
  for (const node of (tree as Parent).children as Nodes[]) {
    if (node.type === "heading") {
      current = open(mdastToString(node).trim());
    } else if (node.type === "list") {
      for (const item of node.children) {
        const entry = entryOf(item);
        if (entry === undefined) continue;
        if (current === undefined) current = open("");
        current.entries.push(entry);
      }
    }
  }
  return sections;
}

export interface IndexPage {
  path: string;
  title: string;
  description?: string;
}

/** Text safe inside a link's square brackets or after it: whitespace collapsed, brackets and backslashes escaped, markup disarmed. */
function prose(s: string): string {
  return s
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\\[\]]/g, (c) => `\\${c}`)
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** A relative link target with each segment percent-encoded, so a space or a parenthesis cannot break the link. */
const href = (relative: string): string => relative.split("/").map(encodeURIComponent).join("/");

/** Writes a §8 index for one folder: a Pages section with relative links, then a Subfolders section; empty sections are omitted. */
export function generateIndex(folder: string, pages: IndexPage[], subfolders: string[]): string {
  const prefix = folder === "" ? "" : `${folder}/`;
  const lines: string[] = [];
  const own = pages
    .filter((p) => p.path.startsWith(prefix) && !p.path.slice(prefix.length).includes("/"))
    .sort((a, b) => byCodeUnit(a.path, b.path));
  if (own.length > 0) {
    lines.push("# Pages", "");
    for (const page of own) {
      const target = href(page.path.slice(prefix.length));
      const description = page.description === undefined ? "" : prose(page.description);
      lines.push(
        description.length > 0
          ? `* [${prose(page.title)}](${target}) - ${description}`
          : `* [${prose(page.title)}](${target})`,
      );
    }
    lines.push("");
  }
  const subs = [...subfolders].sort(byCodeUnit);
  if (subs.length > 0) {
    lines.push("# Subfolders", "");
    for (const sub of subs) lines.push(`* [${prose(sub)}](${href(sub)}/)`);
    lines.push("");
  }
  return lines.join("\n");
}
