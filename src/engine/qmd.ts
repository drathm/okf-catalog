import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
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
const DB = "index.sqlite";

/**
 * The qmd adapter. Each `index` writes a new generation folder, flips the `derived` link to it (by base name,
 * with `symlink` then `rename`, so there is never a moment without a live folder and the link holds wherever
 * the directory is mounted), runs qmd's `update()` on the linked folder, compares qmd's count for this
 * collection with what was written, names any gap, and only then removes the older generations. Paths go
 * through the codec so a folder qmd would skip, or a name it mangles, still round-trips. One process owns a
 * directory: `open()` rebuilds a store that holds another collection's rows, and `index()` refuses to run twice
 * at once; the per-company lock that keeps two processes apart is the composition layer's (decision D32).
 */
export class QmdEngine implements Engine {
  private generation = 0;
  private indexing = false;
  /** Set when `open()` found another collection's rows in the store and rebuilt it; for the caller's log. */
  readonly resetOnOpen: string | undefined;

  private constructor(
    private readonly store: QMDStore,
    private readonly options: QmdEngineOptions,
    resetOnOpen: string | undefined,
  ) {
    this.resetOnOpen = resetOnOpen;
  }

  static async open(options: QmdEngineOptions): Promise<QmdEngine> {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(options.company)) {
      throw new Error(
        `company must be one lower-case path segment, got ${JSON.stringify(options.company)}`,
      );
    }
    const dir = resolve(options.dir);
    mkdirSync(dir, { recursive: true });
    const config = {
      collections: { [options.company]: { path: join(dir, LINK), pattern: "**/*.md" } },
    };
    let store = await createStore({ dbPath: join(dir, DB), config });
    let reset: string | undefined;
    const status = await store.getStatus();
    const own = status.collections.find((c) => c.name === options.company)?.documents ?? 0;
    const others = status.collections.filter((c) => c.name !== options.company).map((c) => c.name);
    if (others.length > 0 || status.totalDocuments !== own) {
      reset = `the store held ${status.totalDocuments - own} document(s) outside the ${options.company} collection (${others.join(", ") || "no collection"}); it was rebuilt`;
      await store.close();
      for (const suffix of ["", "-wal", "-shm", "-journal"]) {
        rmSync(join(dir, `${DB}${suffix}`), { force: true });
      }
      store = await createStore({ dbPath: join(dir, DB), config });
    }
    return new QmdEngine(store, { ...options, dir }, reset);
  }

  async index(docs: readonly DerivedDocument[]): Promise<IndexResult> {
    if (this.indexing) {
      throw new Error(
        "index() is already running for this engine; refresh is single-flight in the composition layer (D28)",
      );
    }
    this.indexing = true;
    try {
      // The loader has already refused unsafe paths; this guard keeps a caller that bypassed it from writing
      // outside the generation folder. A backslash is allowed here: the codec percent-encodes it.
      for (const doc of docs) {
        const segments = doc.path.split("/");
        if (doc.path.startsWith("/") || segments.some((s) => s === "" || s === "." || s === "..")) {
          throw new Error(`${doc.path} is not a safe bundle path`);
        }
      }
      this.generation += 1;
      const genName = `gen-${Date.now()}-${this.generation}`;
      const gen = join(this.options.dir, genName);
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
      symlinkSync(genName, tmp);
      renameSync(tmp, join(this.options.dir, LINK));
      const update = await this.store.update();
      const documents = await this.ownCount();
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
      // Only now, with the new index in place, remove the older generations; a failure above leaves them behind
      // for the next run to clear, and the live link never names a folder that is gone.
      for (const name of readdirSync(this.options.dir)) {
        if (name.startsWith("gen-") && name !== genName) {
          rmSync(join(this.options.dir, name), { recursive: true, force: true });
        }
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
    } finally {
      this.indexing = false;
    }
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
    return { documents: await this.ownCount() };
  }

  async close(): Promise<void> {
    await this.store.close();
  }

  /** The active document count of this company's collection, not of the whole store. */
  private async ownCount(): Promise<number> {
    const status = await this.store.getStatus();
    return status.collections.find((c) => c.name === this.options.company)?.documents ?? 0;
  }

  /** `<company>/<encoded path>` back to the bundle path; a hit from another collection is dropped. */
  private decode(displayPath: string): string | undefined {
    const slash = displayPath.indexOf("/");
    if (slash === -1 || displayPath.slice(0, slash) !== this.options.company) return undefined;
    return decodePath(displayPath.slice(slash + 1));
  }
}
