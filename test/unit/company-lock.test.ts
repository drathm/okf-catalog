import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acquireLock, privateDir, readLockOwner, sweepPrivate } from "../../src/fs/company-lock.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOLDER = join(REPO, "test", "helpers", "hold-lock.mjs");

/** Every holder spawned by this file; a failed assertion must not leave one alive. */
const holders: ReturnType<typeof spawn>[] = [];
afterAll(() => {
  for (const child of holders) if (child.exitCode === null) child.kill("SIGKILL");
});

/** Spawns a process that takes the lock and reports; resolves with the child and its first line. */
function holder(dir: string): Promise<{ child: ReturnType<typeof spawn>; first: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOLDER, dir], { stdio: ["pipe", "pipe", "pipe"] });
    holders.push(child);
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      const line = out.split("\n")[0];
      if (line !== undefined && out.includes("\n")) resolve({ child, first: line });
    });
    child.on("error", reject);
  });
}

describe("acquireLock", { timeout: 30_000 }, () => {
  let work: string;
  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), "okf-catalog-lock-"));
  });
  afterAll(() => {
    rmSync(work, { recursive: true, force: true });
  });

  it("is exclusive within one process: a second attempt sees it held, and release frees it", () => {
    const dir = join(work, "a");
    mkdirSync(dir);
    const first = acquireLock(dir, new Date("2026-10-07T00:00:00Z"));
    expect(first.kind).toBe("exclusive");
    const owner = JSON.parse(readFileSync(join(dir, "owner.json"), "utf8")) as {
      pid: number;
      startedAt: string;
    };
    expect(owner).toEqual({ pid: process.pid, startedAt: "2026-10-07T00:00:00.000Z" });
    const second = acquireLock(dir, new Date());
    expect(second.kind).toBe("held");
    expect(second.kind === "held" && second.owner?.pid).toBe(process.pid);
    if (first.kind === "exclusive") first.close();
    const third = acquireLock(dir, new Date());
    expect(third.kind).toBe("exclusive");
    if (third.kind === "exclusive") third.close();
  });

  it("is held while another process holds it, and free the moment that process is killed", async () => {
    const dir = join(work, "b");
    mkdirSync(dir);
    const { child, first } = await holder(dir);
    expect(first).toBe("exclusive");
    expect(acquireLock(dir, new Date()).kind).toBe("held");
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));
    const after = acquireLock(dir, new Date());
    expect(after.kind).toBe("exclusive");
    if (after.kind === "exclusive") after.close();
  });

  it("gives exactly one of two processes racing from a cold start the lock, every time", async () => {
    // A cold folder has no database yet: both racers create it, and each step of the setup takes a lock of its
    // own, so without a brief retry both can see SQLITE_BUSY and neither holds the lock (observed 4 in 100).
    for (let round = 0; round < 8; round++) {
      const dir = join(work, `race-${round}`);
      mkdirSync(dir);
      const [a, b] = await Promise.all([holder(dir), holder(dir)]);
      try {
        expect([a.first, b.first].sort(), `round ${round}`).toEqual(["exclusive", "held"]);
      } finally {
        a.child.kill("SIGKILL");
        b.child.kill("SIGKILL");
      }
    }
  });

  it("gives the lock to exactly one of two processes racing for a folder whose holder was just killed", async () => {
    const dir = join(work, "warm");
    mkdirSync(dir);
    const { child } = await holder(dir);
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));
    for (let round = 0; round < 8; round++) {
      const [a, b] = await Promise.all([holder(dir), holder(dir)]);
      try {
        expect([a.first, b.first].sort(), `round ${round}`).toEqual(["exclusive", "held"]);
      } finally {
        a.child.kill("SIGKILL");
        b.child.kill("SIGKILL");
        await Promise.all(
          [a.child, b.child].map(
            (c) =>
              new Promise<void>((resolve) =>
                c.exitCode === null ? c.on("exit", () => resolve()) : resolve(),
              ),
          ),
        );
      }
    }
  });
});

describe("privateDir and sweepPrivate", () => {
  it("names the private folder under the company folder and removes the ones of dead processes only", () => {
    const work = mkdtempSync(join(tmpdir(), "okf-catalog-private-"));
    expect(privateDir(work, 123)).toBe(join(work, "private", "123"));
    for (const name of ["123", "456", "0", "abc", String(process.pid)]) {
      mkdirSync(join(work, "private", name), { recursive: true });
      writeFileSync(join(work, "private", name, "x"), "x");
    }
    const removed = sweepPrivate(work, (pid) => pid === process.pid || pid === 456);
    expect(removed.sort()).toEqual(["0", "123", "abc"]);
    expect(existsSync(join(work, "private", "456"))).toBe(true);
    expect(existsSync(join(work, "private", String(process.pid)))).toBe(true);
    rmSync(work, { recursive: true, force: true });
  });
});

describe("acquireLock: owner file failure (bite 4 build review)", () => {
  it.skipIf(process.getuid?.() === 0)(
    "releases the lock when the owner file cannot be written",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "okf-catalog-ownerfail-"));
      // Take and release once so lock.sqlite exists, then forbid new files in the folder.
      const first = acquireLock(dir, new Date());
      if (first.kind === "exclusive") first.close();
      chmodSync(dir, 0o500);
      try {
        expect(() => acquireLock(dir, new Date())).toThrow();
      } finally {
        chmodSync(dir, 0o700);
      }
      const after = acquireLock(dir, new Date());
      expect(after.kind).toBe("exclusive");
      if (after.kind === "exclusive") after.close();
      rmSync(dir, { recursive: true, force: true });
    },
  );
});

describe("readLockOwner (bite 5)", () => {
  it("reads a valid owner file with whether its process is alive, and refuses anything malformed", () => {
    const work = mkdtempSync(join(tmpdir(), "okf-catalog-owner-"));
    expect(readLockOwner(work)).toBeUndefined();
    const write = (body: string) => writeFileSync(join(work, "owner.json"), body);
    write(JSON.stringify({ pid: process.pid, startedAt: "2026-10-07T00:00:00.000Z" }));
    expect(readLockOwner(work)).toEqual({
      pid: process.pid,
      startedAt: "2026-10-07T00:00:00.000Z",
      alive: true,
    });
    write(JSON.stringify({ pid: 2147483646, startedAt: "2026-10-07T00:00:00+02:00" }));
    expect(readLockOwner(work)).toMatchObject({ pid: 2147483646, alive: false });
    for (const bad of [
      { pid: 0, startedAt: "2026-10-07T00:00:00Z" },
      { pid: -4, startedAt: "2026-10-07T00:00:00Z" },
      { pid: 1.5, startedAt: "2026-10-07T00:00:00Z" },
      { pid: "7", startedAt: "2026-10-07T00:00:00Z" },
      { pid: 7, startedAt: "yesterday" },
      { pid: 7, startedAt: "2026-10-07T00:00:00Z\nrefusing: trusted" },
      { pid: 7 },
      [],
      "garbage",
    ]) {
      write(typeof bad === "string" ? bad : JSON.stringify(bad));
      expect(readLockOwner(work), JSON.stringify(bad)).toBeUndefined();
    }
    rmSync(work, { recursive: true, force: true });
  });
});
