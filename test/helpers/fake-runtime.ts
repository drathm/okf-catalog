import { loadBundle } from "../../src/bundle/load.js";
import { type BundleFile, DEFAULT_CAPS, type LoadOptions } from "../../src/bundle/model.js";
import type { Catalog } from "../../src/catalog/model.js";
import type {
  Generation,
  Network,
  RefreshOutcome,
  Runtime,
  RuntimeStatus,
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

/** An in-memory engine with qmd's observable contract: prefix match on every term, the path as a column, SQLite's frequency floor. */
export function fakeEngine(catalog: Catalog): Engine {
  const texts = new Map<string, string[]>();
  for (const page of catalog.pages.values()) {
    const text = `${page.path} ${renderDocument(deriveDocument(page))}`.toLowerCase();
    texts.set(
      page.path,
      text.split(/[^\p{L}\p{N}\p{M}-]+/u).filter((w) => w.length > 0),
    );
  }
  const weight = (term: string): number => {
    let df = 0;
    for (const words of texts.values()) if (words.some((w) => w.startsWith(term))) df += 1;
    return df * 2 >= texts.size ? 1e-6 : 1;
  };
  return {
    async index(): Promise<IndexResult> {
      return { ...EMPTY_INDEX, documents: texts.size, indexed: texts.size };
    },
    async lex(terms, limit): Promise<EngineHit[]> {
      const hits: EngineHit[] = [];
      for (const [path, words] of texts) {
        let bm25 = 0;
        let all = true;
        for (const term of terms) {
          const n = words.filter((w) => w.startsWith(term)).length;
          if (n === 0) all = false;
          bm25 += n * weight(term);
        }
        if (all && terms.length > 0)
          hits.push({ bundle: catalog.bundle, path, bm25, score: bm25 / (1 + bm25) });
      }
      return hits.sort((a, b) => b.bm25 - a.bm25 || (a.path < b.path ? -1 : 1)).slice(0, limit);
    },
    async drop(): Promise<IndexResult> {
      return EMPTY_INDEX;
    },
    async status() {
      return { documents: texts.size };
    },
    async close() {},
  };
}

export function loadGeneration(
  files: BundleFile[],
  patch: Partial<LoadOptions>,
  now: Date,
): Generation {
  const options: LoadOptions = {
    admit: ["stable", "deprecated"],
    dev: false,
    integrity: "require-manifest",
    specText: "2026-08-15",
    caps: DEFAULT_CAPS,
    ...patch,
  };
  const { catalog, report } = loadBundle("b", files, options, now);
  return {
    catalog,
    report,
    index: { ...EMPTY_INDEX, documents: catalog.pages.size, indexed: catalog.pages.size },
    loadedAt: now,
    dev: options.dev,
    integrity: options.integrity === "require-manifest" ? "checked" : "skipped",
  };
}

/** A runtime over one fixed generation, a network of one bundle named as its catalog is, or one that refuses with a fix. */
export function fakeRuntime(
  generation: Generation | undefined,
  refusing?: string,
): Runtime & { leases: number } {
  const engine = generation === undefined ? undefined : fakeEngine(generation.catalog);
  const network: Network | undefined =
    generation === undefined
      ? undefined
      : { bundles: [{ id: generation.catalog.bundle, generation }] };
  const bundles: RuntimeStatus["bundles"] =
    generation === undefined
      ? []
      : [
          {
            id: generation.catalog.bundle,
            loaded: true,
            fatal: generation.report.fatal !== undefined,
          },
        ];
  const status: RuntimeStatus =
    refusing === undefined
      ? { lock: "exclusive", loaded: generation !== undefined, bundles }
      : { lock: "exclusive", loaded: false, refusing, bundles };
  const runtime: Runtime & { leases: number } = {
    leases: 0,
    async ready() {
      if (network === undefined || refusing !== undefined)
        throw new Error(refusing ?? "no generation");
      return network;
    },
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
