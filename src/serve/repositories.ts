import type { GitSource } from "../source/git.js";
import type { Source } from "../source/source.js";

export interface RepositorySourcesOptions {
  /** The repository bundles of the network, by id. */
  ids: readonly string[];
  /** A bundle's source as the model may see it: the repository without credentials. */
  describe: (id: string) => string;
  /**
   * Prepares git and builds every repository bundle's source (D50: git on PATH, at 2.30 or later); throws, with a
   * sentence that names no path, when git cannot be prepared.
   */
  prepare: () => Promise<ReadonlyMap<string, GitSource>>;
}

export interface RepositorySources {
  /** Prepares git once; a failure is forgotten, so the next call tries again. */
  ensure(): Promise<void>;
  /**
   * The source the runtime loads a repository bundle through: the real one once git is prepared; until then its
   * `load()` tries the preparation again, so a bundle refused because git could not be prepared is served by its
   * own next load once git can be (C-I-A3).
   */
  sourceOf(id: string): Source;
  /** A bundle's real source, once git is prepared. */
  real(id: string): GitSource | undefined;
}

/**
 * The repository bundles' sources, built once git is prepared. A network that holds a local bundle loads them through
 * `sourceOf`, so git that cannot be prepared (not on PATH, older than 2.30) is each repository bundle's own failure
 * (`load-failed`), retried by its poller, while the local bundles serve; a network of repository bundles alone
 * refuses as a whole instead, as version 0 did.
 */
export function repositorySources(options: RepositorySourcesOptions): RepositorySources {
  let built: ReadonlyMap<string, GitSource> = new Map();
  let preparing: Promise<void> | undefined;

  const ensure = (): Promise<void> => {
    if (preparing === undefined) {
      preparing = options.prepare().then(
        (sources) => {
          built = sources;
        },
        (error: unknown) => {
          preparing = undefined;
          throw error;
        },
      );
    }
    return preparing;
  };

  /** The real source, preparing git first when it is not prepared yet. */
  const prepared = async (id: string): Promise<GitSource> => {
    await ensure();
    const source = built.get(id);
    if (source === undefined)
      throw new Error(`the repository source of bundle ${id} was not built`);
    return source;
  };

  const sourceOf = (id: string): Source => ({
    kind: "git",
    load: async () => (await prepared(id)).load(),
    loadServed: async () => (await prepared(id)).loadServed(),
    served: (commit) => built.get(id)?.served(commit),
    discard: (commit) => built.get(id)?.discard(commit),
    changed: async () => (await prepared(id)).changed(),
    describe: () => options.describe(id),
    abort: () => built.get(id)?.abort(),
  });

  return { ensure, sourceOf, real: (id) => built.get(id) };
}
