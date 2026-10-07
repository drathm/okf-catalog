import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path: string): string => readFileSync(join(REPO, path), "utf8");
const pkg = JSON.parse(read("package.json")) as {
  version: string;
  private?: boolean;
  files: string[];
  author?: string;
  repository?: unknown;
  publishConfig?: unknown;
};

/** What npm packs beside `dist/`: the `files` entries plus the files npm always includes. */
const FIXED = [
  "CHANGELOG.md",
  "LICENSE",
  "NOTICE",
  "README.md",
  "package.json",
  "plugin/claude-code/.claude-plugin/plugin.json",
  "plugin/claude-code/.mcp.json",
  "plugin/claude-code/skills/okf-catalog/SKILL.md",
  "recipes/publish/README.md",
  "recipes/publish/checkers.lock",
  "recipes/publish/checkers.txt",
  "recipes/publish/pack.sh",
  "recipes/publish/publish.yml",
  "recipes/publish/push.sh",
].sort();

describe("the release candidate", () => {
  it("carries one version in the package, in both lock fields and in the plugin", () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    const lock = JSON.parse(read("package-lock.json")) as {
      version: string;
      packages: Record<string, { version: string }>;
    };
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages[""]?.version).toBe(pkg.version);
    const plugin = JSON.parse(read("plugin/claude-code/.claude-plugin/plugin.json")) as {
      version: string;
    };
    expect(plugin.version).toBe(pkg.version);
  });

  // Measured on 0.1.0 (2026-10-07): with `npm-shrinkwrap.json` in the tarball, `npm install okf-catalog` put the
  // whole locked tree under `node_modules/okf-catalog/node_modules`, development tools and every platform's native
  // binaries included: 336 packages, 3.1 GB. Without it: 204 packages, 227 MB, hoisted and filtered by platform.
  it("ships no lock file, so an install resolves and filters the dependencies like any package", () => {
    expect(existsSync(join(REPO, "npm-shrinkwrap.json"))).toBe(false);
    expect(pkg.files).not.toContain("npm-shrinkwrap.json");
  });

  it("is publishable to npm as a public package with provenance, under its owner", () => {
    expect(pkg.private).toBeUndefined();
    expect(pkg.publishConfig).toEqual({ access: "public", provenance: true });
    expect(pkg.author).toContain("Bitfusion PR LLC");
    expect(pkg.repository).toEqual({
      type: "git",
      url: "git+https://github.com/drathm/okf-catalog.git",
    });
  });

  it("opens the changelog with the unreleased section or the package's own version", () => {
    const heading = read("CHANGELOG.md")
      .split("\n")
      .find((line) => line.startsWith("## "));
    expect(heading).toMatch(
      new RegExp(`^## \\[(Unreleased|${pkg.version.replace(/\./g, "\\.")})\\]`),
    );
  });

  it("packs exactly the runtime, the recipe and the notices, with a source file for every dist file", () => {
    const out = execFileSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
      cwd: REPO,
      encoding: "utf8",
      env: { ...process.env, NODE_LLAMA_CPP_SKIP_DOWNLOAD: "1" },
      stdio: ["ignore", "pipe", "ignore"],
    });
    const [result] = JSON.parse(out) as Array<{ files: Array<{ path: string }> }>;
    const files = (result?.files ?? []).map((f) => f.path);
    expect(files.filter((f) => !f.startsWith("dist/")).sort()).toEqual(FIXED);
    const dist = files.filter((f) => f.startsWith("dist/"));
    expect(dist.length).toBeGreaterThan(0);
    for (const file of dist) {
      expect(file, file).toMatch(/\.(js|d\.ts)(\.map)?$/);
      const source = file.replace(/^dist\//, "src/").replace(/(\.d\.ts|\.js)(\.map)?$/, ".ts");
      expect(existsSync(join(REPO, source)), `${file} has no ${source}`).toBe(true);
    }
  });

  it("ignores the acceptance results and the model folder", () => {
    const ignored = read(".gitignore").split("\n");
    expect(ignored).toContain("/bench/acceptance/results/");
    expect(ignored).toContain("/bench/.models/");
  });
});
