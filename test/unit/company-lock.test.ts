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
import { acquireLock, privateDir, sweepPrivate } from "../../src/fs/company-lock.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOLDER = join(REPO, "test", "helpers", "hold-lock.mjs");

/** Spawns a process that takes the lock and reports; resolves with the child and its first line. */
function holder(dir: string): Promise<{ child: ReturnType<typeof spawn>; first: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOLDER, dir], { stdio: ["pipe", "pipe", "pipe"] });
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

  it("gives exactly one of two processes racing from a cold start the lock", async () => {
    const dir = join(work, "c");
    mkdirSync(dir);
    const [a, b] = await Promise.all([holder(dir), holder(dir)]);
    expect([a.first, b.first].sort()).toEqual(["exclusive", "held"]);
    a.child.kill("SIGKILL");
    b.child.kill("SIGKILL");
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
