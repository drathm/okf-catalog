import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "plugin", "claude-code");
const read = (rel: string): string => readFileSync(join(PLUGIN, rel), "utf8");

describe("the Claude Code plugin files (shape only; Claude Code's own validator is the authority)", () => {
  it("declares its two options with the required fields and the directory and file types", () => {
    const manifest = JSON.parse(read(".claude-plugin/plugin.json")) as {
      name: string;
      version: string;
      description: string;
      userConfig: Record<
        string,
        { type: string; title: string; description: string; required?: boolean }
      >;
    };
    expect(manifest.name).toBe("okf-catalog");
    expect(manifest.version).toBe(
      JSON.parse(readFileSync(join(PLUGIN, "..", "..", "package.json"), "utf8")).version,
    );
    expect(manifest.description.length).toBeGreaterThan(0);
    expect(Object.keys(manifest.userConfig).sort()).toEqual(["config_path", "install_path"]);
    for (const [key, option] of Object.entries(manifest.userConfig)) {
      expect(option.title.length, key).toBeGreaterThan(0);
      expect(option.description.length, key).toBeGreaterThan(0);
      expect(option.required, key).toBe(true);
      expect(Object.keys(option).sort(), key).toEqual(["description", "required", "title", "type"]);
    }
    expect(manifest.userConfig.install_path?.type).toBe("directory");
    expect(manifest.userConfig.config_path?.type).toBe("file");
  });

  it("runs node on the installed cli with the configuration path in the environment, each path one argument", () => {
    const mcp = JSON.parse(read(".mcp.json")) as {
      mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
    };
    const server = mcp.mcpServers["okf-catalog"];
    if (server === undefined) throw new Error("no okf-catalog server entry");
    expect(server.command).toBe("node");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the placeholder is what Claude Code substitutes
    expect(server.args).toEqual(["${user_config.install_path}/dist/cli.js", "serve"]);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the placeholder is what Claude Code substitutes
    expect(server.env).toEqual({ OKF_CATALOG_CONFIG: "${user_config.config_path}" });
    for (const arg of server.args) expect(arg).not.toMatch(/\s/);
  });

  it("ships a skill whose frontmatter starts the file and names when to use it", () => {
    const skill = read("skills/okf-catalog/SKILL.md");
    expect(skill.startsWith("---\n")).toBe(true);
    const frontmatter = skill.split("---\n")[1] ?? "";
    expect(frontmatter).toMatch(/^name: okf-catalog$/m);
    expect(frontmatter).toMatch(/^description: .+/m);
    const body = skill.split("---\n").slice(2).join("---\n");
    expect(body.split("\n").length).toBeLessThan(80);
    for (const phrase of [
      "catalog",
      "search",
      "get_page",
      "trust",
      "recheck",
      "no page",
      "data",
      "/mcp",
    ]) {
      expect(body, phrase).toContain(phrase);
    }
  });
});
