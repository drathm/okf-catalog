/** @type {import('dependency-cruiser').IConfiguration} */
const CORE = "^src/(bundle|catalog|derive|search)/";
const ADAPTERS = "^src/(engine|mcp)/";
const EDGES = "^src/(source|fs|config|report)/|^src/log\\.ts$";
const COMMANDS = "^src/commands/";
const COMPOSITION = "^src/serve/";
const CORE_NPM =
  "^node_modules/(yaml|zod|mdast-util-from-markdown|mdast-util-to-string|mdast-util-gfm-footnote|mdast-util-gfm-table|micromark-extension-gfm-footnote|micromark-extension-gfm-table|@types/mdast|@types/unist)/";

module.exports = {
  forbidden: [
    {
      name: "core-node-builtins",
      comment: "The core may use only crypto, path, path/posix and url from Node.",
      severity: "error",
      from: { path: CORE },
      to: { dependencyTypes: ["core"], pathNot: "^(node:)?(crypto|path|path/posix|url)$" },
    },
    {
      name: "core-npm-allowlist",
      comment: "The core may depend only on yaml, zod and the mdast utilities.",
      severity: "error",
      from: { path: CORE },
      to: {
        dependencyTypes: [
          "npm",
          "npm-dev",
          "npm-optional",
          "npm-peer",
          "npm-no-pkg",
          "npm-unknown",
        ],
        pathNot: CORE_NPM,
      },
    },
    {
      name: "core-stays-core",
      comment: "The core imports nothing from the adapters, edges or commands.",
      severity: "error",
      from: { path: CORE },
      to: { path: "^src/", pathNot: CORE },
    },
    {
      name: "qmd-only-in-engine",
      comment: "Only the engine adapter may import qmd.",
      severity: "error",
      from: { pathNot: "^src/engine/" },
      to: { path: "^node_modules/@tobilu/qmd/" },
    },
    {
      name: "mcp-sdk-only-in-mcp",
      comment: "Only the MCP adapter may import the MCP SDK.",
      severity: "error",
      from: { pathNot: "^src/mcp/" },
      to: { path: "^node_modules/@modelcontextprotocol/" },
    },
    {
      name: "adapters-import-core-and-self",
      comment:
        "An adapter imports the core, its own files and its one library; never another adapter, an edge or a command.",
      severity: "error",
      from: { path: "^src/(engine|mcp)/" },
      to: { path: "^src/", pathNot: `${CORE}|^src/log\\.ts$|^src/$1/` },
    },
    {
      name: "edges-no-adapters-or-commands",
      comment: "Edges import the core and Node, never an adapter, a command or the entry point.",
      severity: "error",
      from: { path: EDGES },
      to: { path: `${ADAPTERS}|${COMPOSITION}|${COMMANDS}|^src/cli\\.ts$` },
    },
    {
      name: "composition-imports-everything-but-commands",
      comment:
        "src/serve/ composes the core, the adapters and the edges; nothing above it (commands, cli) is imported, and only commands import it.",
      severity: "error",
      from: { path: COMPOSITION },
      to: { path: `${COMMANDS}|^src/cli\\.ts$` },
    },
    {
      name: "only-commands-import-composition",
      severity: "error",
      from: { pathNot: `${COMPOSITION}|${COMMANDS}` },
      to: { path: COMPOSITION },
    },
    {
      name: "cli-only-commands",
      comment: "The entry point imports commands and nothing else of ours.",
      severity: "error",
      from: { path: "^src/cli\\.ts$" },
      to: { path: "^src/", pathNot: COMMANDS },
    },
    {
      name: "not-to-unresolvable",
      comment: "Every import must resolve; an unresolved one would slip past every rule above.",
      severity: "error",
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: "no-non-package-json",
      comment: "Every npm dependency is declared in package.json.",
      severity: "error",
      from: {},
      to: { dependencyTypes: ["npm-no-pkg", "npm-unknown"] },
    },
    {
      name: "no-dev-deps-in-src",
      comment: "Production code does not import development dependencies.",
      severity: "error",
      from: { path: "^src/" },
      to: {
        dependencyTypes: ["npm-dev"],
        dependencyTypesNot: ["type-only"],
        pathNot: "node_modules/@types/",
      },
    },
  ],
  options: {
    doNotFollow: { path: ["node_modules"] },
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
    detectProcessBuiltinModuleCalls: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      mainFields: ["module", "main", "types", "typings"],
    },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
