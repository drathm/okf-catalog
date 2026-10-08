import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createStore, type QMDStore } from "@tobilu/qmd";
import { byCodeUnit, collisionKey, folderOf } from "../bundle/paths.js";
import type { DerivedDocument } from "../derive/derived-document.js";
import type { Engine, EngineHit, IndexResult } from "../search/engine.js";
import { decodePath, encodePath, renderDocument } from "./qmd-render.js";

export interface QmdEngineOptions {
  /** The network's bundle ids: one qmd collection each, named by the id, each one path segment (D73). */
  bundles: readonly string[];
  /** The engine's working directory: the SQLite store, and under `bundles/<id>/` each bundle's generation folders and `derived` link. */
  dir: string;
  /** Render the OKF metadata as a `qmd: metadata:` block (off until a qmd release reads it, decision D30). */
  renderMetadataBlock?: boolean;
}

const LINK = "derived";
const DB = "index.sqlite";
const BUNDLES = "bundles";
const GENERATION = /^gen-\d+-\d+-\d+$/;
const TEMP_LINK = /^derived\.tmp-\d+$/;
/** A bundle id: one lower-case path segment, the configuration's rule (D76). */
const BUNDLE_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * The qmd adapter: one store for the network, one qmd collection per bundle, named by the bundle's id and rooted at
 * that bundle's own `derived` link under `bundles/<id>/` (D73). Each `index(bundle, …)` writes a new generation
 * folder for that bundle, flips its `derived` link to it (by base name, with `symlink` then `rename`, so there is
 * never a moment without a live folder and the link holds wherever the directory is mounted), runs qmd's
 * `update()` scoped to that bundle's collection, so no other bundle is scanned or deactivated, compares qmd's count
 * for the collection with what was written, names any gap, and only then removes that bundle's older generations.
 * `drop(bundle)` is an index of nothing: an empty generation behind the link deactivates every page of the
 * bundle, which leaves the FTS table and so the statistics every score is computed from (D75). Searches are not
 * scoped: one FTS5 table serves every collection, so every score is on one scale. Paths go through the codec so a
 * folder qmd would skip, or a name it mangles, still round-trips; two paths that would be one file on a
 * case-insensitive disk are a collision everywhere, and only the first by path order is written. One process
 * owns a directory: `open()` rebuilds a store that holds a collection that is not a configured bundle and clears
 * what an earlier run left behind, a version 0 server's root link and generations included, and the engine
 * refuses a second `index()` while one is running, for any bundle; the per-network lock that keeps two processes
 * apart is the composition layer's (decision D32).
 */
export class QmdEngine implements Engine {
  private generation = 0;
  private indexing = false;
  private readonly bundles: ReadonlySet<string>;
  /** Set when `open()` found rows outside the configured bundles in the store and rebuilt it; for the caller's log. */
  readonly resetOnOpen: string | undefined;

  private constructor(
    private readonly store: QMDStore,
    private readonly options: QmdEngineOptions,
    resetOnOpen: string | undefined,
  ) {
    this.bundles = new Set(options.bundles);
    this.resetOnOpen = resetOnOpen;
  }

  static async open(options: QmdEngineOptions): Promise<QmdEngine> {
    if (options.bundles.length === 0) throw new Error("the engine needs at least one bundle");
    for (const id of options.bundles) {
      if (!BUNDLE_ID.test(id)) {
        throw new Error(
          `a bundle id must be one lower-case path segment, got ${JSON.stringify(id)}`,
        );
      }
    }
    if (new Set(options.bundles).size !== options.bundles.length)
      throw new Error("a bundle id is listed twice");
    const dir = resolve(options.dir);
    mkdirSync(dir, { recursive: true });
    QmdEngine.clearVersion0(dir);
    for (const id of options.bundles) {
      const own = join(dir, BUNDLES, id);
      mkdirSync(own, { recursive: true });
      QmdEngine.clearLeftovers(own);
    }
    const config = {
      collections: Object.fromEntries(
        options.bundles.map((id) => [
          id,
          { path: join(dir, BUNDLES, id, LINK), pattern: "**/*.md" },
        ]),
      ),
    };
    let reset: string | undefined;
    let store: Awaited<ReturnType<typeof createStore>>;
    let status: Awaited<ReturnType<Awaited<ReturnType<typeof createStore>>["getStatus"]>>;
    try {
      store = await createStore({ dbPath: join(dir, DB), config });
      try {
        status = await store.getStatus();
      } catch (error) {
        await store.close().catch(() => undefined);
        throw error;
      }
    } catch (error) {
      // A derived store that is not a database any more, at open or at its first read, is rebuilt once (D48);
      // any other failure is a failure and the file stays as it was.
      const code = String((error as { code?: string }).code ?? "");
      if (code !== "SQLITE_NOTADB" && !code.startsWith("SQLITE_CORRUPT")) throw error;
      QmdEngine.removeStore(dir);
      reset = `the store could not be opened (${code}: ${(error as Error).message}); it was rebuilt`;
      store = await createStore({ dbPath: join(dir, DB), config });
      status = await store.getStatus();
    }
    // qmd deletes a dropped collection's row at open and leaves its pages active and searchable (finding 5), so
    // a store with pages outside the configured bundles, or a count that does not add up, is rebuilt; a version 0
    // store whose one collection is the configured bundle's id opens as it is, with nothing to re-index (P19).
    const own = status.collections
      .filter((c) => options.bundles.includes(c.name))
      .reduce((sum, c) => sum + c.documents, 0);
    const others = status.collections
      .filter((c) => !options.bundles.includes(c.name))
      .map((c) => c.name);
    if (others.length > 0 || status.totalDocuments !== own) {
      reset = `the store held ${status.totalDocuments - own} document(s) outside the configured bundles (${others.join(", ") || "no collection"}); it was rebuilt`;
      await store.close();
      QmdEngine.removeStore(dir);
      store = await createStore({ dbPath: join(dir, DB), config });
    }
    return new QmdEngine(store, { ...options, dir }, reset);
  }

  /** The store and its sidecars; the lock database in the same folder is never touched. */
  private static removeStore(dir: string): void {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      rmSync(join(dir, `${DB}${suffix}`), { force: true });
    }
  }

  /**
   * What a version 0 server kept at the root of its folder (D73): the `derived` link, its temporary links and its
   * generations. The store beside them is kept; the bundle's pages are written under `bundles/<id>/` from now on.
   */
  private static clearVersion0(dir: string): void {
    for (const name of readdirSync(dir)) {
      if (name === LINK || TEMP_LINK.test(name) || GENERATION.test(name)) {
        rmSync(join(dir, name), { recursive: true, force: true });
      }
    }
  }

  /** Temporary links a crash left behind, and generation folders the live link does not name, are removed. */
  private static clearLeftovers(dir: string): void {
    let live: string | undefined;
    try {
      live = readlinkSync(join(dir, LINK));
    } catch {
      live = undefined;
    }
    for (const name of readdirSync(dir)) {
      if (TEMP_LINK.test(name) || (GENERATION.test(name) && name !== live)) {
        rmSync(join(dir, name), { recursive: true, force: true });
      }
    }
  }

  private requireBundle(bundle: string): void {
    if (!this.bundles.has(bundle)) {
      throw new Error(
        `${JSON.stringify(bundle)} is not a bundle of this engine (${[...this.bundles].join(", ")})`,
      );
    }
  }

  async index(bundle: string, docs: readonly DerivedDocument[]): Promise<IndexResult> {
    this.requireBundle(bundle);
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
      const own = join(this.options.dir, BUNDLES, bundle);
      const genName = `gen-${Date.now()}-${process.pid}-${this.generation}`;
      const gen = join(own, genName);
      mkdirSync(gen, { recursive: true });
      const encodedFolders = new Set<string>();
      const written = new Set<string>();
      const notIndexed = new Set<string>();
      const collisions: IndexResult["collisions"] = [];
      const seen = new Map<string, string>();
      for (const doc of [...docs].sort((a, b) => byCodeUnit(a.path, b.path))) {
        const encoded = encodePath(doc.path);
        const key = collisionKey(encoded);
        const kept = seen.get(key);
        if (kept !== undefined) {
          collisions.push({ kept, dropped: doc.path });
          notIndexed.add(doc.path);
          continue;
        }
        seen.set(key, doc.path);
        const folder = folderOf(doc.path);
        if (folder !== "" && encodePath(folder) !== folder) encodedFolders.add(folder);
        const target = join(gen, encoded);
        try {
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(
            target,
            renderDocument(doc, { metadataBlock: this.options.renderMetadataBlock === true }),
          );
        } catch {
          // A name the file system cannot hold (too long once encoded, for one) costs that page, not the index.
          notIndexed.add(doc.path);
          continue;
        }
        written.add(doc.path);
      }
      // What is on disk is what qmd will see: count it before handing the folder over.
      const onDisk = countFiles(gen);
      if (onDisk !== written.size) {
        throw new Error(
          `the generation folder holds ${onDisk} files for ${written.size} rendered documents`,
        );
      }
      // Flip the link: a new link under a temporary name, then an atomic rename over the live one.
      const tmp = join(own, `${LINK}.tmp-${this.generation}`);
      rmSync(tmp, { force: true });
      symlinkSync(genName, tmp);
      renameSync(tmp, join(own, LINK));
      // Scoped to this bundle's collection: qmd scans and deactivates inside it alone (finding 1).
      const update = await this.store.update({ collections: [bundle] });
      const documents = await this.ownCount(bundle);
      if (documents !== written.size) {
        const listed = await this.store.multiGet(`${bundle}/**`);
        const indexed = new Set(
          listed.docs
            .map((d) => this.decode(d.doc.displayPath))
            .filter((hit) => hit !== undefined && hit.bundle === bundle)
            .map((hit) => (hit as { path: string }).path),
        );
        for (const path of written) if (!indexed.has(path)) notIndexed.add(path);
      }
      // Only now, with the new index in place, remove this bundle's older generations; a failure above leaves them
      // behind for the next run to clear, and the live link never names a folder that is gone.
      for (const name of readdirSync(own)) {
        if (GENERATION.test(name) && name !== genName) {
          rmSync(join(own, name), { recursive: true, force: true });
        }
      }
      return {
        documents,
        indexed: update.indexed,
        updated: update.updated,
        unchanged: update.unchanged,
        removed: update.removed,
        skipped: update.skipped,
        notIndexed: [...notIndexed].sort(byCodeUnit),
        collisions: collisions.sort((a, b) => byCodeUnit(a.kept, b.kept)),
        encodedFolders: [...encodedFolders].sort(byCodeUnit),
      };
    } finally {
      this.indexing = false;
    }
  }

  /** An empty generation behind the bundle's link and a scoped update: its pages leave search and the statistics (D75). */
  async drop(bundle: string): Promise<IndexResult> {
    return this.index(bundle, []);
  }

  async lex(terms: readonly string[], limit: number): Promise<EngineHit[]> {
    if (terms.length === 0) return [];
    // Not scoped to a collection: one query over the network's FTS table, no over-fetch (section 4, finding 6).
    const rows = await this.store.searchLex(terms.join(" "), { limit });
    const hits: EngineHit[] = [];
    for (const row of rows) {
      const located = this.decode(row.displayPath);
      if (located === undefined) continue;
      const score = row.score;
      hits.push({
        ...located,
        score,
        bm25: score >= 1 ? Number.MAX_SAFE_INTEGER : score / (1 - score),
      });
    }
    return hits;
  }

  async status(bundle?: string): Promise<{ documents: number }> {
    if (bundle !== undefined) {
      this.requireBundle(bundle);
      return { documents: await this.ownCount(bundle) };
    }
    const status = await this.store.getStatus();
    return {
      documents: status.collections
        .filter((c) => this.bundles.has(c.name))
        .reduce((sum, c) => sum + c.documents, 0),
    };
  }

  async close(): Promise<void> {
    await this.store.close();
  }

  /** The active document count of one bundle's collection, not of the whole store. */
  private async ownCount(bundle: string): Promise<number> {
    const status = await this.store.getStatus();
    return status.collections.find((c) => c.name === bundle)?.documents ?? 0;
  }

  /** `<bundle>/<encoded path>` back to the bundle and its path; a row of a collection that is not a bundle is dropped. */
  private decode(displayPath: string): { bundle: string; path: string } | undefined {
    const slash = displayPath.indexOf("/");
    if (slash === -1) return undefined;
    const bundle = displayPath.slice(0, slash);
    if (!this.bundles.has(bundle)) return undefined;
    return { bundle, path: decodePath(displayPath.slice(slash + 1)) };
  }
}

/** Regular files under a folder, counted without following links. */
function countFiles(root: string): number {
  let count = 0;
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop() as string;
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      const stat = lstatSync(path);
      if (stat.isDirectory()) pending.push(path);
      else if (stat.isFile()) count += 1;
    }
  }
  return count;
}
