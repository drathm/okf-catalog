import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type BundleConfig,
  discoverConfigPath,
  type NetworkConfig,
  type ParseOptions,
  parseNetworkConfig,
  readNetworkConfig,
} from "../../src/config/network-config.js";

const HOME = "/home/someone";
const DIR = "/srv/acme/config";
const base = `company: acme
source:
  local: ./kb
`;
const parse = (text: string, options: ParseOptions = {}) =>
  parseNetworkConfig(text, DIR, HOME, options);
const problems = (text: string, options: ParseOptions = {}): string[] => {
  const r = parse(text, options);
  return r.ok ? [] : r.problems;
};
/** The configuration a file parses to, or the problems as an error. */
const config = (text: string, options: ParseOptions = {}): NetworkConfig => {
  const r = parse(text, options);
  if (!r.ok) throw new Error(r.problems.join("; "));
  return r.config;
};
/** The one bundle of a `company:` file, the alias kept until 0.5.0 (D-G). */
const only = (text: string): BundleConfig => {
  const bundles = config(text).bundles;
  expect(bundles).toHaveLength(1);
  return bundles[0] as BundleConfig;
};

describe("parseNetworkConfig: the company: alias", () => {
  it("applies the defaults and resolves relative paths against the configuration file's folder", () => {
    const r = config(base);
    // A company: file is a network of that name with one bundle of that id (D-G, D76).
    expect(r.network).toBe("acme");
    expect(r.form).toBe("company");
    expect(r.limitDefault).toBe(8);
    const bundle = only(base);
    expect(bundle.id).toBe("acme");
    expect(bundle.source).toEqual({
      kind: "local",
      path: "/srv/acme/config/kb",
      configured: "./kb",
    });
    expect(bundle.serve).toEqual({
      admit: ["stable", "deprecated"],
      dev: false,
      pullIntervalMs: 600_000,
    });
    expect(bundle.integrity).toBe("require-manifest");
    expect(bundle.caps).toEqual({
      fileBytes: 2 * 1024 * 1024,
      files: 20_000,
      treeBytes: 512 * 1024 * 1024,
    });
    expect(bundle.types).toBeUndefined();
    expect(bundle.specText).toBe("2026-08-15");
  });

  it("expands a leading ~/ against the home folder and keeps an absolute path", () => {
    const tilde = only("company: acme\nsource:\n  local: ~/kb\n");
    expect(tilde.source.kind === "local" && tilde.source.path).toBe("/home/someone/kb");
    const absolute = only("company: acme\nsource:\n  local: /data/kb\n");
    expect(absolute.source.kind === "local" && absolute.source.path).toBe("/data/kb");
  });

  it("maps dev onto drafts admitted and integrity off, and allows it only with a local source", () => {
    const dev = only(`${base}serve:\n  dev: true\n`);
    expect(dev.integrity).toBe("none");
    expect(dev.serve.dev).toBe(true);
    const git =
      "company: acme\nsource:\n  repository: git@example.test:acme/kb.git\nserve:\n  dev: true\n";
    expect(problems(git).join(" ")).toMatch(/dev.*local/);
    const gitOk = only("company: acme\nsource:\n  repository: git@example.test:acme/kb.git\n");
    expect(gitOk.source).toEqual({
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
    const r = only(`${base}serve:\n  admit: [stable, deprecated, archived, ' In Review ']\n`);
    expect(r.serve.admit).toEqual(["stable", "deprecated", "archived", "In Review"]);
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
    const caps = only(`${base}caps:\n  files: 100\n`);
    expect(caps.caps).toEqual({
      fileBytes: 2 * 1024 * 1024,
      files: 100,
      treeBytes: 512 * 1024 * 1024,
    });
    expect(problems(`${base}spec_text: 2027-01-01\n`).join(" ")).toMatch(/spec_text/);
    expect(only(`${base}spec_text: 2026-08-21\n`).specText).toBe("2026-08-21");
    expect(config(`${base}serve:\n  limit_default: 12\n`).limitDefault).toBe(12);
  });

  it("treats an omitted or empty types list as declaring nothing, and keeps a non-empty one", () => {
    expect(only(`${base}types: []\n`).types).toBeUndefined();
    expect(only(`${base}types: [Term, Note]\n`).types).toEqual(["Term", "Note"]);
  });

  it("reports a document that is not a mapping, or not YAML", () => {
    expect(problems("- a\n- b\n")).not.toEqual([]);
    expect(problems("company: [unclosed\n")).not.toEqual([]);
  });
});

describe("discoverConfigPath and readNetworkConfig", () => {
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
    const r = readNetworkConfig(join(dir, "other.yaml"), HOME);
    const source = r.ok ? r.config.bundles[0]?.source : undefined;
    expect(source?.kind === "local" && source.path).toBe(join(dir, "kb"));
    const missing = readNetworkConfig(join(dir, "nowhere.yaml"), HOME);
    expect(!missing.ok && missing.problems.join(" ")).toMatch(/nowhere\.yaml/);
    const folder = readNetworkConfig(dir, HOME);
    expect(folder.ok).toBe(false);
  });
});

describe("readNetworkConfig: size (bite 4 build review)", () => {
  it("refuses a configuration file over one megabyte without reading it whole", () => {
    const dir = mkdtempSync(join(tmpdir(), "okf-catalog-bigconfig-"));
    const path = join(dir, "okf-catalog.yaml");
    writeFileSync(path, `company: acme\nsource:\n  local: ./kb\n# ${"x".repeat(1_100_000)}\n`);
    const r = readNetworkConfig(path, "/home/x");
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
    const relaxed = parse(`company: acme\nsource:\n  repository: "file:///tmp/origin.git"\n`, {
      allowFileRepositories: true,
    });
    expect(relaxed.ok).toBe(true);
    const path = parse(`company: acme\nsource:\n  repository: "/tmp/origin.git"\n`, {
      allowFileRepositories: true,
    });
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

// D76: a network: file names its bundles; the top-level keys are the defaults every bundle inherits.
describe("parseNetworkConfig: a network of bundles (D76)", () => {
  const two = `network: acme
serve:
  admit: [stable, archived]
  pull_interval: 5m
  limit_default: 12
caps:
  files: 500
types: [Term, Guide]
spec_text: 2026-08-21
bundles:
  - id: handbook
    source:
      local: ./handbook
  - id: metrics
    source:
      repository: git@example.test:acme/metrics.git
      bundle_path: kb
    serve:
      admit: [stable]
      pull_interval: 1h
    caps:
      file_bytes: 1000
    types: [Metric]
    spec_text: 2026-08-15
`;

  it("inherits network defaults and takes a bundle's overrides", () => {
    const r = config(two);
    expect(r.network).toBe("acme");
    expect(r.form).toBe("network");
    expect(r.limitDefault).toBe(12);
    expect(r.bundles.map((b) => b.id)).toEqual(["handbook", "metrics"]);
    const [handbook, metrics] = r.bundles as [BundleConfig, BundleConfig];
    expect(handbook).toEqual({
      id: "handbook",
      source: { kind: "local", path: "/srv/acme/config/handbook", configured: "./handbook" },
      serve: { admit: ["stable", "archived"], dev: false, pullIntervalMs: 300_000 },
      integrity: "require-manifest",
      caps: { fileBytes: 2 * 1024 * 1024, files: 500, treeBytes: 512 * 1024 * 1024 },
      types: ["Term", "Guide"],
      specText: "2026-08-21",
    });
    expect(metrics).toEqual({
      id: "metrics",
      source: {
        kind: "git",
        repository: "git@example.test:acme/metrics.git",
        branch: "published",
        bundlePath: "kb",
      },
      serve: { admit: ["stable"], dev: false, pullIntervalMs: 3_600_000 },
      integrity: "require-manifest",
      // A bundle's caps replace the defaults key by key.
      caps: { fileBytes: 1000, files: 500, treeBytes: 512 * 1024 * 1024 },
      types: ["Metric"],
      specText: "2026-08-15",
    });
    // A bundle with nothing of its own takes the built-in defaults when the network sets none.
    const plain = config("network: acme\nbundles:\n  - id: kb\n    source:\n      local: ./kb\n");
    expect(plain.limitDefault).toBe(8);
    expect(plain.bundles[0]?.serve).toEqual({
      admit: ["stable", "deprecated"],
      dev: false,
      pullIntervalMs: 600_000,
    });
  });

  it("allows serve.dev on a local bundle only, and turns integrity off for it alone", () => {
    const r = config(`network: acme
bundles:
  - id: drafts
    source:
      local: ./drafts
    serve:
      dev: true
  - id: published
    source:
      local: ./published
`);
    const [drafts, published] = r.bundles as [BundleConfig, BundleConfig];
    expect([drafts.serve.dev, drafts.integrity]).toEqual([true, "none"]);
    expect([published.serve.dev, published.integrity]).toEqual([false, "require-manifest"]);
    expect(
      problems(`network: acme
bundles:
  - id: remote
    source:
      repository: git@example.test:acme/kb.git
    serve:
      dev: true
`),
    ).toEqual(["bundles[0].serve.dev: allowed only with source.local"]);
    // Development mode is a bundle's, never the network's: a top-level serve.dev is refused, with the key.
    expect(
      problems(`network: acme
serve:
  dev: true
bundles:
  - id: kb
    source:
      local: ./kb
`),
    ).toEqual([
      "serve.dev: set it on the local bundle it is for (bundles[n].serve.dev); a network: file has no development mode of its own",
    ]);
  });

  it("refuses company with network, a repeated id, vendor, dist and build, and a local path inside the cache or another bundle", () => {
    const bundle = (id: string, local: string) =>
      `  - id: ${id}\n    source:\n      local: ${local}\n`;
    expect(
      problems(
        `company: acme\nnetwork: acme\nsource:\n  local: ./kb\nbundles:\n${bundle("kb", "./kb")}`,
      ),
    ).toEqual([
      "company and network: a file names one network with network: and bundles:, or one bundle with company: and source:, never both",
    ]);
    expect(problems("source:\n  local: ./kb\n")).toEqual([
      "network: required (network: and bundles:), or company: with one source: for a one-bundle network",
    ]);
    expect(
      problems(`network: acme\nbundles:\n${bundle("kb", "./one")}${bundle("kb", "./two")}`),
    ).toEqual(['bundles[1].id: "kb" is the id of bundles[0] too; each bundle needs its own']);
    // A company: file's company may still be one of them, until 0.5.0: see the alias's own test below.
    for (const id of ["vendor", "dist", "build"]) {
      expect(problems(`network: acme\nbundles:\n${bundle(id, "./kb")}`), id).toEqual([
        `bundles[0].id: must not be vendor, dist or build, the folder names the search engine skips`,
      ]);
    }
    expect(problems(`network: acme\nbundles:\n${bundle("Big Kb", "./kb")}`)).toEqual([
      "bundles[0].id: must be one lower-case path segment (letters, digits and hyphens, starting with a letter or digit, at most 63 characters)",
    ]);
    expect(problems("network: acme\nbundles: []\n").join(" ")).toMatch(/^bundles: /);
    expect(problems(`network: Acme Inc\nbundles:\n${bundle("kb", "./kb")}`)).toEqual([
      "network: must be one lower-case path segment (letters, digits and hyphens, starting with a letter or digit, at most 63 characters)",
    ]);
    // A bundle folder inside the okf-catalog cache folder, or holding the network's, is refused when the cache
    // root is known.
    const cached = { cacheRoot: "/home/someone/.cache" };
    const inside = "~/.cache/okf-catalog/acme/kb";
    expect(problems(`network: acme\nbundles:\n${bundle("kb", inside)}`, cached)).toEqual([
      "bundles[0].source.local: lies inside the okf-catalog cache folder (every network's) or holds this network's; set XDG_CACHE_HOME to a folder outside the bundle",
    ]);
    expect(problems(`network: acme\nbundles:\n${bundle("kb", "/home/someone")}`, cached)).toEqual([
      "bundles[0].source.local: lies inside the okf-catalog cache folder (every network's) or holds this network's; set XDG_CACHE_HOME to a folder outside the bundle",
    ]);
    expect(problems(`company: acme\nsource:\n  local: ${inside}\n`, cached)).toEqual([
      "source.local: lies inside the okf-catalog cache folder (every network's) or holds this network's; set XDG_CACHE_HOME to a folder outside the bundle",
    ]);
    expect(problems(`network: acme\nbundles:\n${bundle("kb", inside)}`)).toEqual([]);
    // A bundle folder inside another bundle's folder, or the same folder, is refused: two bundles never share files.
    expect(
      problems(`network: acme\nbundles:\n${bundle("a", "./kb")}${bundle("b", "./kb/sub")}`),
    ).toEqual([
      'bundles[1].source.local: lies inside the folder of bundle "a", or holds it; two bundles never share a file',
    ]);
    expect(
      problems(`network: acme\nbundles:\n${bundle("a", "./kb/sub")}${bundle("b", "./kb")}`),
    ).toEqual([
      'bundles[1].source.local: lies inside the folder of bundle "a", or holds it; two bundles never share a file',
    ]);
    expect(
      problems(`network: acme\nbundles:\n${bundle("a", "./kb")}${bundle("b", "./kb-two")}`),
    ).toEqual([]);
    // Keys that are a bundle's alone, or the network's alone, are named where they are wrong.
    expect(
      problems(
        `network: acme\nbundles:\n  - id: kb\n    source:\n      local: ./kb\n    serve:\n      limit_default: 3\n`,
      ),
    ).toEqual(["bundles[0].serve.limit_default: unknown key"]);
    expect(
      problems(`network: acme\nsource:\n  local: ./kb\nbundles:\n${bundle("kb", "./kb")}`),
    ).toEqual(["source: unknown key"]);
    expect(
      problems(
        `network: acme\nbundles:\n  - id: kb\n    source:\n      repository: "nope"\n      branch: "a..b"\n`,
      ),
    ).toEqual([
      "bundles[0].source.repository: must be an https:// or ssh:// URL, or user@host:path",
      "bundles[0].source.branch: must be a plain branch name of letters, digits, '.', '_', '-' and '/'",
    ]);
  });
});

// The fold of bite c's build reviews, C-A-A6: two spellings of one folder are one folder, and the server's cache
// folder holds no bundle, whichever network's part of it a bundle would sit in (D76).
describe("parseNetworkConfig: local folders by their real paths (D76)", () => {
  const scratch = mkdtempSync(join(tmpdir(), "okf-catalog-config-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const network = (...locals: string[]): string =>
    `network: acme\nbundles:\n${locals.map((local, i) => `  - id: b${i}\n    source:\n      local: ${local}\n`).join("")}`;
  const at = (text: string, options: ParseOptions = {}): string[] => {
    const r = parseNetworkConfig(text, scratch, HOME, options);
    return r.ok ? [] : r.problems;
  };

  it("takes a link to a bundle's folder, or its name in another case where the file system ignores case, for that folder", () => {
    mkdirSync(join(scratch, "real", "sub"), { recursive: true });
    mkdirSync(join(scratch, "other"));
    symlinkSync(join(scratch, "real"), join(scratch, "link"));
    const shared =
      'bundles[1].source.local: lies inside the folder of bundle "b0", or holds it; two bundles never share a file';
    expect(at(network("./real", "./link"))).toEqual([shared]);
    expect(at(network("./link/sub", "./real"))).toEqual([shared]);
    expect(at(network("./real", "./other"))).toEqual([]);
    // A file system that ignores case (macOS by default) finds the folder under the other spelling: one folder.
    const ignoresCase = existsSync(join(scratch, "REAL"));
    expect(at(network("./real", "./REAL"))).toEqual(ignoresCase ? [shared] : []);
  });

  it("refuses a local bundle anywhere in the okf-catalog cache folder, any network's part of it, or holding this network's", () => {
    const cacheRoot = join(scratch, "cache");
    const another = join(cacheRoot, "okf-catalog", "other", "bundles", "b", "derived");
    mkdirSync(another, { recursive: true });
    mkdirSync(join(cacheRoot, "elsewhere", "kb"), { recursive: true });
    symlinkSync(join(cacheRoot, "okf-catalog", "other"), join(scratch, "into-cache"));
    const cached = { cacheRoot };
    const refused = (key: string): string[] => [
      `${key}: lies inside the okf-catalog cache folder (every network's) or holds this network's; set XDG_CACHE_HOME to a folder outside the bundle`,
    ];
    // Another network's folder in the cache, the cache folder itself, a link into it.
    expect(at(network(another), cached)).toEqual(refused("bundles[0].source.local"));
    expect(at(network(join(cacheRoot, "okf-catalog")), cached)).toEqual(
      refused("bundles[0].source.local"),
    );
    expect(at(network("./into-cache"), cached)).toEqual(refused("bundles[0].source.local"));
    expect(at(`company: acme\nsource:\n  local: ./into-cache\n`, cached)).toEqual(
      refused("source.local"),
    );
    // A folder that holds this network's folder, even one not yet made.
    expect(at(network(cacheRoot), cached)).toEqual(refused("bundles[0].source.local"));
    // Beside the okf-catalog folder, under the same cache root, a bundle is fine.
    expect(at(network(join(cacheRoot, "elsewhere", "kb")), cached)).toEqual([]);
    // Without the cache root (pack writes no cache), nothing is checked against it.
    expect(at(network(another))).toEqual([]);
  });
});

// The fold of bite c's build reviews, C-A-A6: two repository bundles never serve one tree, the same one or one inside
// the other, of one repository and branch (D76).
describe("parseNetworkConfig: repository bundles that would serve one tree (D76)", () => {
  const repo = (id: string, repository: string, more = ""): string =>
    `  - id: ${id}\n    source:\n      repository: "${repository}"\n${more}`;
  const at = (...bundles: string[]): string[] =>
    problems(`network: acme\nbundles:\n${bundles.join("")}`);
  const KB = "https://example.test/acme/kb.git";

  it("refuses the same repository, branch and bundle_path twice, however the repository is written", () => {
    const same =
      'bundles[1].source: the same repository, branch and bundle_path as bundle "a"; two bundles never share a file';
    expect(at(repo("a", KB), repo("b", KB))).toEqual([same]);
    for (const other of [
      "https://EXAMPLE.test/acme/kb",
      "https://example.test/acme/kb.git/",
      "git@example.test:acme/kb.git",
      "ssh://git@example.test/acme/kb",
    ])
      expect(at(repo("a", KB), repo("b", other)), other).toEqual([same]);
    // The defaults count as written: the branch published and the bundle path ".".
    expect(
      at(repo("a", KB, "      branch: published\n      bundle_path: .\n"), repo("b", KB)),
    ).toEqual([same]);
  });

  it("refuses a bundle_path inside another's, or holding it, in one repository and branch", () => {
    const nested = (of: string): string[] => [
      `bundles[1].source.bundle_path: lies inside the bundle_path of bundle "${of}" in the same repository and branch, or holds it; two bundles never share a file`,
    ];
    expect(
      at(repo("a", KB, "      bundle_path: kb\n"), repo("b", KB, "      bundle_path: kb/eu\n")),
    ).toEqual(nested("a"));
    expect(
      at(repo("a", KB, "      bundle_path: kb/eu\n"), repo("b", KB, "      bundle_path: kb\n")),
    ).toEqual(nested("a"));
    expect(at(repo("a", KB), repo("b", KB, "      bundle_path: kb\n"))).toEqual(nested("a"));
  });

  it("takes two trees that share nothing: another branch, a sibling folder, another repository", () => {
    expect(at(repo("a", KB), repo("b", KB, "      branch: staging\n"))).toEqual([]);
    expect(
      at(repo("a", KB, "      bundle_path: kb\n"), repo("b", KB, "      bundle_path: kb2\n")),
    ).toEqual([]);
    expect(at(repo("a", KB), repo("b", "https://example.test/acme/kb-two.git"))).toEqual([]);
    expect(at(repo("a", KB), repo("b", "https://other.test/acme/kb.git"))).toEqual([]);
  });
});

// The fold of bite c's build reviews, C-I-E3: "company: still loads" holds for a version 0 file whose company is one
// of the names a network: file refuses as a bundle id; the alias takes it, with a note, until 0.5.0 removes company:.
describe("parseNetworkConfig: the notes a configuration carries (D-G, D76)", () => {
  const ALIAS =
    "company: is read as a network of that name with one bundle of that id; write network: and bundles: before 0.5.0, which removes company:";

  it("takes vendor, dist and build as a company: file's company until 0.5.0, with a note, and refuses them as a bundle id", () => {
    for (const id of ["vendor", "dist", "build"]) {
      const r = config(`company: ${id}\nsource:\n  local: ./kb\n`);
      expect(r.network, id).toBe(id);
      expect(
        r.bundles.map((b) => b.id),
        id,
      ).toEqual([id]);
      expect(r.notes, id).toEqual([
        ALIAS,
        `company: ${id} stays the bundle's id until 0.5.0 removes company:; a network: file refuses vendor, dist and build as bundle ids (folder names the search engine skips), so give the bundle another id when you write network: and bundles:`,
      ]);
      expect(
        problems(`network: acme\nbundles:\n  - id: ${id}\n    source:\n      local: ./kb\n`),
        id,
      ).toEqual([
        "bundles[0].id: must not be vendor, dist or build, the folder names the search engine skips",
      ]);
    }
    // Any other company: file carries the alias's note alone, and a network: file none.
    expect(config(base).notes).toEqual([ALIAS]);
    expect(
      config("network: acme\nbundles:\n  - id: kb\n    source:\n      local: ./kb\n").notes,
    ).toEqual([]);
  });
});
