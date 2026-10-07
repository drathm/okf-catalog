import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import type { ReservedFile } from "../bundle/model.js";
import { byCodeUnit } from "../bundle/paths.js";
import { type Catalog, listTypes } from "../catalog/model.js";
import { nearestPaths } from "../catalog/nearest.js";
import {
  CatalogOutputSchema,
  type PageOutput,
  PageOutputSchema,
  projectCatalog,
  projectPage,
  projectReserved,
  projectSearch,
  projectStatus,
  refusingText,
  SearchOutputSchema,
  StatusOutputSchema,
  statusSummary,
} from "../catalog/outputs.js";
import type { Generation, Runtime, ToolOptions } from "../catalog/runtime.js";
import { DATA_SENTENCE, safe } from "../catalog/text.js";
import type { Log } from "../log.js";
import type { Engine } from "../search/engine.js";
import { search } from "../search/search.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  /** Extra fields for the `tool.call` log record, stripped before the result leaves. */
  logFields?: Record<string, number>;
};

const FOLDER_LIST_CAP = 50;

const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });
const ok = (text: string, structured: Record<string, unknown>): ToolResult => ({
  content: [{ type: "text", text }],
  structuredContent: structured,
});

/** A blank optional string means absent. */
const blank = (value: string | undefined): string | undefined =>
  value === undefined || value.trim().length === 0 ? undefined : value.trim();

/** A folder as the search filter normalises it: no leading or trailing slashes; the empty string is the root. */
const normaliseFolder = (value: string): string => value.trim().replace(/^\/+|\/+$/g, "");

/** A page path as the model may write it: one leading `/` or `./` stripped (OKF bundle-absolute links). */
const normalisePath = (value: string): string => value.trim().replace(/^(\.\/|\/)/, "");

function folderList(catalog: Catalog): string {
  const names = [...catalog.folders.keys()]
    .sort(byCodeUnit)
    .map((f) => (f === "" ? "(root)" : safe(f)));
  const shown = names.slice(0, FOLDER_LIST_CAP).join(", ");
  return names.length > FOLDER_LIST_CAP ? `${shown} … (${names.length} folders)` : shown;
}

function refused(generation: Generation): ToolResult | undefined {
  const fatal = generation.report.fatal;
  if (fatal === undefined) return undefined;
  return fail(
    `the bundle was refused and nothing is served: ${safe(fatal.rule)}${fatal.path ? ` (${safe(fatal.path)})` : ""}: ${safe(fatal.detail)}`,
  );
}

function reservedAt(
  catalog: Catalog,
  path: string,
): { file: ReservedFile; source: "file" | "generated" } | undefined {
  const slash = path.lastIndexOf("/");
  const folder = slash === -1 ? "" : path.slice(0, slash);
  const name = slash === -1 ? path : path.slice(slash + 1);
  const entry = catalog.folders.get(folder);
  if (entry === undefined) return undefined;
  if (name === "index.md" && entry.index !== undefined)
    return { file: entry.index, source: entry.indexSource };
  if (name === "log.md" && entry.log !== undefined) return { file: entry.log, source: "file" };
  return undefined;
}

function servedPaths(catalog: Catalog): string[] {
  const paths = [...catalog.pages.keys()];
  for (const [folder, entry] of catalog.folders) {
    const prefix = folder === "" ? "" : `${folder}/`;
    if (entry.index !== undefined) paths.push(`${prefix}index.md`);
    if (entry.log !== undefined) paths.push(`${prefix}log.md`);
  }
  return paths;
}

function pageText(output: PageOutput): string {
  const tail =
    output.truncated && output.nextOffset !== undefined
      ? `\n[truncated at the result budget; continue with offset ${output.nextOffset}]`
      : "";
  return `${output.citation}\n${output.notice}\n${output.body}${tail}`;
}

const describeType = (text: string): string => `${text} ${DATA_SENTENCE}`;

/** The one sentence every tool answers with while the server cannot serve: the fix, never a path the model has no business with. */
const refusingSentence = (refusing: string): string =>
  `the server is refusing every request until its configuration is fixed: ${refusingText(refusing)}`;

/**
 * The four tools. Every handler runs under a lease on the current generation, answers in both channels, and
 * turns anything it cannot repair into a fixed sentence; the detail goes to the log, never to the model.
 */
export function registerTools(
  server: McpServer,
  runtime: Runtime,
  options: ToolOptions,
  clock: () => Date,
  log?: Log,
): void {
  const guarded =
    <A>(
      tool: string,
      fn: (args: A, generation: Generation, engine: Engine) => Promise<ToolResult> | ToolResult,
    ) =>
    async (args: A): Promise<ToolResult> => {
      const started = performance.now();
      const refusing = runtime.status().refusing;
      if (refusing !== undefined) return fail(refusingSentence(refusing));
      try {
        const { logFields, ...result } = await runtime.lease<ToolResult>(
          async (generation, engine) => fn(args, generation, engine),
        );
        const hits = (result.structuredContent as { hits?: unknown[] } | undefined)?.hits?.length;
        log?.info("tool.call", {
          tool,
          ms: Math.round(performance.now() - started),
          ...(hits === undefined ? {} : { hits }),
          ...(logFields ?? {}),
          ...(result.isError === true ? { error: "answered-with-error" } : {}),
        });
        return result;
      } catch (error) {
        log?.error("tool.call", {
          tool,
          ms: Math.round(performance.now() - started),
          error: (error as Error).message,
        });
        // The call that started the first load is the one that sees it fail: answer with the fix, as later calls do.
        const refusingNow = runtime.status().refusing;
        if (refusingNow !== undefined) return fail(refusingSentence(refusingNow));
        return fail("the server hit a defect answering this call; its log has the detail");
      }
    };

  server.registerTool(
    "search",
    {
      title: "Search the knowledge bundle",
      description: describeType(
        "Finds pages by keywords. Write one concept per word; common words are dropped, and when no page holds every word the match is relaxed and the result says so. Each hit carries its path, type, status, trust tier, recheck date, source count, resource and a quoted snippet.",
      ),
      inputSchema: z.object({
        question: z
          .string()
          .min(1)
          .max(200)
          .describe("Keywords, or a short question; one concept per word."),
        type: z
          .string()
          .max(200)
          .optional()
          .describe("Only pages of this type (case does not matter)."),
        topic: z
          .string()
          .max(1024)
          .optional()
          .describe("Only pages under this folder of the bundle."),
        include_stale: z
          .boolean()
          .optional()
          .describe("Include pages past their recheck date; they are flagged as overdue."),
        limit: z.number().int().min(1).max(25).optional().describe("How many hits, 1 to 25."),
      }),
      outputSchema: SearchOutputSchema,
      annotations: { readOnlyHint: true },
    },
    guarded("search", async (args, generation, engine) => {
      const stop = refused(generation);
      if (stop !== undefined) return stop;
      const wantedType = blank(args.type);
      let type: string | undefined;
      if (wantedType !== undefined) {
        const types = listTypes(generation.catalog);
        type = types.find((t) => t.toLowerCase() === wantedType.toLowerCase());
        if (type === undefined) {
          return fail(
            `no page has the type ${JSON.stringify(safe(wantedType))}; the types in use are: ${types.map(safe).join(", ") || "(none)"}`,
          );
        }
      }
      const wantedTopic = blank(args.topic);
      let topic: string | undefined;
      if (wantedTopic !== undefined) {
        topic = normaliseFolder(wantedTopic);
        if (topic.length > 0 && !generation.catalog.folders.has(topic)) {
          return fail(
            `there is no folder ${JSON.stringify(safe(topic))}; the folders are: ${folderList(generation.catalog)}`,
          );
        }
        if (topic.length === 0) topic = undefined;
      }
      const now = clock();
      const response = await search(
        generation.catalog,
        engine,
        {
          question: args.question,
          ...(type === undefined ? {} : { type }),
          ...(topic === undefined ? {} : { topic }),
          includeStale: args.include_stale ?? false,
          limit: args.limit ?? options.limitDefault,
        },
        now,
      );
      if (response.reason === "no-content-terms") {
        return fail(
          "every word of the question is a common word the index ignores; ask with keywords, the distinctive words a page would use",
        );
      }
      const output = projectSearch(response, generation.catalog, now, {
        dev: options.dev,
        undeclaredTypes: new Set(generation.report.unknownTypes),
      });
      return {
        ...ok([output.summary, ...output.hits.map((h) => h.citation)].join("\n"), output),
        logFields: { engineQueries: response.engineQueries, rowsFetched: response.rowsFetched },
      };
    }),
  );

  server.registerTool(
    "get_page",
    {
      title: "Read a page",
      description: describeType(
        "Returns one page whole, with its provenance header first: path, type, status, trust tier, verifier, recheck date and deprecation. Reserved files (index.md, log.md) are served too. A long page is cut at the result budget and says where to continue.",
      ),
      inputSchema: z.object({
        path: z
          .string()
          .min(1)
          .max(1024)
          .describe("The page's path in the bundle, as a search result or a catalog lists it."),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Continue a long page from this character offset."),
      }),
      outputSchema: PageOutputSchema,
      annotations: { readOnlyHint: true },
    },
    guarded("get_page", (args, generation) => {
      const stop = refused(generation);
      if (stop !== undefined) return stop;
      const path = normalisePath(args.path);
      const offset = args.offset ?? 0;
      const page = generation.catalog.pages.get(path);
      if (page !== undefined) {
        const output = projectPage(page, clock(), offset, options.resultBudget, {
          undeclaredTypes: new Set(generation.report.unknownTypes),
        });
        return ok(pageText(output), output);
      }
      const reserved = reservedAt(generation.catalog, path);
      if (reserved !== undefined) {
        const output = projectReserved(
          reserved.file,
          reserved.source,
          offset,
          options.resultBudget,
        );
        return ok(pageText(output), output);
      }
      const nearest = nearestPaths(servedPaths(generation.catalog), path);
      return fail(
        `no page at ${JSON.stringify(safe(path))}; the nearest served paths are: ${nearest.map(safe).join(", ") || "(none)"}`,
      );
    }),
  );

  server.registerTool(
    "catalog",
    {
      title: "List a folder of the bundle",
      description: describeType(
        "Returns a folder's index: its pages with their titles and descriptions, and the folder's index text as the company wrote it or as the server generated it. Start here, at the root, to see what exists.",
      ),
      inputSchema: z.object({
        folder: z
          .string()
          .max(1024)
          .optional()
          .describe("A folder of the bundle; omit for the root."),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Continue a long index from this character offset."),
      }),
      outputSchema: CatalogOutputSchema,
      annotations: { readOnlyHint: true },
    },
    guarded("catalog", (args, generation) => {
      const stop = refused(generation);
      if (stop !== undefined) return stop;
      const folder = normaliseFolder(args.folder ?? "");
      const output = projectCatalog(
        generation.catalog,
        folder,
        args.offset ?? 0,
        options.resultBudget,
      );
      if (output === undefined) {
        return fail(
          `there is no folder ${JSON.stringify(safe(folder))}; the folders are: ${folderList(generation.catalog)}`,
        );
      }
      const tail =
        output.truncated && output.nextOffset !== undefined
          ? `\n[truncated at the result budget; continue with offset ${output.nextOffset}]`
          : "";
      const head = `catalog of ${folder === "" ? "the bundle root" : safe(folder)} (${output.source} index, ${output.entries.length} pages)`;
      return ok(`${head}\n${output.notice}\n${output.text}${tail}`, output);
    }),
  );

  server.registerTool(
    "status",
    {
      title: "Report the bundle's state",
      description: describeType(
        "Reports what was loaded: counts of pages admitted, refused and degraded, the lists the report carries, the integrity mode, the engine's counts and the lock. Nothing in it is page text.",
      ),
      inputSchema: z.object({}),
      outputSchema: StatusOutputSchema,
      annotations: { readOnlyHint: true },
    },
    guarded("status", (_args, generation) => {
      const output = projectStatus(generation, runtime.status(), options, clock());
      return ok(statusSummary(output), output);
    }),
  );
}
