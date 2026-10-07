import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createBatchReader } from "../bundle/cat-file.js";
import { parseLsTree, type TreeEntry, validateTree } from "../bundle/git-tree.js";
import type { Caps, Refusal } from "../bundle/model.js";
import { type WalkResult, walkBundle } from "../fs/walk.js";
import type { Log } from "../log.js";
import { GitError, type GitRunner, redactCredentials } from "./git-runner.js";
import type { Loaded, RemoteChange, Source } from "./source.js";

export interface GitSourceOptions {
  repository: string;
  branch: string;
  /** `.` or a relative path inside the published tree. */
  bundlePath: string;
  /** The folder this source owns, under the process's work folder: `<work>/source`. */
  workDir: string;
  caps: Caps;
  runner: GitRunner;
  clock: () => Date;
  log?: Log;
}

export interface GitSource extends Source {
  readonly kind: "git";
  readonly workDir: string;
  loadServed(): Promise<Loaded | undefined>;
  served(commit: string): void;
  discard(commit: string): void;
  changed(): Promise<RemoteChange>;
  abort(): void;
  /** Whether the first load answered from the tree on disk, so the poller should fetch at once. */
  startedFromDisk(): boolean;
}

/** An error whose message names the source as configured; the detail (git's words) is for the log. */
export class SourceError extends Error {
  detail?: string;
  constructor(message: string, detail?: string) {
    super(message);
    this.name = "SourceError";
    if (detail !== undefined) this.detail = detail;
  }
}

interface State {
  repository: string;
  branch: string;
  /** The commit whose tree is extracted and complete, and when it was fetched. */
  extracted?: string;
  extractedAt?: string;
  /** The commit the runtime last swapped in, and when that one was fetched. */
  served?: string;
  servedFetchedAt?: string;
  /** When the last fetch succeeded. */
  fetchedAt?: string;
}

const REPO = "repo.git";
const STATE = "state.json";
const TREE_NAME = /^tree-[0-9a-f]{40,64}$/;
const COMMIT = /^[0-9a-f]{40,64}$/;
const BATCH_MODE = "core.sshCommand=ssh -o BatchMode=yes";

/** Git's own words for a lock file left behind by a killed process; nothing else triggers a fresh clone. */
export const isStaleLockMessage = (stderr: string): boolean =>
  /Unable to create '[^']*\.lock': File exists/.test(stderr);

/**
 * The ssh setting a transport command carries: BatchMode, so a passphrase prompt cannot hang a stdio server,
 * unless the person's own `GIT_SSH_COMMAND`, `GIT_SSH` or configured `core.sshCommand` is in charge.
 */
export function sshBatchSetting(env: NodeJS.ProcessEnv, configured: string | undefined): string[] {
  if (env.GIT_SSH_COMMAND !== undefined || env.GIT_SSH !== undefined) return [];
  if (configured !== undefined && configured.length > 0) return [];
  return [BATCH_MODE];
}
const TIMEOUT_MS = {
  clone: 300_000,
  fetch: 300_000,
  lsRemote: 30_000,
  list: 300_000,
  extract: 300_000,
};
const emptyWalk = (fatal: Refusal): WalkResult => ({
  files: [],
  hidden: [],
  hiddenFolders: [],
  refusals: [],
  fatal,
});

/**
 * A published branch as the server's own derived copy (D47): a bare shallow clone for transport, each fetched commit
 * listed and validated before anything is written, then extracted blob by blob into a fresh folder named by the
 * commit, which the walker reads. Git never writes a working tree here, so no attribute, filter, hook or
 * line-ending rule can touch the bytes.
 */
export function createGitSource(options: GitSourceOptions): GitSource {
  const { repository, branch, bundlePath, workDir, caps, runner, clock, log } = options;
  const repoDir = join(workDir, REPO);
  const statePath = join(workDir, STATE);
  const described = redactCredentials(repository);
  let firstLoad = true;
  let fromDisk = false;
  /**
   * The commit last refused or served, what `changed()` compares with: kept in memory only and seeded from the
   * served commit, so a restart tries a commit again that an older configuration refused (bite 5 review BR2).
   */
  let attempted: string | undefined;
  let attemptedSeeded = false;
  const seedAttempted = (state: State | undefined): void => {
    if (attemptedSeeded) return;
    attemptedSeeded = true;
    attempted = state?.served;
  };
  /** A file-system failure as the model may see it: a fixed sentence; the path travels as detail for the log. */
  const fsFailure = (verb: string, error: unknown): SourceError =>
    new SourceError(
      `the source folder under the cache could not be ${verb}; the log has the detail`,
      (error as Error).message,
    );

  const treeDir = (commit: string): string => join(workDir, `tree-${commit}`);

  function readState(): State | undefined {
    try {
      const parsed = JSON.parse(readFileSync(statePath, "utf8")) as State;
      if (typeof parsed.repository !== "string" || typeof parsed.branch !== "string")
        return undefined;
      // A commit field that is not a hash is dropped: a name could point outside the work folder.
      const hex = (value: unknown): string | undefined =>
        typeof value === "string" && COMMIT.test(value) ? value : undefined;
      const state: State = { repository: parsed.repository, branch: parsed.branch };
      const extracted = hex(parsed.extracted);
      const served = hex(parsed.served);
      if (extracted !== undefined) state.extracted = extracted;
      if (served !== undefined) state.served = served;
      for (const key of ["fetchedAt", "extractedAt", "servedFetchedAt"] as const) {
        const value = parsed[key];
        if (typeof value === "string") state[key] = value;
      }
      return state;
    } catch {
      // no state, or not ours to read
    }
    return undefined;
  }

  /** An extracted tree is a real folder of the work folder, never a link. */
  function treeExists(commit: string): boolean {
    try {
      const stat = lstatSync(treeDir(commit));
      return stat.isDirectory() && !stat.isSymbolicLink();
    } catch {
      return false;
    }
  }
  const writeState = (state: State): void => {
    try {
      const tmp = `${statePath}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, statePath);
    } catch (error) {
      throw fsFailure("written", error);
    }
  };

  function ensureWorkDir(): void {
    try {
      mkdirSync(workDir, { recursive: true, mode: 0o700 });
    } catch (error) {
      throw fsFailure("created", error);
    }
    if (lstatSync(workDir).isSymbolicLink())
      throw new SourceError(
        "the source folder under the cache is a symbolic link; remove it so the server can create its own",
      );
  }
  /** Everything here is derived: when the repository or branch changed, start over. */
  function resetWorkDir(reason: string): void {
    log?.warn("source.recloned", { reason });
    for (const name of readdirSync(workDir))
      rmSync(join(workDir, name), { recursive: true, force: true });
  }
  function recloneRepo(reason: string): void {
    log?.warn("source.recloned", { reason });
    rmSync(repoDir, { recursive: true, force: true });
  }
  /** Whether git can still read the clone: its configuration must name the remote (a clone with it gone cannot be fetched into). */
  async function cloneReadable(): Promise<boolean> {
    try {
      const result = await runner.run(["config", "--get", "remote.origin.url"], {
        cwd: workDir,
        gitDir: repoDir,
        timeoutMs: TIMEOUT_MS.lsRemote,
      });
      return result.stdout.toString("utf8").trim() === repository;
    } catch {
      return false;
    }
  }

  const failure = (verb: string, error: unknown): SourceError => {
    const detail =
      error instanceof GitError
        ? error.stderr || error.message
        : redactCredentials((error as Error).message);
    return new SourceError(
      `the repository ${described} could not be ${verb}; the log has git's message`,
      detail,
    );
  };
  const staleLock = (error: unknown): boolean =>
    error instanceof GitError && isStaleLockMessage(error.stderr);

  /** The person's configured `core.sshCommand`, read where git would read it (includes count); nothing when unset. */
  async function configuredSshCommand(): Promise<string | undefined> {
    try {
      const result = await runner.run(["config", "--get", "core.sshCommand"], {
        cwd: workDir,
        ...(existsSync(join(repoDir, "HEAD")) ? { gitDir: repoDir } : {}),
        timeoutMs: TIMEOUT_MS.lsRemote,
      });
      const value = result.stdout.toString("utf8").trim();
      return value.length > 0 ? value : undefined;
    } catch {
      return undefined;
    }
  }
  let transportConfig: string[] = [];

  const clone = (): Promise<unknown> =>
    runner.run(
      [
        "clone",
        "--bare",
        "--depth=1",
        "--single-branch",
        `--branch=${branch}`,
        "--no-tags",
        "--template=",
        "--",
        repository,
        REPO,
      ],
      { cwd: workDir, timeoutMs: TIMEOUT_MS.clone, extraConfig: transportConfig },
    );
  const fetch = (): Promise<unknown> =>
    runner.run(
      ["fetch", "--depth=1", "--", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
      { cwd: workDir, gitDir: repoDir, timeoutMs: TIMEOUT_MS.fetch, extraConfig: transportConfig },
    );
  const resolveCommit = async (): Promise<string> => {
    const result = await runner.run(
      ["rev-parse", "--verify", "--end-of-options", `refs/remotes/origin/${branch}^{commit}`],
      { cwd: workDir, gitDir: repoDir, timeoutMs: TIMEOUT_MS.lsRemote },
    );
    const commit = result.stdout.toString("utf8").trim();
    if (!/^[0-9a-f]{40,64}$/.test(commit))
      throw new SourceError(`the repository ${described} has no commit on branch ${branch}`);
    return commit;
  };

  /** The tree listing, stopped one entry past the file cap. */
  async function list(commit: string): Promise<{ entries: TreeEntry[] } | { refusal: Refusal }> {
    const chunks: Buffer[] = [];
    let entries = 0;
    const result = await runner.run(["ls-tree", "-r", "-t", "-l", "-z", "--full-tree", commit], {
      cwd: workDir,
      gitDir: repoDir,
      timeoutMs: TIMEOUT_MS.list,
      onStdout: (chunk) => {
        chunks.push(chunk);
        for (const byte of chunk) if (byte === 0) entries += 1;
        return entries > caps.files ? "stop" : "continue";
      },
    });
    if (result.stopped)
      return {
        refusal: {
          path: "",
          rule: "too-many-files",
          detail: `more than ${caps.files} tree entries`,
        },
      };
    try {
      return { entries: parseLsTree(Buffer.concat(chunks)) };
    } catch (error) {
      return { refusal: { path: "", rule: "path-escape", detail: (error as Error).message } };
    }
  }

  /** Writes every blob of the listing, in order, into a fresh folder; raw bytes through `cat-file --batch`. */
  async function extract(commit: string, entries: readonly TreeEntry[]): Promise<void> {
    const blobs = entries
      .filter((e) => e.type === "blob")
      .map((e) => ({ sha: e.sha, size: e.size ?? 0, path: e.path }));
    const partial = join(workDir, `tree-${commit}.partial-${process.pid}`);
    rmSync(partial, { recursive: true, force: true });
    mkdirSync(partial, { recursive: true, mode: 0o700 });
    let problem: Error | undefined;
    const reader = createBatchReader(blobs, (entry, bytes) => {
      const target = join(partial, entry.path);
      try {
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
        writeFileSync(target, bytes, { mode: 0o600 });
      } catch (error) {
        throw fsFailure("written", error);
      }
    });
    try {
      if (blobs.length > 0) {
        await runner.run(["cat-file", "--batch"], {
          cwd: workDir,
          gitDir: repoDir,
          timeoutMs: TIMEOUT_MS.extract,
          input: `${blobs.map((b) => b.sha).join("\n")}\n`,
          onStdout: (chunk) => {
            try {
              reader.feed(chunk);
              return "continue";
            } catch (error) {
              problem = error as Error;
              return "stop";
            }
          },
        });
      }
      if (problem !== undefined) throw problem;
      reader.finish();
      rmSync(treeDir(commit), { recursive: true, force: true });
      renameSync(partial, treeDir(commit));
    } catch (error) {
      rmSync(partial, { recursive: true, force: true });
      if (error instanceof SourceError) throw error;
      throw error instanceof GitError
        ? failure("read", error)
        : new SourceError(
            `the repository ${described} could not be extracted; the log has the detail`,
            (error as Error).message,
          );
    }
  }

  function walkTree(commit: string, fetchedAt: Date, fresh: boolean): Loaded {
    const tree = treeDir(commit);
    const root = bundlePath === "." ? tree : join(tree, bundlePath);
    try {
      return { walk: walkBundle(root, caps), published: { commit, fetchedAt }, fresh };
    } catch (error) {
      const original = (error as Error).message;
      throw new SourceError(
        original.split(root).join(`${described}:${bundlePath}`).split(tree).join(described),
        original,
      );
    }
  }

  function servedOnDisk(state: State | undefined): Loaded | undefined {
    if (state?.served === undefined || !treeExists(state.served)) return undefined;
    const when = state.servedFetchedAt ?? state.fetchedAt;
    const fetchedAt = when === undefined ? clock() : new Date(when);
    return walkTree(state.served, Number.isNaN(fetchedAt.getTime()) ? clock() : fetchedAt, false);
  }

  /** Removes extracted trees that are neither served nor the newest, and any partial folder. */
  function prune(state: State): void {
    for (const name of readdirSync(workDir)) {
      const isTree = TREE_NAME.test(name);
      const isPartial = name.startsWith("tree-") && name.includes(".partial-");
      if (!isTree && !isPartial) continue;
      if (isTree && (name === `tree-${state.served}` || name === `tree-${state.extracted}`))
        continue;
      const full = join(workDir, name);
      const stat = lstatSync(full);
      if (stat.isDirectory() && !stat.isSymbolicLink())
        rmSync(full, { recursive: true, force: true });
    }
  }

  async function load(): Promise<Loaded> {
    ensureWorkDir();
    let state = readState();
    if (state !== undefined && (state.repository !== repository || state.branch !== branch)) {
      resetWorkDir("the configuration names another repository or branch");
      state = undefined;
    }
    seedAttempted(state);
    if (firstLoad) {
      firstLoad = false;
      const onDisk = servedOnDisk(state);
      if (onDisk !== undefined) {
        fromDisk = true;
        return onDisk;
      }
    }
    transportConfig = sshBatchSetting(runner.env, await configuredSshCommand());
    if (!existsSync(join(repoDir, "HEAD"))) {
      rmSync(repoDir, { recursive: true, force: true });
      try {
        await clone();
      } catch (error) {
        throw failure("cloned", error);
      }
    }
    try {
      await fetch();
    } catch (error) {
      // A lock file a killed git left behind, or a clone git itself can no longer read: both are derived, so a
      // fresh clone replaces them; any other failure (the network, the credential) is reported as it is.
      if (staleLock(error)) recloneRepo("a lock file was left behind by a killed git");
      else if (!(await cloneReadable())) recloneRepo("the clone could not be read");
      else throw failure("fetched", error);
      try {
        await clone();
        await fetch();
      } catch (again) {
        throw failure("fetched", again);
      }
    }
    let commit: string;
    try {
      commit = await resolveCommit();
    } catch (error) {
      throw error instanceof SourceError ? error : failure("read", error);
    }
    const fetchedAt = clock();
    const base: State = { repository, branch, ...(state ?? {}) };
    // What was attempted is recorded when a commit is refused or served, never here (bite 5 review M1): a
    // commit the runtime fails to index must look moved to the poller until it is served.
    if (state?.extracted === commit && treeExists(commit)) {
      writeState({ ...base, fetchedAt: fetchedAt.toISOString() });
      return walkTree(commit, fetchedAt, false);
    }
    const listing = await list(commit).catch((error: unknown) => {
      throw failure("read", error);
    });
    const refused = (refusal: Refusal): Loaded => {
      attempted = commit;
      writeState({ ...base, fetchedAt: fetchedAt.toISOString() });
      return { walk: emptyWalk(refusal), published: { commit, fetchedAt }, fresh: false };
    };
    if ("refusal" in listing) return refused(listing.refusal);
    const refusal = validateTree(listing.entries, caps, bundlePath);
    if (refusal !== undefined) return refused(refusal);
    await extract(commit, listing.entries);
    const next: State = {
      ...base,
      extracted: commit,
      extractedAt: fetchedAt.toISOString(),
      fetchedAt: fetchedAt.toISOString(),
    };
    writeState(next);
    // Trees the loader refused would pile up otherwise: keep the served one and this one (bite 5 review BR16).
    prune(next);
    return walkTree(commit, fetchedAt, true);
  }

  return {
    kind: "git",
    workDir,
    load,
    loadServed: async () => servedOnDisk(readState()),
    served: (commit) => {
      attempted = commit;
      const current = readState();
      const state: State = { repository, branch, ...(current ?? {}), served: commit };
      if (current?.extracted === commit && current.extractedAt !== undefined)
        state.servedFetchedAt = current.extractedAt;
      writeState(state);
      prune(state);
    },
    discard: (commit) => {
      if (!COMMIT.test(commit) || !treeExists(commit)) return;
      rmSync(treeDir(commit), { recursive: true, force: true });
      const current = readState();
      if (current?.extracted === commit) {
        const { extracted: _e, extractedAt: _a, ...rest } = current;
        writeState(rest);
      }
    },
    changed: async (): Promise<RemoteChange> => {
      if (!existsSync(join(repoDir, "HEAD"))) return "moved";
      let result: Awaited<ReturnType<GitRunner["run"]>>;
      try {
        result = await runner.run(["ls-remote", "--", "origin", `refs/heads/${branch}`], {
          cwd: workDir,
          gitDir: repoDir,
          timeoutMs: TIMEOUT_MS.lsRemote,
          extraConfig: transportConfig,
        });
      } catch (error) {
        throw failure("asked", error);
      }
      const line = result.stdout
        .toString("utf8")
        .split("\n")
        .find((l) => l.endsWith(`\trefs/heads/${branch}`));
      if (line === undefined) return "gone";
      const remote = line.split("\t")[0] ?? "";
      seedAttempted(readState());
      return remote === attempted ? "same" : "moved";
    },
    describe: () => described,
    abort: () => runner.abort(),
    startedFromDisk: () => fromDisk,
  };
}
