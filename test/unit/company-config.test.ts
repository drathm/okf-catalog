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

  it("takes any status word in serve.admit but draft", () => {
    const r = parse(`${base}serve:\n  admit: [stable, deprecated, archived, ' In Review ']\n`);
    expect(r.ok && r.config.serve.admit).toEqual(["stable", "deprecated", "archived", "In Review"]);
    for (const list of ["[draft, stable]", "[stable, Draft]", "[' draft ']"]) {
      expect(problems(`${base}serve:\n  admit: ${list}\n`), list).toEqual([
        "serve.admit: draft is admitted only through serve.dev",
      ]);
    }
    expect(problems(`${base}serve:\n  admit: [stable, '  ']\n`)).toEqual([
      "serve.admit: a status cannot be blank",
    ]);
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
    expect(
      discoverConfigPath("/x/flag.yaml", { OKF_CATALOG_CONFIG: "/x/env.yaml" }, dir, HOME),
    ).toEqual({
      path: "/x/flag.yaml",
      rule: "flag",
    });
    expect(discoverConfigPath(undefined, { OKF_CATALOG_CONFIG: "/x/env.yaml" }, dir, HOME)).toEqual(
      {
        path: "/x/env.yaml",
        rule: "env",
      },
    );
    expect(discoverConfigPath(undefined, {}, dir, HOME)).toEqual({
      path: join(dir, "okf-catalog.yaml"),
      rule: "cwd",
    });
    expect(discoverConfigPath("relative.yaml", {}, dir, HOME)).toEqual({
      path: join(dir, "relative.yaml"),
      rule: "flag",
    });
  });

  it("never falls through when the variable is empty or still holds a placeholder", () => {
    const empty = discoverConfigPath(undefined, { OKF_CATALOG_CONFIG: "" }, dir, HOME);
    expect("error" in empty && empty.error).toMatch(/okf-catalog\.yaml in the project folder/);
    const placeholder = discoverConfigPath(
      undefined,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the unsubstituted placeholder is the case under test
      { OKF_CATALOG_CONFIG: "${user_config.config_path}" },
      dir,
      HOME,
    );
    expect("error" in placeholder && placeholder.error).toMatch(
      /okf-catalog\.yaml in the project folder/,
    );
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

describe("readCompanyConfig: size (bite 4 build review)", () => {
  it("refuses a configuration file over one megabyte without reading it whole", () => {
    const dir = mkdtempSync(join(tmpdir(), "okf-catalog-bigconfig-"));
    const path = join(dir, "okf-catalog.yaml");
    writeFileSync(path, `company: acme\nsource:\n  local: ./kb\n# ${"x".repeat(1_100_000)}\n`);
    const r = readCompanyConfig(path, "/home/x");
    expect(!r.ok && r.problems.join(" ")).toMatch(/too large|over/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("git source grammars (bite 5)", () => {
  const git = (source: string) => problems(`company: acme\nsource:\n${source}\n`);
  it("accepts https and ssh URLs without userinfo and the user@host:path form, and refuses the rest", () => {
    for (const ok of [
      "https://host.example/org/repo.git",
      "ssh://git@host.example/org/repo.git",
      "ssh://git@host.example:2222/org/repo.git",
      "git@host.example:org/repo.git",
    ])
      expect(git(`  repository: "${ok}"`), ok).toEqual([]);
    for (const bad of [
      "https://alice:s3cret@host.example/org/repo.git",
      "https://alice@host.example/org/repo.git",
      "file:///tmp/repo.git",
      "/tmp/repo.git",
      "ext::sh -c touch%20/tmp/x",
      "-x",
      "host.example/org/repo.git",
      "https://host.example/org/repo.git?token=s3cret",
      "https://host.example/org/repo.git#frag",
      "-oProxyCommand=touch /tmp/x@host.example:org/repo.git",
      "ssh://-oProxyCommand=x@host.example/org/repo.git",
    ])
      expect(git(`  repository: "${bad}"`).join(" "), bad).toMatch(/source\.repository:/);
    // The suite's own setting: a file:// repository is accepted only when asked for, and a local path never.
    const relaxed = parseCompanyConfig(
      `company: acme\nsource:\n  repository: "file:///tmp/origin.git"\n`,
      DIR,
      HOME,
      { allowFileRepositories: true },
    );
    expect(relaxed.ok).toBe(true);
    const path = parseCompanyConfig(
      `company: acme\nsource:\n  repository: "/tmp/origin.git"\n`,
      DIR,
      HOME,
      {
        allowFileRepositories: true,
      },
    );
    expect(path.ok).toBe(false);
  });
  it("accepts a plain branch name and refuses anything a refspec could misread", () => {
    const branch = (name: string) =>
      problems(`company: acme\nsource:\n  repository: "git@h:o/r.git"\n  branch: "${name}"\n`);
    for (const ok of ["published", "release/2026-10", "v1.2_x-y"])
      expect(branch(ok), ok).toEqual([]);
    for (const bad of [
      "HEAD",
      "a.lock/b",
      "-x",
      "a..b",
      "a:refs/heads/b",
      "*",
      "x/",
      "x.lock",
      ".hidden",
      "a//b",
      "a@{1}",
      "with space",
      "tab\tx",
    ])
      expect(branch(bad).join(" "), JSON.stringify(bad)).toMatch(/source\.branch:/);
  });
  it("accepts a bundle path of . or a safe relative path with no dot-leading segment", () => {
    const bundle = (path: string) =>
      problems(`company: acme\nsource:\n  repository: "git@h:o/r.git"\n  bundle_path: "${path}"\n`);
    for (const ok of [".", "kb", "kb/docs", "a-b_c.d/e"]) expect(bundle(ok), ok).toEqual([]);
    for (const bad of [
      "../x",
      "/etc",
      ".git",
      "kb/.git/x",
      ".hidden/x",
      "a\\\\b",
      "kb/",
      "./kb",
      "kb/../x",
    ])
      expect(bundle(bad).join(" "), JSON.stringify(bad)).toMatch(/source\.bundle_path:/);
  });
});
