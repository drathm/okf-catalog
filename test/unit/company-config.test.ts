import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  discoverConfigPath,
  parseCompanyConfig,
  readCompanyConfig,
} from "../../src/config/company-config.js";

const HOME = "/home/someone";
const DIR = "/srv/acme/config";
const base = `company: acme
source:
  local: ./kb
`;
const parse = (text: string) => parseCompanyConfig(text, DIR, HOME);
const problems = (text: string): string[] => {
  const r = parse(text);
  return r.ok ? [] : r.problems;
};

describe("parseCompanyConfig", () => {
  it("applies the defaults and resolves relative paths against the configuration file's folder", () => {
    const r = parse(base);
    if (!r.ok) throw new Error(r.problems.join("; "));
    expect(r.config.company).toBe("acme");
    expect(r.config.source).toEqual({
      kind: "local",
      path: "/srv/acme/config/kb",
      configured: "./kb",
    });
    expect(r.config.serve).toEqual({
      admit: ["stable", "deprecated"],
      dev: false,
      pullIntervalMs: 600_000,
      limitDefault: 8,
    });
    expect(r.config.integrity).toBe("require-manifest");
    expect(r.config.caps).toEqual({
      fileBytes: 2 * 1024 * 1024,
      files: 20_000,
      treeBytes: 512 * 1024 * 1024,
    });
    expect(r.config.types).toBeUndefined();
    expect(r.config.specText).toBe("2026-08-15");
  });

  it("expands a leading ~/ against the home folder and keeps an absolute path", () => {
    const tilde = parse("company: acme\nsource:\n  local: ~/kb\n");
    expect(tilde.ok && tilde.config.source.kind === "local" && tilde.config.source.path).toBe(
      "/home/someone/kb",
    );
    const absolute = parse("company: acme\nsource:\n  local: /data/kb\n");
    expect(
      absolute.ok && absolute.config.source.kind === "local" && absolute.config.source.path,
    ).toBe("/data/kb");
  });

  it("maps dev onto drafts admitted and integrity off, and allows it only with a local source", () => {
    const dev = parse(`${base}serve:\n  dev: true\n`);
    expect(dev.ok && dev.config.integrity).toBe("none");
    expect(dev.ok && dev.config.serve.dev).toBe(true);
    const git =
      "company: acme\nsource:\n  repository: git@example.test:acme/kb.git\nserve:\n  dev: true\n";
    expect(problems(git).join(" ")).toMatch(/dev.*local/);
    const gitOk = parse("company: acme\nsource:\n  repository: git@example.test:acme/kb.git\n");
    expect(gitOk.ok && gitOk.config.source).toEqual({
      kind: "git",
      repository: "git@example.test:acme/kb.git",
      branch: "published",
      bundlePath: ".",
    });
  });

  it("requires exactly one source and a company that is one lower-case path segment", () => {
    expect(problems("company: acme\nsource:\n  local: ./kb\n  repository: x\n").join(" ")).toMatch(
      /one of/,
    );
    expect(problems("company: acme\nsource: {}\n").join(" ")).toMatch(/local|repository/);
    expect(problems("company: Acme Inc\nsource:\n  local: ./kb\n").join(" ")).toMatch(/company/);
    expect(problems("source:\n  local: ./kb\n").join(" ")).toMatch(/company/);
  });

  it("names an unknown key at any level, and refuses draft in admit", () => {
    expect(problems(`${base}serve:\n  extra: 1\n`).join(" ")).toMatch(/serve\.extra|extra/);
    expect(problems(`${base}source:\n  local: ./kb\n  extra: 1\n`)).not.toEqual([]);
    expect(problems(`${base}nonsense: true\n`).join(" ")).toMatch(/nonsense/);
    expect(problems(`${base}serve:\n  admit: [draft, stable]\n`).join(" ")).toMatch(/draft/);
    expect(problems(`${base}serve:\n  admit: []\n`).join(" ")).toMatch(/admit/);
  });

  it("checks the duration grammar and bounds, the caps, the limit and the spec text", () => {
    expect(parse(`${base}serve:\n  pull_interval: 30s\n`).ok).toBe(true);
    expect(parse(`${base}serve:\n  pull_interval: 2h\n`).ok).toBe(true);
    expect(problems(`${base}serve:\n  pull_interval: 10x\n`).join(" ")).toMatch(/pull_interval/);
    expect(problems(`${base}serve:\n  pull_interval: 1s\n`).join(" ")).toMatch(/pull_interval/);
    expect(problems(`${base}serve:\n  pull_interval: 25h\n`).join(" ")).toMatch(/pull_interval/);
    expect(problems(`${base}serve:\n  limit_default: 0\n`).join(" ")).toMatch(/limit_default/);
    expect(problems(`${base}serve:\n  limit_default: 26\n`).join(" ")).toMatch(/limit_default/);
    expect(problems(`${base}caps:\n  files: 1.5\n`).join(" ")).toMatch(/files/);
    expect(problems(`${base}caps:\n  file_bytes: 999999999999\n`).join(" ")).toMatch(/file_bytes/);
    const caps = parse(`${base}caps:\n  files: 100\n`);
    expect(caps.ok && caps.config.caps).toEqual({
      fileBytes: 2 * 1024 * 1024,
      files: 100,
      treeBytes: 512 * 1024 * 1024,
    });
    expect(problems(`${base}spec_text: 2027-01-01\n`).join(" ")).toMatch(/spec_text/);
    const later = parse(`${base}spec_text: 2026-08-21\n`);
    expect(later.ok && later.config.specText).toBe("2026-08-21");
  });

  it("treats an omitted or empty types list as declaring nothing, and keeps a non-empty one", () => {
    const empty = parse(`${base}types: []\n`);
    expect(empty.ok && empty.config.types).toBeUndefined();
    const some = parse(`${base}types: [Term, Note]\n`);
    expect(some.ok && some.config.types).toEqual(["Term", "Note"]);
  });

  it("reports a document that is not a mapping, or not YAML", () => {
    expect(problems("- a\n- b\n")).not.toEqual([]);
    expect(problems("company: [unclosed\n")).not.toEqual([]);
  });
});

describe("discoverConfigPath and readCompanyConfig", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "okf-catalog-config-"));
    writeFileSync(join(dir, "okf-catalog.yaml"), base);
    writeFileSync(join(dir, "other.yaml"), base);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("takes the flag, then the variable, then the working folder, and says which", () => {
    expect(discoverConfigPath("/x/flag.yaml", { OKF_CATALOG_CONFIG: "/x/env.yaml" }, dir)).toEqual({
      path: "/x/flag.yaml",
      rule: "flag",
    });
    expect(discoverConfigPath(undefined, { OKF_CATALOG_CONFIG: "/x/env.yaml" }, dir)).toEqual({
      path: "/x/env.yaml",
      rule: "env",
    });
    expect(discoverConfigPath(undefined, {}, dir)).toEqual({
      path: join(dir, "okf-catalog.yaml"),
      rule: "cwd",
    });
    expect(discoverConfigPath("relative.yaml", {}, dir)).toEqual({
      path: join(dir, "relative.yaml"),
      rule: "flag",
    });
  });

  it("never falls through when the variable is empty or still holds a placeholder", () => {
    const empty = discoverConfigPath(undefined, { OKF_CATALOG_CONFIG: "" }, dir);
    expect("error" in empty && empty.error).toMatch(/plugin configure okf-catalog/);
    const placeholder = discoverConfigPath(
      undefined,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the unsubstituted placeholder is the case under test
      { OKF_CATALOG_CONFIG: "${user_config.config_path}" },
      dir,
    );
    expect("error" in placeholder && placeholder.error).toMatch(/plugin configure okf-catalog/);
  });

  it("reads a file, resolving its relative paths against its own folder, and names a missing one", () => {
    const r = readCompanyConfig(join(dir, "other.yaml"), HOME);
    expect(r.ok && r.config.source.kind === "local" && r.config.source.path).toBe(join(dir, "kb"));
    const missing = readCompanyConfig(join(dir, "nowhere.yaml"), HOME);
    expect(!missing.ok && missing.problems.join(" ")).toMatch(/nowhere\.yaml/);
    const folder = readCompanyConfig(dir, HOME);
    expect(folder.ok).toBe(false);
  });
});
