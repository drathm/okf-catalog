import type { Link, Page, PagePath, PathEdge, ReservedFile } from "../bundle/model.js";
import { byCodeUnit } from "../bundle/paths.js";

export interface Folder {
  /** The folder's index: the company's own file, or one generated from the folder's admitted pages. */
  index?: ReservedFile;
  indexSource: "file" | "generated";
  log?: ReservedFile;
  pages: PagePath[];
  subfolders: string[];
}

/**
 * The edges that point at each admitted page, built with the catalog from its own pages and rebuilt with it, so a
 * path is never joined to a page of another bundle (issue 5, D69). Each list runs in path order, then document
 * order. Nothing here is a store of its own: the entries are the pages' stored links and classified path fields.
 */
export interface Graph {
  /** Body links on admitted pages whose stored target is the page, a self-link included. */
  inboundMentions: ReadonlyMap<PagePath, ReadonlyArray<{ from: PagePath; link: Link }>>;
  /**
   * `resource` and `sources[].resource` edges of admitted pages that name the page, as a concept or as one of an
   * ambiguous edge's names; a contract field never derives.
   */
  inboundDerivations: ReadonlyMap<PagePath, ReadonlyArray<{ from: PagePath; edge: PathEdge }>>;
}

/** The immutable view of one loaded bundle: admitted pages only, folders with their index and log, pages by type. */
export interface Catalog {
  /** The bundle's id in its network (D72); two bundles are two catalogs, never one. */
  bundle: string;
  commit?: string;
  loadedAt: Date;
  okfVersion?: string;
  pages: ReadonlyMap<PagePath, Page>;
  folders: ReadonlyMap<string, Folder>;
  byType: ReadonlyMap<string, PagePath[]>;
  graph: Graph;
}

function buildGraph(pages: ReadonlyMap<PagePath, Page>): Graph {
  const inboundMentions = new Map<PagePath, Array<{ from: PagePath; link: Link }>>();
  const inboundDerivations = new Map<PagePath, Array<{ from: PagePath; edge: PathEdge }>>();
  const add = <T>(map: Map<PagePath, T[]>, key: PagePath, value: T): void => {
    const list = map.get(key);
    if (list === undefined) map.set(key, [value]);
    else list.push(value);
  };
  for (const from of [...pages.keys()].sort(byCodeUnit)) {
    const page = pages.get(from) as Page;
    for (const link of page.links) {
      if (link.kind === "page" && link.target !== undefined && pages.has(link.target))
        add(inboundMentions, link.target, { from, link });
    }
    for (const edge of page.pathEdges) {
      if (edge.role !== "resource" && edge.role !== "source") continue;
      if (edge.kind === "concept" && edge.target !== undefined)
        add(inboundDerivations, edge.target, { from, edge });
      else if (edge.kind === "ambiguous") {
        for (const name of edge.candidates ?? [])
          if (pages.has(name)) add(inboundDerivations, name, { from, edge });
      }
    }
  }
  return { inboundMentions, inboundDerivations };
}

export function buildCatalog(input: {
  bundle: string;
  commit?: string;
  loadedAt: Date;
  okfVersion?: string;
  pages: Map<PagePath, Page>;
  folders: Map<string, Folder>;
}): Catalog {
  const byType = new Map<string, PagePath[]>();
  for (const page of input.pages.values()) {
    const list = byType.get(page.type) ?? [];
    list.push(page.path);
    byType.set(page.type, list);
  }
  for (const list of byType.values()) list.sort();
  const catalog: Catalog = {
    bundle: input.bundle,
    loadedAt: input.loadedAt,
    pages: input.pages,
    folders: input.folders,
    byType,
    graph: buildGraph(input.pages),
  };
  if (input.commit !== undefined) catalog.commit = input.commit;
  if (input.okfVersion !== undefined) catalog.okfVersion = input.okfVersion;
  return catalog;
}

export function getPage(catalog: Catalog, path: PagePath): Page | undefined {
  return catalog.pages.get(path);
}

export function getFolder(catalog: Catalog, folder: string): Folder | undefined {
  return catalog.folders.get(folder);
}

export function listTypes(catalog: Catalog): string[] {
  return [...catalog.byType.keys()].sort();
}

/** Every distinct tag spelling stored on an admitted page, sorted as the types are (issue 4). */
export function listTags(catalog: Catalog): string[] {
  const tags = new Set<string>();
  for (const page of catalog.pages.values()) for (const tag of page.tags) tags.add(tag);
  return [...tags].sort();
}

/** Every status an admitted page is served with, sorted as the types are (issue 4). */
export function listStatuses(catalog: Catalog): string[] {
  return [...new Set([...catalog.pages.values()].map((page) => page.status))].sort();
}
