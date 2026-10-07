import type { PagePath } from "../bundle/model.js";
import type { DerivedDocument } from "../derive/derived-document.js";

export interface EngineHit {
  path: PagePath;
  /** qmd's score in [0, 1). */
  score: number;
  /** The raw BM25 value recovered from the score: on one scale for every query, and additive across terms. */
  bm25: number;
}

export interface IndexResult {
  documents: number;
  indexed: number;
  updated: number;
  unchanged: number;
  removed: number;
  skipped: number;
  /** Rendered documents the engine did not index, by bundle path: a path that collided, could not be written, or was skipped by the engine. */
  notIndexed: PagePath[];
  /** Paths that name the same file once case and Unicode form are ignored; the first by path order is kept. */
  collisions: Array<{ kept: PagePath; dropped: PagePath }>;
  /** Bundle folders whose names had to be encoded for the engine. */
  encodedFolders: string[];
}

/** The search engine as the OKF layer sees it. The adapter owns files, paths and the engine's conventions. */
export interface Engine {
  index(docs: readonly DerivedDocument[]): Promise<IndexResult>;
  /** Every term must match as a prefix; `limit` is exact; hits come best first. */
  lex(terms: readonly string[], limit: number): Promise<EngineHit[]>;
  status(): Promise<{ documents: number }>;
  close(): Promise<void>;
}
