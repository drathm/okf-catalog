import { buildCatalog, type Catalog, type Folder } from "../catalog/model.js";
import { admit, capRefusals, isEngineConfig, isHidden, unknownTypes } from "./contract.js";
import { decodeUtf8 } from "./frontmatter.js";
import { generateIndex, type IndexPage, parseIndex } from "./index-file.js";
import { type LinkIndex, resolveLink } from "./links.js";
import { MANIFEST_NAME, type Manifest, parseManifest, verifyManifest } from "./manifest.js";
import { ANALYSIS_BUDGET, analysisBounds } from "./markdown.js";
import type {
  BundleFile,
  Degradation,
  LoadOptions,
  Page,
  PagePath,
  Refusal,
  Report,
  ReservedFile,
} from "./model.js";
import { decideReplacement, parsePage } from "./page.js";
import { byCodeUnit, byCodeUnit as byPath, folderOf, isSafeRelativePath } from "./paths.js";
import { parseReserved, reservedKind } from "./reserved.js";

export interface LoadResult {
  catalog: Catalog;
  report: Report;
}

function ancestors(folder: string): string[] {
  const out = [""];
  if (folder === "") return out;
  const parts = folder.split("/");
  for (let i = 1; i <= parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
}

/**
 * Turns the files of a bundle into a catalog and a report. Pure: the files arrive in memory, the clock is a
 * parameter, and nothing here reads a disk or an engine. Caps are measured over every file. Reserved files are
 * routed by name before any page rule runs; non-Markdown files are attachments; hidden paths are skipped and
 * counted; the engine's own configuration is refused per path. Bundle-level refusals set `report.fatal` and
 * leave the catalog empty. A page that fails to parse for any reason is a refusal, never an exception.
 */
export function loadBundle(
  company: string,
  files: BundleFile[],
  options: LoadOptions,
  now: Date,
): LoadResult {
  const report: Report = {
    loadedAt: new Date(now.getTime()),
    integrity: options.integrity === "require-manifest" ? "checked" : "skipped",
    admitted: 0,
    excludedByStatus: 0,
    attachments: 0,
    hidden: 0,
    refusals: [...(options.walkRefusals ?? [])],
    degradations: [],
    unknownTypes: [],
    unknownStatuses: [],
    brokenLinks: [],
    linksToUnserved: [],
    missingOnDisk: [],
    foldersWithoutIndex: [],
    encodedFolders: [],
  };
  const empty = (fatal: Refusal): LoadResult => {
    report.fatal = fatal;
    return {
      catalog: buildCatalog({ company, loadedAt: now, pages: new Map(), folders: new Map() }),
      report,
    };
  };

  if (options.walkFatal !== undefined) return empty(options.walkFatal);
  // Hidden paths the walker never read: counted, and the engine's own folder refused by name.
  for (const hidden of options.hiddenPaths ?? []) {
    report.hidden += 1;
    if (isEngineConfig(hidden)) {
      report.refusals.push({
        path: hidden,
        rule: "engine-config",
        detail: "the search engine's own configuration has no place in a bundle",
      });
    }
  }
  const presentButUnread = {
    exact: [...(options.hiddenPaths ?? []), ...(options.walkRefusals ?? []).map((r) => r.path)],
    folders: [...(options.hiddenFolders ?? [])],
  };

  // Paths first: a path that is not a safe bundle path is refused before anything reads it.
  const sorted: BundleFile[] = [];
  for (const file of [...files].sort((a, b) => byPath(a.path, b.path))) {
    if (isSafeRelativePath(file.path)) sorted.push(file);
    else
      report.refusals.push({
        path: file.path,
        rule: "path-escape",
        detail:
          "not a bundle-relative path: absolute, empty or parent segments and backslashes are refused",
      });
  }

  // Caps, over everything that arrived.
  const caps = capRefusals(sorted, options.caps);
  if (caps.fatal !== undefined) return empty(caps.fatal);
  const refusedPaths = new Set(caps.perFile.map((r) => r.path));
  report.refusals.push(...caps.perFile);

  // Partition.
  let manifestFile: BundleFile | undefined;
  const reservedFiles: BundleFile[] = [];
  const pageFiles: BundleFile[] = [];
  const attachmentPaths = new Set<string>();
  for (const file of sorted) {
    if (isEngineConfig(file.path)) {
      report.refusals.push({
        path: file.path,
        rule: "engine-config",
        detail: "the search engine's own configuration has no place in a bundle",
      });
      refusedPaths.add(file.path);
      continue;
    }
    if (isHidden(file.path)) {
      report.hidden += 1;
      continue;
    }
    if (file.path === MANIFEST_NAME) manifestFile = file;
    else if (reservedKind(file.path) !== undefined) reservedFiles.push(file);
    else if (file.path.endsWith(".md")) pageFiles.push(file);
    else attachmentPaths.add(file.path);
  }

  // Integrity, against every file on disk, hidden and refused ones included: they are present, not missing.
  let manifest: Manifest | undefined;
  if (manifestFile !== undefined) {
    const parsed = parseManifest(manifestFile.bytes);
    if (parsed.ok) manifest = parsed.manifest;
    else if (options.integrity === "require-manifest") {
      return empty({ path: MANIFEST_NAME, rule: "manifest-invalid", detail: parsed.error });
    }
  } else if (options.integrity === "require-manifest") {
    return empty({
      path: MANIFEST_NAME,
      rule: "manifest-missing",
      detail: "integrity is required and the bundle has no manifest.json",
    });
  }
  if (manifest !== undefined) {
    report.commit = manifest.commit;
    if (options.integrity === "require-manifest") {
      for (const problem of verifyManifest(manifest, sorted, presentButUnread)) {
        if (problem.problem === "missing-on-disk") report.missingOnDisk.push(problem.path);
        else if (!isHidden(problem.path)) {
          refusedPaths.add(problem.path);
          report.refusals.push({
            path: problem.path,
            rule: problem.problem,
            detail:
              problem.problem === "not-in-manifest"
                ? "the manifest does not list this file"
                : `the file does not match its manifest entry (${problem.problem})`,
          });
        }
      }
    }
  }

  const keep = (file: BundleFile): boolean => !refusedPaths.has(file.path);
  const reservedKept = reservedFiles.filter(keep);
  const pagesKept = pageFiles.filter(keep);
  for (const path of refusedPaths) attachmentPaths.delete(path);
  report.attachments = attachmentPaths.size;

  // Link index over everything that is still in play.
  const linkIndex: LinkIndex = {
    pages: new Set(pagesKept.map((f) => f.path)),
    reserved: new Set(reservedKept.map((f) => f.path)),
    attachments: attachmentPaths,
    folders: new Set<string>(),
  };
  for (const file of sorted) {
    if (isHidden(file.path)) continue;
    for (const folder of ancestors(folderOf(file.path))) linkIndex.folders.add(folder);
  }

  // Reserved files.
  const reserved = new Map<string, ReservedFile>();
  for (const file of reservedKept) {
    const decoded = decodeUtf8(file.bytes);
    if (!decoded.ok) {
      report.refusals.push({
        path: file.path,
        rule: "not-utf8",
        detail: "the file is not valid UTF-8",
      });
      continue;
    }
    try {
      const parsed = parseReserved(file.path, decoded.text);
      reserved.set(file.path, parsed);
      report.degradations.push(...parsed.degradations);
    } catch (error) {
      report.degradations.push({
        path: file.path,
        code: "reserved-frontmatter-unparseable",
        field: "frontmatter",
        detail: `the file could not be read: ${(error as Error).message}`,
      });
    }
  }

  // Pages.
  const pages: Page[] = [];
  for (const file of pagesKept) {
    try {
      const result = parsePage(file, { linkIndex, specText: options.specText });
      if (result.ok) pages.push(result.page);
      else report.refusals.push(result.refusal);
    } catch (error) {
      report.refusals.push({
        path: file.path,
        rule: "body-unreadable",
        detail: `the page could not be read: ${(error as Error).message}`,
      });
    }
  }

  // Admission, then replacements, then what is reported about the admitted pages.
  const admitted = pages.filter((p) => admit(p, options.admit, options.dev));
  report.admitted = admitted.length;
  report.excludedByStatus = pages.length - admitted.length;
  for (const page of pages) {
    if (
      page.statusRaw !== undefined &&
      page.degradations.some((d) => d.code === "status-unknown")
    ) {
      report.unknownStatuses.push({ path: page.path, value: page.statusRaw });
    }
  }
  const admittedPaths = new Set<PagePath>(admitted.map((p) => p.path));
  const extra: Degradation[] = [];
  for (const page of admitted) {
    const decision = decideReplacement(page, admittedPaths);
    if (decision.replacement !== undefined) page.replacement = decision.replacement;
    if (decision.degradation !== undefined) extra.push(decision.degradation);
    for (const link of page.links) {
      if (link.kind === "broken") report.brokenLinks.push({ from: page.path, raw: link.raw });
      else if (
        link.kind === "page" &&
        link.target !== undefined &&
        !admittedPaths.has(link.target)
      ) {
        report.linksToUnserved.push({ from: page.path, raw: link.raw, target: link.target });
      }
    }
  }
  for (const page of admitted) report.degradations.push(...page.degradations);
  report.degradations.push(...extra);
  // A company's own index that lists pages which are not served is reported, since the catalog serves it as written.
  for (const index of reserved.values()) {
    if (index.kind !== "index") continue;
    // An index past the analysis bounds is served as written but not read: its parse could take minutes.
    const bound = index.body.length > ANALYSIS_BUDGET ? "size" : analysisBounds(index.body);
    if (bound !== undefined) {
      report.degradations.push({
        path: index.path,
        code: "reserved-unanalysed",
        field: "body",
        detail: `the index was not analysed (${bound} beyond the analysis bounds); it is served as written`,
      });
      continue;
    }
    let entries: ReturnType<typeof parseIndex>[number]["entries"];
    try {
      entries = parseIndex(index.body).flatMap((s) => s.entries);
    } catch (error) {
      report.degradations.push({
        path: index.path,
        code: "reserved-unanalysed",
        field: "body",
        detail: `the index could not be read: ${(error as Error).message}`,
      });
      continue;
    }
    const unserved: string[] = [];
    for (const entry of entries) {
      const resolved = resolveLink(entry.href, index.path, linkIndex);
      if (
        resolved.kind === "page" &&
        resolved.target !== undefined &&
        !admittedPaths.has(resolved.target)
      )
        unserved.push(resolved.target);
    }
    if (unserved.length > 0) {
      report.degradations.push({
        path: index.path,
        code: "index-lists-unserved",
        field: "entries",
        detail: `${unserved.length} ${unserved.length === 1 ? "entry points" : "entries point"} at pages that are not served: ${unserved.slice(0, 5).join(", ")}${unserved.length > 5 ? ", …" : ""}`,
      });
    }
  }
  report.unknownTypes = unknownTypes(admitted, options.types);

  // Folders: every ancestor of an admitted page, plus every folder that holds a reserved file.
  const folderNames = new Set<string>([""]);
  for (const page of admitted) for (const f of ancestors(page.folder)) folderNames.add(f);
  for (const file of reservedKept)
    for (const f of ancestors(folderOf(file.path))) folderNames.add(f);
  const folders = new Map<string, Folder>();
  const indexPages: IndexPage[] = admitted.map((p) => {
    const entry: IndexPage = { path: p.path, title: p.title };
    if (p.description !== undefined) entry.description = p.description;
    return entry;
  });
  for (const name of [...folderNames].sort(byPath)) {
    const prefix = name === "" ? "" : `${name}/`;
    const own = admitted
      .filter((p) => p.folder === name)
      .map((p) => p.path)
      .sort(byPath);
    const subfolders = [...folderNames]
      .filter(
        (f) =>
          f !== "" && f !== name && f.startsWith(prefix) && !f.slice(prefix.length).includes("/"),
      )
      .sort(byPath);
    const indexPath = name === "" ? "index.md" : `${name}/index.md`;
    const logPath = name === "" ? "log.md" : `${name}/log.md`;
    const fileIndex = reserved.get(indexPath);
    const folder: Folder = {
      indexSource: fileIndex === undefined ? "generated" : "file",
      pages: own,
      subfolders,
    };
    if (fileIndex !== undefined) folder.index = fileIndex;
    else {
      // Subfolder links in a generated index are relative to the folder, as §8 shows them.
      const body = generateIndex(
        name,
        indexPages,
        subfolders.map((f) => f.slice(prefix.length)),
      );
      folder.index = {
        kind: "index",
        path: indexPath,
        folder: name,
        body,
        text: body,
        degradations: [],
      };
      report.foldersWithoutIndex.push(name);
    }
    const log = reserved.get(logPath);
    if (log !== undefined) folder.log = log;
    folders.set(name, folder);
  }

  const pageMap = new Map<PagePath, Page>(admitted.map((p) => [p.path, p]));
  const okfVersion = reserved.get("index.md")?.okfVersion;
  const input: Parameters<typeof buildCatalog>[0] = {
    company,
    loadedAt: now,
    pages: pageMap,
    folders,
  };
  if (report.commit !== undefined) input.commit = report.commit;
  if (okfVersion !== undefined) input.okfVersion = okfVersion;
  return { catalog: buildCatalog(input), report: ordered(report) };
}

/** Refusals and missing paths in path order, whatever order the walker or the manifest produced them in. */
function ordered(report: Report): Report {
  report.refusals.sort((a, b) => byCodeUnit(a.path, b.path) || byCodeUnit(a.rule, b.rule));
  report.missingOnDisk.sort(byCodeUnit);
  return report;
}
