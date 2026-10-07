import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createStore, type QMDStore } from "@tobilu/qmd";
import { byCodeUnit, folderOf } from "../bundle/paths.js";
import type { DerivedDocument } from "../derive/derived-document.js";
import type { Engine, EngineHit, IndexResult } from "../search/engine.js";
import { decodePath, encodePath, renderDocument } from "./qmd-render.js";

export interface QmdEngineOptions {
  /** The company name: one qmd collection, one path segment. */
  company: string;
  /** The engine's working directory: generation folders, the `derived` link, and the SQLite store. */
  dir: string;
  /** Render the OKF metadata as a `qmd: metadata:` block (off until a qmd release reads it, decision D30). */
  renderMetadataBlock?: boolean;
}

const LINK = "derived";

/**
 * The qmd adapter. Each `index` writes a new generation folder, flips the `derived` link to it with
 * `symlink` then `rename` so there is never a moment without a live folder, removes older generations, runs
 * qmd's `update()` on the linked folder, and compares qmd's document count with what was written, naming any
 * gap. Paths go through the codec so a folder qmd would skip, or a name it mangles, still round-trips.
 */
export class QmdEngine implements Engine {
  private generation = 0;

  private constructor(
    private readonly store: QMDStore,
    private readonly options: QmdEngineOptions,
  ) {}

  static async open(options: QmdEngineOptions): Promise<QmdEngine> {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(options.company)) {
      throw new Error(
        `company must be one lower-case path segment, got ${JSON.stringify(options.company)}`,
      );
    }
    mkdirSync(options.dir, { recursive: true });
    const store = await createStore({
      dbPath: join(options.dir, "index.sqlite"),
      config: {
        collections: { [options.company]: { path: join(options.dir, LINK), pattern: "**/*.md" } },
      },
    });
    return new QmdEngine(store, options);
  }

  async index(docs: readonly DerivedDocument[]): Promise<IndexResult> {
    this.generation += 1;
    const gen = join(this.options.dir, `gen-${Date.now()}-${this.generation}`);
    const encodedFolders = new Set<string>();
    const written = new Set<string>();
    for (const doc of docs) {
      const encoded = encodePath(doc.path);
      const folder = folderOf(doc.path);
      if (folder !== "" && encodePath(folder) !== folder) encodedFolders.add(folder);
      const target = join(gen, encoded);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(
        target,
        renderDocument(doc, { metadataBlock: this.options.renderMetadataBlock === true }),
      );
      written.add(doc.path);
    }
    if (docs.length === 0) mkdirSync(gen, { recursive: true });
    if (!existsSync(gen) || written.size !== docs.length) {
      throw new Error(
        `the generation folder does not hold every rendered document (${written.size} of ${docs.length})`,
      );
    }
    // Flip the link: a new link under a temporary name, then an atomic rename over the live one.
    const tmp = join(this.options.dir, `${LINK}.tmp-${this.generation}`);
    rmSync(tmp, { force: true });
    symlinkSync(gen, tmp);
    renameSync(tmp, join(this.options.dir, LINK));
    for (const name of readdirSync(this.options.dir)) {
      if (name.startsWith("gen-") && join(this.options.dir, name) !== gen)
        rmSync(join(this.options.dir, name), { recursive: true, force: true });
    }
    const update = await this.store.update();
    const documents = (await this.store.getStatus()).totalDocuments;
    const notIndexed: string[] = [];
    if (documents !== docs.length) {
      const listed = await this.store.multiGet(`${this.options.company}/**`);
      const indexed = new Set(
        listed.docs
          .map((d) => this.decode(d.doc.displayPath))
          .filter((p): p is string => p !== undefined),
      );
      for (const doc of docs) if (!indexed.has(doc.path)) notIndexed.push(doc.path);
    }
    return {
      documents,
      indexed: update.indexed,
      updated: update.updated,
      unchanged: update.unchanged,
      removed: update.removed,
      skipped: update.skipped,
      notIndexed: notIndexed.sort(byCodeUnit),
      encodedFolders: [...encodedFolders].sort(byCodeUnit),
    };
  }

  async lex(terms: readonly string[], limit: number): Promise<EngineHit[]> {
    if (terms.length === 0) return [];
    const rows = await this.store.searchLex(terms.join(" "), { limit });
    const hits: EngineHit[] = [];
    for (const row of rows) {
      const path = this.decode(row.displayPath);
      if (path === undefined) continue;
      const score = row.score;
      hits.push({ path, score, bm25: score >= 1 ? Number.MAX_SAFE_INTEGER : score / (1 - score) });
    }
    return hits;
  }

  async status(): Promise<{ documents: number }> {
    return { documents: (await this.store.getStatus()).totalDocuments };
  }

  async close(): Promise<void> {
    await this.store.close();
  }

  /** `<company>/<encoded path>` back to the bundle path; a hit from another collection is dropped. */
  private decode(displayPath: string): string | undefined {
    const slash = displayPath.indexOf("/");
    if (slash === -1 || displayPath.slice(0, slash) !== this.options.company) return undefined;
    return decodePath(displayPath.slice(slash + 1));
  }
}
