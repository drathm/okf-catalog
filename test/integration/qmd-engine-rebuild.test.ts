import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { QmdEngine } from "../../src/engine/qmd.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) {
    try {
      chmodSync(d, 0o700);
    } catch {
      // gone
    }
    rmSync(d, { recursive: true, force: true });
  }
  dirs.length = 0;
});
const temp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "okf-catalog-rebuild-"));
  dirs.push(d);
  return d;
};

describe("QmdEngine.open on a damaged store (D48)", () => {
  it("removes a store that is not a database, with its sidecars, rebuilds it once and says so", async () => {
    const dir = temp();
    writeFileSync(
      join(dir, "index.sqlite"),
      Buffer.from("not a database at all, just bytes".repeat(200)),
    );
    writeFileSync(join(dir, "index.sqlite-wal"), Buffer.from("stale wal"));
    writeFileSync(join(dir, "index.sqlite-shm"), Buffer.from("stale shm"));
    const engine = await QmdEngine.open({ company: "acme", dir });
    try {
      expect(engine.resetOnOpen).toMatch(/not a database|SQLITE_NOTADB/);
      expect(engine.resetOnOpen).toMatch(/rebuilt/);
      expect(readFileSync(join(dir, "index.sqlite")).subarray(0, 15).toString()).toBe(
        "SQLite format 3",
      );
      expect(
        existsSync(join(dir, "index.sqlite-shm"))
          ? readFileSync(join(dir, "index.sqlite-shm")).toString()
          : "",
      ).not.toBe("stale shm");
      const result = await engine.index([]);
      expect(result.documents).toBe(0);
    } finally {
      await engine.close();
    }
  });

  it("does not rebuild for a failure that is not corruption: the store file is left as it was", async () => {
    const dir = temp();
    const planted = Buffer.from("planted, unreadable, not corruption");
    writeFileSync(join(dir, "index.sqlite"), planted, { mode: 0o000 });
    await expect(QmdEngine.open({ company: "acme", dir })).rejects.toThrow();
    chmodSync(join(dir, "index.sqlite"), 0o600);
    expect(readFileSync(join(dir, "index.sqlite")).equals(planted)).toBe(true);
  });

  it("rebuilds a store whose header is sound but whose pages are gone, which surfaces after the open", async () => {
    const dir = temp();
    const { default: Database } = await import("better-sqlite3");
    const db = new Database(join(dir, "index.sqlite"));
    db.exec("CREATE TABLE filler (body TEXT)");
    const insert = db.prepare("INSERT INTO filler VALUES (?)");
    for (let i = 0; i < 400; i++) insert.run("x".repeat(200));
    db.close();
    truncateSync(join(dir, "index.sqlite"), 4096 + 512);
    const engine = await QmdEngine.open({ company: "acme", dir });
    try {
      expect(engine.resetOnOpen).toMatch(/rebuilt/);
      expect((await engine.index([])).documents).toBe(0);
    } finally {
      await engine.close();
    }
  });
});
