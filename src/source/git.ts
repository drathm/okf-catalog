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
}

export interface GitSource extends Source {
  readonly kind: "git";
  loadServed(): Promise<Loaded | undefined>;
  served(commit: string): void;
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
  /** The commit whose tree is extracted and complete. */
  extracted?: string;
  /** The commit the runtime last swapped in. */
  served?: string;
  /** The commit last fetched, extracted or refused; what `changed()` compares against. */
  lastAttempted?: string;
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
  const { repository, branch, bundlePath, workDir, caps, runner, clock } = options;
  const repoDir = join(workDir, REPO);
  const statePath = join(workDir, STATE);
  const described = redactCredentials(repository);
  let firstLoad = true;
  let fromDisk = false;

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
      const lastAttempted = hex(parsed.lastAttempted);
      if (extracted !== undefined) state.extracted = extracted;
      if (served !== undefined) state.served = served;
      if (lastAttempted !== undefined) state.lastAttempted = lastAttempted;
      if (typeof parsed.fetchedAt === "string") state.fetchedAt = parsed.fetchedAt;
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
    const tmp = `${statePath}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, statePath);
  };

  function ensureWorkDir(): void {
    mkdirSync(workDir, { recursive: true, mode: 0o700 });
    if (lstatSync(workDir).isSymbolicLink())
      throw new SourceError(
        "the source folder under the cache is a symbolic link; remove it so the server can create its own",
      );
  }
  /** Everything here is derived: when the repository or branch changed, start over. */
  function resetWorkDir(): void {
    for (const name of readdirSync(workDir))
      rmSync(join(workDir, name), { recursive: true, force: true });
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
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, bytes, { mode: 0o600 });
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
      throw error instanceof GitError
        ? failure("read", error)
        : new SourceError(
            `the repository ${described} could not be extracted: ${(error as Error).message}`,
          );
    }
  }

  function walkTree(commit: string, fetchedAt: Date): Loaded {
    const tree = treeDir(commit);
    const root = bundlePath === "." ? tree : join(tree, bundlePath);
    try {
      return { walk: walkBundle(root, caps), published: { commit, fetchedAt } };
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
    const fetchedAt = state.fetchedAt === undefined ? clock() : new Date(state.fetchedAt);
    return walkTree(state.served, Number.isNaN(fetchedAt.getTime()) ? clock() : fetchedAt);
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
      resetWorkDir();
      state = undefined;
    }
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
      if (!staleLock(error)) throw failure("fetched", error);
      rmSync(repoDir, { recursive: true, force: true });
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
      return walkTree(commit, fetchedAt);
    }
    const listing = await list(commit).catch((error: unknown) => {
      throw failure("read", error);
    });
    const refused = (refusal: Refusal): Loaded => {
      writeState({ ...base, lastAttempted: commit, fetchedAt: fetchedAt.toISOString() });
      return { walk: emptyWalk(refusal), published: { commit, fetchedAt } };
    };
    if ("refusal" in listing) return refused(listing.refusal);
    const refusal = validateTree(listing.entries, caps, bundlePath);
    if (refusal !== undefined) return refused(refusal);
    await extract(commit, listing.entries);
    writeState({ ...base, extracted: commit, fetchedAt: fetchedAt.toISOString() });
    return walkTree(commit, fetchedAt);
  }

  return {
    kind: "git",
    load,
    loadServed: async () => servedOnDisk(readState()),
    served: (commit) => {
      const state: State = {
        repository,
        branch,
        ...(readState() ?? {}),
        served: commit,
        lastAttempted: commit,
      };
      writeState(state);
      prune(state);
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
      return remote === readState()?.lastAttempted ? "same" : "moved";
    },
    describe: () => described,
    abort: () => runner.abort(),
    startedFromDisk: () => fromDisk,
  };
}
