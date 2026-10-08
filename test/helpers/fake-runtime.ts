import { loadBundle } from "../../src/bundle/load.js";
import { type BundleFile, DEFAULT_CAPS, type LoadOptions } from "../../src/bundle/model.js";
import type { Catalog } from "../../src/catalog/model.js";
import type {
  Generation,
  Network,
  RefreshOutcome,
  Runtime,
  RuntimeStatus,
  ToolOptions,
} from "../../src/catalog/runtime.js";
import { deriveDocument } from "../../src/derive/derived-document.js";
import { renderDocument } from "../../src/engine/qmd-render.js";
import type { Engine, EngineHit, IndexResult } from "../../src/search/engine.js";

const EMPTY_INDEX: IndexResult = {
  documents: 0,
  indexed: 0,
  updated: 0,
  unchanged: 0,
  removed: 0,
  skipped: 0,
  notIndexed: [],
  collisions: [],
  encodedFolders: [],
};

/**
 * An in-memory engine with qmd's observable contract: prefix match on every term, the path as a column, SQLite's
 * frequency floor; one table for every catalog it is given, as the network's index is (D73), each hit with its
 * bundle.
 */
export function fakeEngine(catalogs: Catalog | readonly Catalog[]): Engine {
  const texts: Array<{ bundle: string; path: string; words: string[] }> = [];
  for (const catalog of Array.isArray(catalogs) ? catalogs : [catalogs as Catalog]) {
    for (const page of catalog.pages.values()) {
      const text =
        `${catalog.bundle} ${page.path} ${renderDocument(deriveDocument(page))}`.toLowerCase();
      texts.push({
        bundle: catalog.bundle,
        path: page.path,
        words: text.split(/[^\p{L}\p{N}\p{M}-]+/u).filter((w) => w.length > 0),
      });
    }
  }
  const weight = (term: string): number => {
    let df = 0;
    for (const { words } of texts) if (words.some((w) => w.startsWith(term))) df += 1;
    return df * 2 >= texts.length ? 1e-6 : 1;
  };
  return {
    async index(): Promise<IndexResult> {
      return { ...EMPTY_INDEX, documents: texts.length, indexed: texts.length };
    },
    async lex(terms, limit): Promise<EngineHit[]> {
      const hits: EngineHit[] = [];
      for (const { bundle, path, words } of texts) {
        let bm25 = 0;
        let all = true;
        for (const term of terms) {
          const n = words.filter((w) => w.startsWith(term)).length;
          if (n === 0) all = false;
          bm25 += n * weight(term);
        }
        if (all && terms.length > 0) hits.push({ bundle, path, bm25, score: bm25 / (1 + bm25) });
      }
      return hits
        .sort(
          (a, b) =>
            b.bm25 - a.bm25 ||
            (a.path < b.path ? -1 : a.path > b.path ? 1 : a.bundle < b.bundle ? -1 : 1),
        )
        .slice(0, limit);
    },
    async drop(): Promise<IndexResult> {
      return EMPTY_INDEX;
    },
    async status() {
      return { documents: texts.length };
    },
    async close() {},
  };
}

/** A generation of one bundle, `b` unless another id is given. */
export function loadGeneration(
  files: BundleFile[],
  patch: Partial<LoadOptions>,
  now: Date,
  bundle = "b",
): Generation {
  const options: LoadOptions = {
    admit: ["stable", "deprecated"],
    dev: false,
    integrity: "require-manifest",
    specText: "2026-08-15",
    caps: DEFAULT_CAPS,
    ...patch,
  };
  const { catalog, report } = loadBundle(bundle, files, options, now);
  return {
    catalog,
    report,
    index: { ...EMPTY_INDEX, documents: catalog.pages.size, indexed: catalog.pages.size },
    loadedAt: now,
    dev: options.dev,
    integrity: options.integrity === "require-manifest" ? "checked" : "skipped",
  };
}

/**
 * A runtime over fixed generations: one, a network of one bundle named as its catalog is, or several, a network of
 * those bundles in that order; or one that refuses with a fix.
 */
export function fakeRuntime(
  generations: Generation | readonly Generation[] | undefined,
  refusing?: string,
): Runtime & { leases: number } {
  const list =
    generations === undefined
      ? []
      : Array.isArray(generations)
        ? (generations as readonly Generation[])
        : [generations as Generation];
  const engine = list.length === 0 ? undefined : fakeEngine(list.map((g) => g.catalog));
  const network: Network | undefined =
    list.length === 0
      ? undefined
      : { bundles: list.map((generation) => ({ id: generation.catalog.bundle, generation })) };
  const bundles: RuntimeStatus["bundles"] = list.map((generation) => ({
    id: generation.catalog.bundle,
    loaded: true,
    fatal: generation.report.fatal !== undefined,
  }));
  const status: RuntimeStatus =
    refusing === undefined
      ? { lock: "exclusive", loaded: list.length > 0, bundles }
      : { lock: "exclusive", loaded: false, refusing, bundles };
  const runtime: Runtime & { leases: number } = {
    leases: 0,
    async ready() {
      if (network === undefined || refusing !== undefined)
        throw new Error(refusing ?? "no generation");
      return network;
    },
    snapshot: () => network ?? { bundles: [] },
    async lease(fn) {
      if (network === undefined || engine === undefined || refusing !== undefined) {
        throw new Error(refusing ?? "no generation");
      }
      runtime.leases += 1;
      return fn(network, engine);
    },
    async refresh(): Promise<RefreshOutcome> {
      return { outcome: "failed", error: "the fake runtime does not refresh" };
    },
    status: () => status,
    async shutdown() {},
  };
  return runtime;
}

/** The tool options of a network of these bundles, each a local source at `./<id>` unless given. */
export function toolOptions(
  network: string,
  bundles: ReadonlyArray<string | { id: string; source: string; sourceKind: "local" | "git" }>,
  patch: Partial<Omit<ToolOptions, "network" | "bundles">> = {},
): ToolOptions {
  return {
    network,
    bundles: bundles.map((bundle) =>
      typeof bundle === "string"
        ? { id: bundle, source: `./${bundle}`, sourceKind: "local" as const }
        : bundle,
    ),
    limitDefault: 8,
    resultBudget: 40_000,
    ...patch,
  };
}
