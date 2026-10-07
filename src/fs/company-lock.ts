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

/**
 * One process per company folder, enforced by the operating system: an exclusive SQLite transaction on
 * `lock.sqlite`, held for the life of the process and released the instant it dies, however it dies. There is
 * no stale state to recover and no liveness test to get wrong. `owner.json` beside it is information only.
 */
export function acquireLock(companyDir: string, now: Date): Lock {
  const db = new Database(join(companyDir, LOCK_DB), { timeout: 0 });
  try {
    // A table and a row inside the open transaction: the exclusive pager lock exists only once a page is
    // written, so an empty database would not keep a second process out.
    db.pragma("journal_mode = DELETE");
    db.exec("CREATE TABLE IF NOT EXISTS owner (pid INTEGER NOT NULL, started_at TEXT NOT NULL)");
    db.pragma("locking_mode = EXCLUSIVE");
    db.exec("BEGIN EXCLUSIVE");
    db.prepare("DELETE FROM owner").run();
    db.prepare("INSERT INTO owner (pid, started_at) VALUES (?, ?)").run(
      process.pid,
      now.toISOString(),
    );
  } catch (error) {
    db.close();
    if (String((error as { code?: string }).code ?? "").startsWith("SQLITE_BUSY")) {
      const owner = readOwner(companyDir);
      return owner === undefined ? { kind: "held" } : { kind: "held", owner };
    }
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
