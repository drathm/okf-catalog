import type { BundleFile, Caps, Page, Refusal, Status } from "./model.js";

/** The company's admission rule. The development flag admits drafts, and so the unknown statuses read as draft. */
export function admit(page: Page, admitStatuses: Status[], dev: boolean): boolean {
  return admitStatuses.includes(page.status) || (dev && page.status === "draft");
}

/** Type values the company did not declare. Nothing is unknown when nothing is declared. */
export function unknownTypes(pages: Page[], declared: string[] | undefined): string[] {
  if (declared === undefined || declared.length === 0) return [];
  const known = new Set(declared);
  const unknown = new Set<string>();
  for (const page of pages) if (!known.has(page.type)) unknown.add(page.type);
  return [...unknown].sort();
}

/** A path with a dot-leading segment is hidden: skipped and counted, never a page or an attachment. */
export function isHidden(path: string): boolean {
  return path.split("/").some((segment) => segment.startsWith("."));
}

/** The search engine's own configuration has no business inside a bundle; such a path is refused. */
export function isEngineConfig(path: string): boolean {
  return path.split("/").some((segment) => segment === ".qmd");
}

/** Caps: one oversize file is refused on its own; too many files or too large a tree refuses the bundle. */
export function capRefusals(
  files: BundleFile[],
  caps: Caps,
): { fatal?: Refusal; perFile: Refusal[] } {
  const perFile: Refusal[] = [];
  let total = 0;
  for (const file of files) {
    total += file.bytes.length;
    if (file.bytes.length > caps.fileBytes) {
      perFile.push({
        path: file.path,
        rule: "oversize",
        detail: `${file.bytes.length} bytes exceeds the cap of ${caps.fileBytes}`,
      });
    }
  }
  if (files.length > caps.files) {
    return {
      fatal: {
        path: "",
        rule: "too-many-files",
        detail: `${files.length} files exceeds the cap of ${caps.files}`,
      },
      perFile,
    };
  }
  if (total > caps.treeBytes) {
    return {
      fatal: {
        path: "",
        rule: "tree-too-large",
        detail: `${total} bytes exceeds the cap of ${caps.treeBytes}`,
      },
      perFile,
    };
  }
  return { perFile };
}
