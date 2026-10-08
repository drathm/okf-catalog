import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findCollision } from "../../src/bundle/paths.js";
import { PACK_USAGE, runPack } from "../../src/commands/pack.js";
import { FIXTURES } from "../helpers/fixtures.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});
const temp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "okf-catalog-pack-"));
  dirs.push(d);
  return d;
};

function io(env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdout: (t: string) => void out.push(t),
      stderr: (t: string) => void err.push(t),
      env: { ...env, OKF_CATALOG_NOW: env.OKF_CATALOG_NOW ?? "2026-10-06T00:00:00Z" },
    },
    stdout: () => out.join(""),
    stderr: () => err.join(""),
  };
}

const list = (root: string): string[] => {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else files.push(relative(root, full));
    }
  };
  walk(root);
  return files.sort();
};

function config(dir: string, company = "acme"): string {
  const path = join(dir, "okf-catalog.yaml");
  writeFileSync(path, `company: ${company}\nsource:\n  local: ./kb\n`);
  return path;
}

const PAGE = (title: string, status = "stable") =>
  `---\ntype: Term\ntitle: ${title}\nstatus: ${status}\nverified:\n  - by: human:x\n    at: 2026-01-01T00:00:00Z\n---\n\nbody of ${title}\n`;

describe("okf-catalog pack", () => {
  it("reproduces the spec-example manifest byte for byte, and a packed bundle repacked gives the same manifest", () => {
    const work = temp();
    const cfg = config(work);
    const from = join(FIXTURES, "spec-example");
    const out = join(work, "out");
    const run = io();
    expect(runPack(["--config", cfg, "--from", from, "--out", out], run.io)).toBe(0);
    expect(readFileSync(join(out, "manifest.json"), "utf8")).toBe(
      readFileSync(join(from, "manifest.json"), "utf8"),
    );
    expect(list(out)).toEqual(list(from));
    for (const file of list(from)) {
      if (file === "manifest.json") continue;
      expect(readFileSync(join(out, file)).equals(readFileSync(join(from, file))), file).toBe(true);
    }
    expect(run.stdout()).toMatch(/admitted/);
    const again = join(work, "again");
    expect(runPack(["--config", cfg, "--from", out, "--out", again], io().io)).toBe(0);
    expect(readFileSync(join(again, "manifest.json"), "utf8")).toBe(
      readFileSync(join(out, "manifest.json"), "utf8"),
    );
  });

  it("leaves drafts out, copies attachments anywhere, writes an index where one is missing and keeps a written one, reporting one that lists an unpublished page", () => {
    const work = temp();
    const cfg = config(work);
    const from = join(work, "kb");
    mkdirSync(join(from, "terms"), { recursive: true });
    mkdirSync(join(from, "assets"), { recursive: true });
    writeFileSync(join(from, "terms", "stable.md"), PAGE("Stable"));
    writeFileSync(join(from, "terms", "draft.md"), PAGE("Draft", "draft"));
    writeFileSync(
      join(from, "terms", "index.md"),
      "# Terms\n\n- [Stable](stable.md)\n- [Draft](draft.md)\n",
    );
    writeFileSync(join(from, "assets", "diagram.svg"), "<svg/>\n");
    writeFileSync(join(from, "root-note.md"), PAGE("Root"));
    writeFileSync(join(from, "log.md"), "# Log\n\n- started\n");
    const out = join(work, "out");
    const run = io();
    expect(runPack(["--config", cfg, "--from", from, "--out", out], run.io)).toBe(0);
    expect(list(out)).toEqual([
      "assets/diagram.svg",
      "index.md",
      "log.md",
      "manifest.json",
      "root-note.md",
      "terms/index.md",
      "terms/stable.md",
    ]);
    expect(readFileSync(join(out, "terms", "index.md"), "utf8")).toContain("[Draft](draft.md)");
    expect(readFileSync(join(out, "index.md"), "utf8")).toMatch(/root-note\.md/);
    expect(run.stdout()).toMatch(/index-lists-unserved/);
    const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")) as {
      files: Record<string, unknown>;
    };
    expect(Object.keys(manifest.files).sort()).toEqual(
      list(out).filter((f) => f !== "manifest.json"),
    );
  });

  it("packs an unknown-status page only when the configuration or --admit names it", () => {
    const work = temp();
    const cfg = config(work);
    const from = join(FIXTURES, "behaviours");
    const packed = (args: string[], configPath = cfg): string[] => {
      const out = join(work, `out-${Math.random().toString(36).slice(2)}`);
      const run = io();
      expect(runPack(["--config", configPath, "--from", from, "--out", out, ...args], run.io)).toBe(
        0,
      );
      return list(out);
    };
    const byDefault = packed([]);
    expect(byDefault).toContain("terms/alpha.md");
    expect(byDefault).not.toContain("notes/unknown-status.md");
    expect(byDefault).not.toContain("notes/draft.md");
    const flagged = packed(["--admit", "archived"]);
    expect(flagged).toContain("notes/unknown-status.md");
    expect(flagged).not.toContain("terms/alpha.md");
    expect(flagged).not.toContain("notes/draft.md");
    const listing = join(work, "listing.yaml");
    writeFileSync(
      listing,
      "company: acme\nsource:\n  local: ./kb\nserve:\n  admit: [stable, deprecated, Archived]\n",
    );
    const configured = packed([], listing);
    expect(configured).toContain("notes/unknown-status.md");
    expect(configured).toContain("terms/alpha.md");
    expect(configured).not.toContain("notes/draft.md");
    const draft = io();
    expect(
      runPack(
        ["--config", cfg, "--from", from, "--out", join(work, "never"), "--admit", "Draft"],
        draft.io,
      ),
    ).toBe(2);
    expect(draft.stderr()).toMatch(/--admit/);
    expect(existsSync(join(work, "never"))).toBe(false);
  });

  it("refuses an output with no admitted page unless --allow-empty, and names the words that match no page (D77, build review A-E1)", () => {
    const work = temp();
    const cfg = config(work);
    const from = join(FIXTURES, "behaviours");
    // A one-letter typo in --admit replaces the configuration's list and admits nothing: nothing is written.
    const typo = io();
    expect(
      runPack(
        ["--config", cfg, "--from", from, "--out", join(work, "typo"), "--admit", "stabel"],
        typo.io,
      ),
    ).toBe(2);
    expect(existsSync(join(work, "typo"))).toBe(false);
    expect(typo.stdout()).toBe("");
    expect(typo.stderr()).toContain('Admitted statuses that match no page: "stabel"');
    expect(typo.stderr()).toMatch(/no page is admitted/);
    expect(typo.stderr()).toContain("--allow-empty");
    // Asked for, the empty bundle is written: reserved files and attachments, no page.
    const allowed = io();
    expect(
      runPack(
        [
          "--config",
          cfg,
          "--from",
          from,
          "--out",
          join(work, "allowed"),
          "--admit",
          "stabel",
          "--allow-empty",
        ],
        allowed.io,
      ),
    ).toBe(0);
    const written = list(join(work, "allowed"));
    expect(written).toContain("manifest.json");
    expect(written.filter((f) => f.endsWith(".md") && !/(^|\/)(index|log)\.md$/.test(f))).toEqual(
      [],
    );
    expect(allowed.stdout()).toContain('Admitted statuses that match no page: "stabel"');
    // A typo beside a real word packs what the real word admits, and pack's output names the word that matched nothing.
    const listing = join(work, "typo.yaml");
    writeFileSync(
      listing,
      "company: acme\nsource:\n  local: ./kb\nserve:\n  admit: [stable, depreciated]\n",
    );
    const partial = io();
    expect(
      runPack(["--config", listing, "--from", from, "--out", join(work, "partial")], partial.io),
    ).toBe(0);
    expect(partial.stdout()).toContain('Admitted statuses that match no page: "depreciated"');
    const packed = list(join(work, "partial"));
    expect(packed).toContain("terms/alpha.md");
    expect(packed).not.toContain("terms/delta.md");
    expect(PACK_USAGE).toContain("--allow-empty");
  });

  it("writes nothing and exits 1 when the loader refuses a file, as check does", () => {
    const work = temp();
    const cfg = config(work);
    const from = join(work, "kb");
    mkdirSync(from);
    writeFileSync(join(from, "ok.md"), PAGE("Ok"));
    writeFileSync(join(from, "bad.md"), "no frontmatter here\n");
    const out = join(work, "out");
    const run = io();
    expect(runPack(["--config", cfg, "--from", from, "--out", out], run.io)).toBe(1);
    expect(existsSync(out)).toBe(false);
    expect(run.stderr()).toMatch(/no-frontmatter/);
  });

  it("refuses a non-empty or overlapping output folder and a missing option with exit 2", () => {
    const work = temp();
    const cfg = config(work);
    const from = join(work, "kb");
    mkdirSync(from);
    writeFileSync(join(from, "ok.md"), PAGE("Ok"));
    const full = join(work, "full");
    mkdirSync(full);
    writeFileSync(join(full, "x"), "x");
    const a = io();
    expect(runPack(["--config", cfg, "--from", from, "--out", full], a.io)).toBe(2);
    expect(a.stderr()).toMatch(/not empty/);
    const b = io();
    expect(runPack(["--config", cfg, "--from", from, "--out", join(from, "out")], b.io)).toBe(2);
    expect(b.stderr()).toMatch(/inside/);
    const c = io();
    expect(runPack(["--config", cfg, "--from", from], c.io)).toBe(2);
    expect(c.stderr()).toContain(PACK_USAGE.split("\n")[0]);
  });

  it("records the commit it is given and the zero commit otherwise, never copies hidden files, and writes names in form C", () => {
    const work = temp();
    const cfg = config(work);
    const from = join(work, "kb");
    mkdirSync(join(from, ".hidden"), { recursive: true });
    writeFileSync(join(from, ".hidden", "secret"), "x");
    writeFileSync(join(from, "café.md"), PAGE("Café"));
    const out = join(work, "out");
    const sha = "a".repeat(40);
    expect(runPack(["--config", cfg, "--from", from, "--out", out, "--commit", sha], io().io)).toBe(
      0,
    );
    const names = readdirSync(out);
    expect(names.some((n) => n.startsWith("."))).toBe(false);
    expect(names.map((n) => n.normalize("NFC"))).toContain("café.md");
    expect(names).toContain("café.md");
    const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8")) as {
      commit: string;
      files: Record<string, unknown>;
    };
    expect(manifest.commit).toBe(sha);
    expect(Object.keys(manifest.files)).toContain("café.md");
    const plain = join(work, "plain");
    expect(runPack(["--config", cfg, "--from", from, "--out", plain], io().io)).toBe(0);
    expect(
      (JSON.parse(readFileSync(join(plain, "manifest.json"), "utf8")) as { commit: string }).commit,
    ).toBe("0".repeat(40));
  });

  it("refuses two pages a case-folding file system or the server would treat as one, and an output path that is a link", () => {
    const work = temp();
    const cfg = config(work);
    const from = join(work, "kb");
    mkdirSync(from);
    expect(findCollision(["a.md", "stra\u00DFe.md", "STRASSE.md"])).toEqual([
      "stra\u00DFe.md",
      "STRASSE.md",
    ]);
    expect(findCollision(["a.md", "b.md"])).toBeUndefined();
    writeFileSync(join(from, "Alpha.md"), PAGE("Alpha"));
    writeFileSync(join(from, "alpha.md"), PAGE("alpha"));
    // A case-folding file system (APFS here) keeps one file of the two; a case-sensitive one keeps both and pack refuses.
    if (readdirSync(from).length === 2) {
      const run = io();
      expect(runPack(["--config", cfg, "--from", from, "--out", join(work, "out")], run.io)).toBe(
        1,
      );
      expect(run.stderr()).toMatch(/collid/i);
      expect(existsSync(join(work, "out"))).toBe(false);
    }
    for (const name of readdirSync(from))
      if (name.toLowerCase() === "alpha.md" && name !== "Alpha.md") rmSync(join(from, name));
    const elsewhere = join(work, "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(work, "linked"));
    const linked = io();
    expect(
      runPack(["--config", cfg, "--from", from, "--out", join(work, "linked")], linked.io),
    ).toBe(2);
    expect(linked.stderr()).toMatch(/link/);
  });
});
