import { describe, expect, it } from "vitest";
import { repositorySources } from "../../src/serve/repositories.js";
import type { GitSource } from "../../src/source/git.js";
import type { Loaded } from "../../src/source/source.js";

/** A stand-in for a prepared repository source, recording what it is asked. */
function fakeGit(id: string) {
  const calls: string[] = [];
  const source: GitSource = {
    kind: "git",
    workDir: `/work/bundles/${id}/source`,
    load: async (): Promise<Loaded> => {
      calls.push("load");
      return { walk: { files: [], hidden: [], hiddenFolders: [], refusals: [] } };
    },
    loadServed: async () => {
      calls.push("loadServed");
      return undefined;
    },
    served: (commit) => void calls.push(`served ${commit}`),
    discard: (commit) => void calls.push(`discard ${commit}`),
    changed: async () => {
      calls.push("changed");
      return "same";
    },
    abort: () => void calls.push("abort"),
    describe: () => `git@example.test:acme/${id}.git`,
    startedFromDisk: () => false,
  };
  return { source, calls };
}

// The fold of bite c's build reviews, C-I-A3: when the network holds a local bundle, git that cannot be prepared (not
// on PATH, older than 2.30) is each repository bundle's own failure, retried by that bundle's next load.
describe("repositorySources", () => {
  it("fails each repository bundle's load with the preparation's sentence, and tries the preparation again at its next load", async () => {
    let attempts = 0;
    const one = fakeGit("one");
    const two = fakeGit("two");
    const repositories = repositorySources({
      ids: ["one", "two"],
      describe: (id) => `git@example.test:acme/${id}.git`,
      prepare: async () => {
        attempts += 1;
        if (attempts === 1)
          throw new Error(
            "git was not found on PATH; install git 2.30 or later to serve a repository source",
          );
        return new Map([
          ["one", one.source],
          ["two", two.source],
        ]);
      },
    });
    const placeholder = repositories.sourceOf("one");
    expect(placeholder.kind).toBe("git");
    expect(placeholder.describe()).toBe("git@example.test:acme/one.git");
    await expect(placeholder.load()).rejects.toThrow(/git was not found on PATH/);
    expect(repositories.real("one")).toBeUndefined();
    // The next load prepares git again, once for both bundles, and goes through the real source from then on.
    const [first, second] = await Promise.all([
      placeholder.load(),
      repositories.sourceOf("two").load(),
    ]);
    expect(first.walk.files).toEqual([]);
    expect(second.walk.files).toEqual([]);
    expect(attempts).toBe(2);
    expect(repositories.real("one")).toBe(one.source);
    await placeholder.load();
    expect(attempts).toBe(2);
    expect(await placeholder.changed?.()).toBe("same");
    placeholder.served?.("a".repeat(40));
    placeholder.discard?.("b".repeat(40));
    expect(await placeholder.loadServed?.()).toBeUndefined();
    placeholder.abort?.();
    expect(one.calls).toEqual([
      "load",
      "load",
      "changed",
      `served ${"a".repeat(40)}`,
      `discard ${"b".repeat(40)}`,
      "loadServed",
      "abort",
    ]);
    expect(two.calls).toEqual(["load"]);
  });

  it("prepares once when the first preparation succeeds, and asks nothing of a source it has not built", async () => {
    let attempts = 0;
    const one = fakeGit("one");
    const repositories = repositorySources({
      ids: ["one"],
      describe: (id) => id,
      prepare: async () => {
        attempts += 1;
        return new Map([["one", one.source]]);
      },
    });
    await repositories.ensure();
    await repositories.ensure();
    expect(attempts).toBe(1);
    // Before anything is built, the transport has nothing to abort and nothing is told of a commit.
    const fresh = repositorySources({
      ids: ["one"],
      describe: (id) => id,
      prepare: async () => {
        throw new Error("git 2.30 or later is required to serve a repository source");
      },
    });
    const placeholder = fresh.sourceOf("one");
    placeholder.abort?.();
    placeholder.served?.("a".repeat(40));
    await expect(fresh.ensure()).rejects.toThrow(/2\.30 or later/);
    await expect(placeholder.changed?.()).rejects.toThrow(/2\.30 or later/);
  });
});
