import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import type { Page } from "../bundle/model.js";
import { byCodeUnit } from "../bundle/paths.js";
import { citationsOf, DEFAULT_DEPTH, MAX_DEPTH, walkProvenance } from "../catalog/graph.js";
import { type Catalog, listStatuses, listTags, listTypes } from "../catalog/model.js";
import {
  CatalogOutputSchema,
  CitationsOutputSchema,
  citationsText,
  type PageOutput,
  PageOutputSchema,
  ProvenanceOutputSchema,
  projectCatalog,
  projectCitations,
  projectPage,
  projectReserved,
  projectSearch,
  projectStatus,
  projectWalk,
  refusingText,
  SearchOutputSchema,
  StatusOutputSchema,
  statusSummary,
  walkText,
} from "../catalog/outputs.js";
import { type Found, resolvePageName } from "../catalog/resolve.js";
import type { Generation, Runtime, ToolOptions } from "../catalog/runtime.js";
import { cutEscaped, DATA_SENTENCE, safe } from "../catalog/text.js";
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

/** The most entries an error line lists before it gives the total. */
const LIST_CAP = 50;
/** The most characters of one listed value, its escapes counted, before it is cut with an ellipsis. */
const VALUE_CAP = 200;
/** The most tags a search may ask for; each is a word or two, at most as long as a type. */
const TAG_LIST_CAP = 8;

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

/**
 * The folders for an error line, listed as the values in use are: each JSON-quoted and cut at 200 characters, so a
 * comma stays inside one name and a long name cannot fill the error; the root by its label; the first 50, then the
 * total (the fix pass's verification).
 */
function folderList(catalog: Catalog): string {
  const names = [...catalog.folders.keys()].sort(byCodeUnit);
  const shown = names
    .slice(0, LIST_CAP)
    .map((f) => (f === "" ? "(root)" : listedValue(f)))
    .join(", ");
  return names.length > LIST_CAP ? `${shown} … (${names.length} folders)` : shown;
}

/**
 * One value in use, as stored: neither trimmed nor collapsed, so a padded tag shows its spaces and a comma stays
 * inside one value; its unsafe characters escaped, cut at 200 characters with an ellipsis after the quote, then
 * JSON-quoted (build review A-A3, A-A6). The cut counts escapes, so no value prints more than about 400 characters.
 */
function listedValue(value: string): string {
  const { kept, cut } = cutEscaped(value, VALUE_CAP);
  return `${JSON.stringify(kept)}${cut ? "…" : ""}`;
}

/** Values in use for an error line: each listed as stored and quoted, the first 50, then the total when there are more. */
function valueList(values: readonly string[], noun: string): string {
  const shown = values.slice(0, LIST_CAP).map(listedValue).join(", ");
  if (values.length > LIST_CAP) return `${shown} … (${values.length} ${noun})`;
  return shown || "(none)";
}

function refused(generation: Generation): ToolResult | undefined {
  const fatal = generation.report.fatal;
  if (fatal === undefined) return undefined;
  return fail(
    `the bundle was refused and nothing is served: ${safe(fatal.rule)}${fatal.path ? ` (${safe(fatal.path)})` : ""}: ${safe(fatal.detail)}`,
  );
}

function pageText(output: PageOutput): string {
  const tail =
    output.truncated && output.nextOffset !== undefined
      ? `\n[truncated at the result budget; continue with offset ${output.nextOffset}]`
      : "";
  return `${output.citation}\n${output.notice}\n${output.body}${tail}`;
}

const describeType = (text: string): string => `${text} ${DATA_SENTENCE}`;

/** The input every name-taking tool shares: the path, or the concept id, `get_page` takes. */
const PAGE_NAME = z
  .string()
  .min(1)
  .max(1024)
  .describe(
    "The page's path in the bundle, as a search result or a catalog lists it, or its concept id (the path without .md). An exact path is ambiguous when a sibling page X.md.md exists, X.md being that page's concept id too; the error then names each page, with a name that means it alone where there is one.",
  );

/**
 * A page name resolved as `get_page` resolves it (D60), with `get_page`'s errors word for word: the file found, or
 * the error to answer with. One resolver serves `get_page`, `citations` and `provenance`.
 */
function resolveName(generation: Generation, value: string): Found | ToolResult {
  const resolution = resolvePageName(
    [{ bundle: generation.catalog.company, catalog: generation.catalog }],
    value,
  );
  if (resolution.ok) return resolution.found;
  switch (resolution.reason) {
    case "ambiguous":
      return fail(
        `${JSON.stringify(safe(resolution.name))} names more than one page: ${resolution.candidates
          .map(
            (c) =>
              `${safe(c.path)} (${c.ask === undefined ? "no name reaches it alone" : `ask for ${JSON.stringify(safe(c.ask))}`})`,
          )
          .join(", ")}`,
      );
    case "not-found":
      return fail(
        `no page at ${JSON.stringify(safe(resolution.name))}; the nearest served paths are: ${resolution.nearest.map(safe).join(", ") || "(none)"}`,
      );
    case "unknown-bundle":
    case "refused-bundle":
      // Unreachable while no tool takes a bundle argument (issue 3 adds it): the resolver is handed one bundle.
      return fail(`the bundle ${JSON.stringify(safe(resolution.bundle))} is not served`);
  }
}

/** Whether a value is an answer to send back as it is, rather than what was asked for. */
const isAnswer = (value: object): value is ToolResult => "content" in value;

/** The admitted page a graph tool answers for, or the error: a reserved file is served by get_page but is no page. */
function resolveGraphPage(generation: Generation, value: string): Page | ToolResult {
  const found = resolveName(generation, value);
  if (isAnswer(found)) return found;
  if (found.kind === "page") return found.page;
  return fail(
    `${JSON.stringify(safe(found.path))} is a reserved ${found.file.kind} file, not a page: citations and provenance answer for pages`,
  );
}

/** The one sentence every tool answers with while the server cannot serve: the fix, never a path the model has no business with. */
const refusingSentence = (refusing: string): string =>
  `the server is refusing every request until its configuration is fixed: ${refusingText(refusing)}`;

/**
 * The six tools. Every handler runs under a lease on the current generation, answers in both channels, and
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
        'Finds pages by keywords. Write one concept per word; common words are dropped, and when no page holds every word the match is relaxed and the result says so. Optional filters, applied to what the index returns: type, topic, tag (one tag, or a list a page must carry all of), status, min_trust (that tier or a higher one) and freshness. tag, status, min_trust and freshness are never added to the keywords; type and topic also add their words to the first query. With freshness and include_stale both omitted, pages past their recheck date are included and each says it is overdue; freshness "fresh" leaves them out, and include_stale is the older name for the same choice (true is "any", false is "fresh"). Each hit carries its path, type, status, trust tier, recheck date, source count, resource and a quoted snippet.',
      ),
      inputSchema: z.strictObject({
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
        tag: z
          .union([z.string().max(200), z.array(z.string().max(200)).max(TAG_LIST_CAP)])
          .optional()
          .describe(
            "Only pages carrying this tag, or every tag of a list of up to 8; case does not matter, and a miss lists the tags in use.",
          ),
        status: z
          .string()
          .max(200)
          .optional()
          .describe(
            "Only pages served with this status (case does not matter): stable, deprecated, or a word the company admits.",
          ),
        min_trust: z
          .enum(["unverified", "machine-confirmed", "human-reviewed"])
          .optional()
          .describe("Only pages of this trust tier or a higher one."),
        freshness: z
          .enum(["fresh", "any"])
          .optional()
          .describe(
            '"any" includes pages past their recheck date, each flagged overdue, which is what omitting it does; "fresh" leaves them out.',
          ),
        include_stale: z
          .boolean()
          .optional()
          .describe(
            'The older name for freshness, accepted until 0.5.0: true is "any", false is "fresh".',
          ),
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
            `no page has the type ${JSON.stringify(safe(wantedType))}; the types in use are: ${valueList(types, "types")}`,
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
      // Tags: each entry trimmed, blank entries dropped; an empty list is no filter. Each must be in use (issue 4).
      const requested = typeof args.tag === "string" ? [args.tag] : (args.tag ?? []);
      const tags = requested.map((tag) => tag.trim()).filter((tag) => tag.length > 0);
      if (tags.length > 0) {
        const inUse = listTags(generation.catalog);
        const known = new Set(inUse.map((tag) => tag.toLowerCase()));
        const missing = tags.find((tag) => !known.has(tag.toLowerCase()));
        if (missing !== undefined) {
          return fail(
            `no page has the tag ${JSON.stringify(safe(missing))}; the tags in use are: ${valueList(inUse, "tags")}`,
          );
        }
      }
      const status = blank(args.status);
      if (status !== undefined) {
        const inUse = listStatuses(generation.catalog);
        if (!inUse.some((served) => served.toLowerCase() === status.toLowerCase())) {
          return fail(
            `no page has the status ${JSON.stringify(safe(status))}; the statuses in use are: ${valueList(inUse, "statuses")}`,
          );
        }
      }
      // The freshness pair (issue 4, D65): both omitted includes overdue pages; the two contradictions are refused.
      const freshness = args.freshness;
      const alias = args.include_stale;
      if ((freshness === "any" && alias === false) || (freshness === "fresh" && alias === true)) {
        return fail(
          `freshness and include_stale disagree: freshness "${freshness}" ${freshness === "any" ? "includes" : "leaves out"} pages past their recheck date and include_stale ${alias} ${alias ? "includes them" : "leaves them out"}; pass freshness alone`,
        );
      }
      const includeStale = freshness !== undefined ? freshness === "any" : (alias ?? true);
      const now = clock();
      const response = await search(
        generation.catalog,
        engine,
        {
          question: args.question,
          ...(type === undefined ? {} : { type }),
          ...(topic === undefined ? {} : { topic }),
          ...(tags.length === 0 ? {} : { tags }),
          ...(status === undefined ? {} : { status }),
          ...(args.min_trust === undefined ? {} : { minTrust: args.min_trust }),
          includeStale,
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
        "Returns one page whole, with its provenance header first: path, type, status, trust tier, verifier, recheck date and deprecation. Takes the path, or the concept id (the path without .md); a name that is one page's path and another's concept id is an error naming both. Reserved files (index.md, log.md) are served too. A long page is cut at the result budget and says where to continue.",
      ),
      inputSchema: z.strictObject({
        path: PAGE_NAME,
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
      const offset = args.offset ?? 0;
      const found = resolveName(generation, args.path);
      if (isAnswer(found)) return found;
      const output =
        found.kind === "page"
          ? projectPage(found.page, clock(), offset, options.resultBudget, {
              undeclaredTypes: new Set(generation.report.unknownTypes),
            })
          : projectReserved(found.file, found.source, offset, options.resultBudget);
      return ok(pageText(output), output);
    }),
  );

  server.registerTool(
    "citations",
    {
      title: "What a page cites, and what cites it",
      description: describeType(
        "Answers what a page cites and what cites it, from what the bundle states; nothing is fetched. Six lists: mentions (the page's body links, each with its text, its nearest heading and what it points at; a link to a page that is not served says unserved), inbound mentions (body links on other pages that point here), claims (each footnote reference joined to its source by id, with the sentence that carries it and the source's author, usage count, last change and usage window), bibliography (the sources no footnote cites), unjoined footnotes (footnotes with no source) and inbound derivations (pages whose resource or sources name this one). Takes the path or the concept id get_page takes. Each list carries at most 50 rows with its total, and each value at most 2 000 characters; a result over the budget gives each list a share of it, keeps each list's first rows within its share, and says truncated.",
      ),
      inputSchema: z.strictObject({ path: PAGE_NAME }),
      outputSchema: CitationsOutputSchema,
      annotations: { readOnlyHint: true },
    },
    guarded("citations", (args, generation) => {
      const stop = refused(generation);
      if (stop !== undefined) return stop;
      const page = resolveGraphPage(generation, args.path);
      if (isAnswer(page)) return page;
      const output = projectCitations(citationsOf(generation.catalog, page), options.resultBudget);
      return ok(citationsText(output), output);
    }),
  );

  server.registerTool(
    "provenance",
    {
      title: "Where a page's sources lead",
      description: describeType(
        "Walks where a page's sources lead inside the bundle, without fetching, opening or running anything. Lists the page's resource, its sources and its contract fields (computation, executor, attester), each classified as a URL, a page, a reserved file, an attachment, a folder, a scope, ambiguous, unserved, or nothing in the bundle. A resource or source that names a page enters it and lists that page's sources in turn, breadth first, each page once, to the depth asked (0 to 8, 4 when omitted; at most 200 pages entered); a contract field is never entered. Each page carries its trust tier and recheck date, and each source its author, usage count, last change and usage window; a page lists at most 50 sources with their total. A result over the budget is cut in walk order and says truncated: ask for a smaller depth, or start from a page further down.",
      ),
      inputSchema: z.strictObject({
        path: PAGE_NAME,
        depth: z
          .number()
          .int()
          .min(0)
          .max(MAX_DEPTH)
          .optional()
          .describe(
            "How many pages deep to follow sources, 0 to 8; 4 when omitted. 0 lists the page's own edges and enters nothing.",
          ),
      }),
      outputSchema: ProvenanceOutputSchema,
      annotations: { readOnlyHint: true },
    },
    guarded("provenance", (args, generation) => {
      const stop = refused(generation);
      if (stop !== undefined) return stop;
      const page = resolveGraphPage(generation, args.path);
      if (isAnswer(page)) return page;
      const walk = walkProvenance(generation.catalog, page, args.depth ?? DEFAULT_DEPTH, clock());
      const output = projectWalk(walk, options.resultBudget);
      return ok(walkText(output), output);
    }),
  );

  server.registerTool(
    "catalog",
    {
      title: "List a folder of the bundle",
      description: describeType(
        "Returns a folder's index: its pages with their titles and descriptions, and the folder's index text as the company wrote it or as the server generated it. Start here, at the root, to see what exists.",
      ),
      inputSchema: z.strictObject({
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
      inputSchema: z.strictObject({}),
      outputSchema: StatusOutputSchema,
      annotations: { readOnlyHint: true },
    },
    guarded("status", (_args, generation) => {
      const output = projectStatus(generation, runtime.status(), options, clock());
      return ok(statusSummary(output), output);
    }),
  );
}
