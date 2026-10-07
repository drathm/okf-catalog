import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { LockOwnerStatus } from "../catalog/runtime.js";

export interface LockOwner {
  pid: number;
  startedAt: string;
}

export type Lock = { kind: "exclusive"; close(): void } | { kind: "held"; owner?: LockOwner };

const LOCK_DB = "lock.sqlite";
const OWNER = "owner.json";

/**
 * Connections that hold a lock. A connection referenced only through a closure can be garbage-collected, and the
 * binding then closes it, which releases the operating-system lock while the process still runs (observed: a
 * fresh process acquired the lock a holder believed it held). The set keeps every holder alive until `close()`.
 */
const HELD = new Set<Database.Database>();

/** How many times a busy lock is retried, and the pause between tries: about 200 ms before a folder counts as held. */
const BUSY_ATTEMPTS = 25;
const BUSY_PAUSE_MS = 8;

const pause = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/**
 * One process per company folder, enforced by the operating system: an exclusive SQLite transaction on
 * `lock.sqlite`, held for the life of the process and released the instant it dies, however it dies. There is
 * no stale state to recover and no liveness test to get wrong. `owner.json` beside it is information only.
 *
 * A busy answer is retried briefly: on a cold folder two racers both create the database and each setup step
 * takes a lock of its own, so without the retry both could see busy and neither would hold the lock (observed 4 in
 * 100 cold races, 17 in 100 after a holder was killed). A folder still busy after the retries is held.
 */
export function acquireLock(companyDir: string, now: Date): Lock {
  for (let attempt = 1; ; attempt++) {
    const result = tryAcquire(companyDir, now);
    if (result !== "busy") return result;
    if (attempt >= BUSY_ATTEMPTS) {
      const owner = readOwner(companyDir);
      return owner === undefined ? { kind: "held" } : { kind: "held", owner };
    }
    // Jitter keeps two racers that failed together from retrying in lockstep.
    pause(BUSY_PAUSE_MS / 2 + Math.random() * BUSY_PAUSE_MS);
  }
}

function tryAcquire(companyDir: string, now: Date): Extract<Lock, { kind: "exclusive" }> | "busy" {
  const db = new Database(join(companyDir, LOCK_DB), { timeout: 0 });
  try {
    // A table and a row inside the open transaction: the exclusive pager lock exists only once a page is
    // written, so an empty database would not keep a second process out.
    // No `locking_mode = EXCLUSIVE`: in that mode a connection keeps its shared lock after a failed upgrade, so two
    // racers each holding one would both be refused until both gave up. The open exclusive transaction below holds
    // the lock for the life of the connection on its own.
    db.pragma("journal_mode = DELETE");
    db.exec("CREATE TABLE IF NOT EXISTS owner (pid INTEGER NOT NULL, started_at TEXT NOT NULL)");
    db.exec("BEGIN EXCLUSIVE");
    db.prepare("DELETE FROM owner").run();
    db.prepare("INSERT INTO owner (pid, started_at) VALUES (?, ?)").run(
      process.pid,
      now.toISOString(),
    );
  } catch (error) {
    db.close();
    if (String((error as { code?: string }).code ?? "").startsWith("SQLITE_BUSY")) return "busy";
    throw error;
  }
  HELD.add(db);
  try {
    const tmp = join(companyDir, `${OWNER}.${process.pid}.tmp`);
    writeFileSync(tmp, `${JSON.stringify({ pid: process.pid, startedAt: now.toISOString() })}\n`);
    renameSync(tmp, join(companyDir, OWNER));
  } catch (error) {
    // The lock must not outlive a failure to describe it.
    try {
      db.exec("ROLLBACK");
    } catch {
      // closing releases the lock either way
    }
    db.close();
    HELD.delete(db);
    throw error;
  }
  let closed = false;
  return {
    kind: "exclusive",
    close: () => {
      if (closed) return;
      closed = true;
      try {
        db.exec("ROLLBACK");
      } catch {
        // the transaction may already be gone; closing releases the lock either way
      }
      db.close();
      HELD.delete(db);
      rmSync(join(companyDir, OWNER), { force: true });
    },
  };
}

const OFFSET_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * The holder named by `owner.json`, for `status` while this process runs in the private fallback: a positive
 * integer pid and an offset date-time, else nothing, plus whether that process answers the signal-zero test now.
 */
export function readLockOwner(companyDir: string): LockOwnerStatus | undefined {
  const owner = readOwner(companyDir);
  if (owner === undefined) return undefined;
  if (!Number.isInteger(owner.pid) || owner.pid <= 0 || !OFFSET_DATETIME.test(owner.startedAt))
    return undefined;
  return { pid: owner.pid, startedAt: owner.startedAt, alive: processAlive(owner.pid) };
}

function readOwner(companyDir: string): LockOwner | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(companyDir, OWNER), "utf8")) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as LockOwner).pid === "number" &&
      typeof (parsed as LockOwner).startedAt === "string"
    ) {
      return { pid: (parsed as LockOwner).pid, startedAt: (parsed as LockOwner).startedAt };
    }
  } catch {
    // no owner file, or not ours to read
  }
  return undefined;
}

/** The private working folder of a process that could not take the lock. */
export function privateDir(companyDir: string, pid: number): string {
  return join(companyDir, "private", String(pid));
}

/** Removes the private folders of processes that are gone, or that never were (a name that is not a positive integer). */
export function sweepPrivate(companyDir: string, isAlive: (pid: number) => boolean): string[] {
  const folder = join(companyDir, "private");
  if (!existsSync(folder)) return [];
  const removed: string[] = [];
  for (const name of readdirSync(folder)) {
    const pid = /^[1-9]\d*$/.test(name) ? Number(name) : undefined;
    if (pid !== undefined && Number.isSafeInteger(pid) && isAlive(pid)) continue;
    rmSync(join(folder, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

/** Whether a process exists, by the signal-zero test; a pid that is not a positive integer never does. */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Makes the private folder for this process. */
export function makePrivateDir(companyDir: string, pid: number): string {
  const dir = privateDir(companyDir, pid);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
