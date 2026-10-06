import type { Page, PagePath, ReservedFile } from "../bundle/model.js";

export interface Folder {
  /** The folder's index: the company's own file, or one generated from the folder's admitted pages. */
  index?: ReservedFile;
  indexSource: "file" | "generated";
  log?: ReservedFile;
  pages: PagePath[];
  subfolders: string[];
}

/** The immutable view of one loaded bundle: admitted pages only, folders with their index and log, pages by type. */
export interface Catalog {
  company: string;
  commit?: string;
  loadedAt: Date;
  okfVersion?: string;
  pages: ReadonlyMap<PagePath, Page>;
  folders: ReadonlyMap<string, Folder>;
  byType: ReadonlyMap<string, PagePath[]>;
}

export function buildCatalog(input: {
  company: string;
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
    company: input.company,
    loadedAt: input.loadedAt,
    pages: input.pages,
    folders: input.folders,
    byType,
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
