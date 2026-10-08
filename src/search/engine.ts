import type { PagePath } from "../bundle/model.js";
import type { DerivedDocument } from "../derive/derived-document.js";

export interface EngineHit {
  /** The bundle the page is in: one of the network's bundle ids (D73, D74). */
  bundle: string;
  /** The page's path inside its bundle. */
  path: PagePath;
  /** qmd's score in [0, 1). */
  score: number;
  /** The raw BM25 value recovered from the score: on one scale for every query and every bundle, and additive across terms. */
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

/**
 * The search engine as the OKF layer sees it: one index for the network, one part of it per bundle (D73). The
 * adapter owns files, paths and the engine's conventions.
 */
export interface Engine {
  /** Replaces one bundle's documents with these; no other bundle's documents are read, written or deactivated. */
  index(bundle: string, docs: readonly DerivedDocument[]): Promise<IndexResult>;
  /** Takes one bundle's documents out of search and out of the statistics every score is computed from (D75). */
  drop(bundle: string): Promise<IndexResult>;
  /** Every term must match as a prefix; `limit` is exact, over every bundle at once; hits come best first. */
  lex(terms: readonly string[], limit: number): Promise<EngineHit[]>;
  /** The documents indexed for one bundle, or for every bundle when none is named. */
  status(bundle?: string): Promise<{ documents: number }>;
  close(): Promise<void>;
}
