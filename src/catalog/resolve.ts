import type { Page, PagePath, Refusal, ReservedFile } from "../bundle/model.js";
import { conceptNames } from "../bundle/paths.js";
import type { Catalog } from "./model.js";
import { nearestPaths } from "./nearest.js";

/** One loaded bundle as the resolver sees it: its id, its catalog, and its refusal when it was refused. */
export interface BundleView {
  bundle: string;
  catalog: Catalog;
  fatal?: Refusal;
}

/** What a name resolved to: an admitted page, or a served reserved file (an index, generated or not, or a log). */
export type Found =
  | { kind: "page"; bundle: string; path: PagePath; page: Page }
  | {
      kind: "reserved";
      bundle: string;
      path: string;
      file: ReservedFile;
      source: "file" | "generated";
    };

export type Resolution =
  | { ok: true; name: string; found: Found }
  | {
      ok: false;
      reason: "not-found";
      name: string;
      /** The bundle read, when one was: named by the caller, or by a printed name's prefix. */
      bundle?: string;
      /** The three nearest served paths, each with its bundle: of the bundle read, else of every served bundle. */
      nearest: Array<{ bundle: string; path: string }>;
    }
  | {
      ok: false;
      reason: "ambiguous";
      name: string;
      /**
       * Each file the name means, in bundle order then name order, with a name that means it alone (`ask`); `ask`
       * is absent when no name does, as for the middle file of a chain of three (D60's recorded limit).
       */
      candidates: Array<{ bundle: string; path: string; ask?: string }>;
    }
  | { ok: false; reason: "unknown-bundle"; bundle: string; bundles: string[] }
  | { ok: false; reason: "refused-bundle"; bundle: string; fatal: Refusal };

/** A name as the model may write it: trimmed, one leading `/` or `./` stripped once (OKF bundle-absolute links). */
export const pageName = (value: string): string => value.trim().replace(/^(\.\/|\/)/, "");

/** The reserved file served at a path: a folder's index (the company's own or the generated one) or its log. */
export function reservedAt(
  catalog: Catalog,
  path: string,
): { file: ReservedFile; source: "file" | "generated" } | undefined {
  const slash = path.lastIndexOf("/");
  const folder = slash === -1 ? "" : path.slice(0, slash);
  const name = slash === -1 ? path : path.slice(slash + 1);
  const entry = catalog.folders.get(folder);
  if (entry === undefined) return undefined;
  if (name === "index.md" && entry.index !== undefined)
    return { file: entry.index, source: entry.indexSource };
  if (name === "log.md" && entry.log !== undefined) return { file: entry.log, source: "file" };
  return undefined;
}

/** Every path a bundle serves through `get_page`: its admitted pages, and each folder's index and log. */
export function servedPaths(catalog: Catalog): string[] {
  const paths = [...catalog.pages.keys()];
  for (const [folder, entry] of catalog.folders) {
    const prefix = folder === "" ? "" : `${folder}/`;
    if (entry.index !== undefined) paths.push(`${prefix}index.md`);
    if (entry.log !== undefined) paths.push(`${prefix}log.md`);
  }
  return paths;
}

function lookup(view: BundleView, path: string): Found | undefined {
  const page = view.catalog.pages.get(path);
  if (page !== undefined) return { kind: "page", bundle: view.bundle, path, page };
  const reserved = reservedAt(view.catalog, path);
  if (reserved !== undefined) return { kind: "reserved", bundle: view.bundle, path, ...reserved };
  return undefined;
}

/**
 * A name that means this path alone in its bundle: the concept id when nothing else answers to it, else the path
 * when nothing else answers to that. For `foo.md` beside `foo.md.md` that is `foo` and `foo.md.md`. Only a chain of
 * three such names (`foo.md`, `foo.md.md`, `foo.md.md.md`) leaves the middle one with no name of its own: then
 * there is none, and the caller says so rather than offer a name that answers with the same ambiguity. The
 * uniqueness is the bundle's own (D60): across bundles a name is told apart by the bundle's id, which the caller
 * names beside it (D74).
 */
export function uniqueName(view: BundleView, path: string): string | undefined {
  const alone = (name: string): boolean =>
    conceptNames(name).filter((candidate) => lookup(view, candidate) !== undefined).length === 1;
  const id = path.endsWith(".md") ? path.slice(0, -".md".length) : path;
  if (id !== path && alone(id)) return id;
  return alone(path) ? path : undefined;
}

/** A `\u` escape as a line writes a character a reader cannot see (`escapeControls`): `\uXXXX` or `\u{XXXXX}`. */
const ESCAPED = /\\u\{([0-9a-f]{1,6})\}|\\u([0-9a-f]{4})/g;

/**
 * A name as the server prints it, read back (C-A-A2): `<bundle>:<path>` when `<bundle>` is a bundle of the network,
 * and a path that is not plain quoted, alone or after its bundle, as a JSON string whose `\u` escapes stand for the
 * characters a line writes so. Undefined for a name that is neither. A bundle path never holds a backslash, so an
 * escape read back cannot be part of a path.
 */
function printedName(
  value: string,
  bundles: readonly BundleView[],
): { bundle?: string; path: string } | undefined {
  let rest = value.trim();
  let bundle: string | undefined;
  const colon = rest.indexOf(":");
  if (colon > 0 && bundles.some((view) => view.bundle === rest.slice(0, colon))) {
    bundle = rest.slice(0, colon);
    rest = rest.slice(colon + 1);
  }
  if (rest.startsWith('"')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rest);
    } catch {
      return undefined;
    }
    if (typeof parsed !== "string") return undefined;
    rest = parsed.replace(ESCAPED, (_, wide: string | undefined, narrow: string | undefined) =>
      String.fromCodePoint(Number.parseInt(wide ?? narrow ?? "0", 16)),
    );
  } else if (bundle === undefined) return undefined;
  return bundle === undefined ? { path: rest } : { bundle, path: rest };
}

/**
 * Turns the name a caller gives (`/p.md`, `./p.md`, `p.md`, or the concept id `p`) into the one page or reserved
 * file it means, or a precise error (D60, D74): not found, with the three nearest served paths and their bundles;
 * ambiguous, when the name is one file's path and another's concept id, or names files in two bundles, with each
 * candidate, its bundle and a name that means it alone in that bundle; or, when a bundle is named, an unknown or a
 * refused bundle. A named bundle is the only one read. A refused bundle is never a candidate, nor among the
 * nearest. Nothing is preferred silently: an ambiguous name is an error, as issues 3 and 5 ask. A name the server
 * prints is taken back (C-A-A2): when no page answers to the name as written, `<bundle>:<path>` is `<path>` in that
 * bundle (when no other bundle is named), and a quoted path is the path it quotes.
 */
export function resolvePageName(
  bundles: readonly BundleView[],
  value: string,
  bundle?: string,
): Resolution {
  const literal = resolveWritten(bundles, value, bundle);
  if (literal.ok || literal.reason !== "not-found") return literal;
  const printed = printedName(value, bundles);
  if (printed === undefined) return literal;
  if (printed.bundle !== undefined && bundle !== undefined && printed.bundle !== bundle)
    return literal;
  return resolveWritten(bundles, printed.path, printed.bundle ?? bundle);
}

/** The name as written, read in the bundles given or in the one named. */
function resolveWritten(
  bundles: readonly BundleView[],
  value: string,
  bundle?: string,
): Resolution {
  const name = pageName(value);
  let views: BundleView[];
  if (bundle === undefined) views = bundles.filter((view) => view.fatal === undefined);
  else {
    const view = bundles.find((candidate) => candidate.bundle === bundle);
    if (view === undefined)
      return {
        ok: false,
        reason: "unknown-bundle",
        bundle,
        bundles: bundles.map((candidate) => candidate.bundle),
      };
    if (view.fatal !== undefined)
      return { ok: false, reason: "refused-bundle", bundle, fatal: view.fatal };
    views = [view];
  }
  const found: Array<{ view: BundleView; found: Found }> = [];
  for (const view of views) {
    for (const candidate of conceptNames(name)) {
      const hit = lookup(view, candidate);
      if (hit !== undefined) found.push({ view, found: hit });
    }
  }
  const [only] = found;
  if (only !== undefined && found.length === 1) return { ok: true, name, found: only.found };
  if (found.length > 1) {
    return {
      ok: false,
      reason: "ambiguous",
      name,
      candidates: found.map(({ view, found: hit }) => {
        const ask = uniqueName(view, hit.path);
        return {
          bundle: hit.bundle,
          path: hit.path,
          ...(ask === undefined ? {} : { ask }),
        };
      }),
    };
  }
  // The nearest paths over every bundle read, each path then each bundle that serves it, in bundle order.
  const bundlesOf = new Map<string, string[]>();
  for (const view of views) {
    for (const path of servedPaths(view.catalog)) {
      const holders = bundlesOf.get(path);
      if (holders === undefined) bundlesOf.set(path, [view.bundle]);
      else holders.push(view.bundle);
    }
  }
  const nearest = nearestPaths(bundlesOf.keys(), name)
    .flatMap((path) => (bundlesOf.get(path) ?? []).map((holder) => ({ bundle: holder, path })))
    .slice(0, NEAREST);
  return {
    ok: false,
    reason: "not-found",
    name,
    ...(bundle === undefined ? {} : { bundle }),
    nearest,
  };
}

/** How many nearest paths a not-found answer names. */
const NEAREST = 3;
