import type { WalkResult } from "../fs/walk.js";

/** What a load produced: the walked files, and for a repository source the fetched commit and when. */
export interface Loaded {
  walk: WalkResult;
  published?: { commit: string; fetchedAt: Date };
  /** Whether the tree was extracted by this load, or reused from disk (a reused tree the loader refuses is discarded). */
  fresh?: boolean;
}

export type RemoteChange = "same" | "moved" | "gone";

/**
 * Where a bundle comes from. `load()` is the whole fetch-and-walk; a repository source also remembers which tree
 * is served, can hand it back when a fresh load fails, can say whether the remote moved, and can be aborted.
 */
export interface Source {
  readonly kind: "local" | "git";
  load(): Promise<Loaded>;
  /** The tree last served, from disk; undefined when there is none. */
  loadServed?(): Promise<Loaded | undefined>;
  /** Told after each swap which commit is served, so older trees can go. */
  served?(commit: string): void;
  /** Removes an extracted tree the loader refused, so the next load extracts it again. */
  discard?(commit: string): void;
  /** Whether the remote moved since the last attempted commit; throws when it cannot be asked. */
  changed?(): Promise<RemoteChange>;
  /** The source as configured, never a resolved or cache path, never a credential. */
  describe(): string;
  /** Ends any transport command in flight. */
  abort?(): void;
}
