import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import type { Page, Refusal } from "../bundle/model.js";
import { byCodeUnit } from "../bundle/paths.js";
import { citationsOf, DEFAULT_DEPTH, MAX_DEPTH, walkProvenance } from "../catalog/graph.js";
import { type Catalog, listStatuses, listTags, listTypes } from "../catalog/model.js";
import {
  CatalogToolOutputSchema,
  CitationsOutputSchema,
  citationsText,
  type PageOutput,
  PageOutputSchema,
  ProvenanceOutputSchema,
  projectCatalog,
  projectCitations,
  projectNetworkCatalog,
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
import { type BundleView, type Found, resolvePageName } from "../catalog/resolve.js";
import type {
  Generation,
  Network,
  Runtime,
  ServedBundle,
  ToolOptions,
} from "../catalog/runtime.js";
import { cutEscaped, DATA_SENTENCE, located, printed, safe } from "../catalog/text.js";
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
 * total (the fix pass's verification). Beyond one bundle, the folders of every bundle searched, each name once.
 */
function folderList(catalogs: readonly Catalog[]): string {
  const names = [...new Set(catalogs.flatMap((catalog) => [...catalog.folders.keys()]))].sort(
    byCodeUnit,
  );
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

/** Every distinct value of every catalog, sorted as one catalog's are. */
const unionOf = (catalogs: readonly Catalog[], of: (catalog: Catalog) => string[]): string[] =>
  [...new Set(catalogs.flatMap(of))].sort();

/** A bundle-level refusal as the tools print it: the rule, the path when there is one, the detail. */
const refusalText = (fatal: Refusal): string =>
  `${safe(fatal.rule)}${fatal.path ? ` (${printed(fatal.path, "path")})` : ""}: ${safe(fatal.detail)}`;

/** The network as one call reads it (D72, D74): every bundle for the resolver, the served ones, the refused ones. */
interface Seen {
  network: Network;
  views: BundleView[];
  served: ServedBundle[];
  refused: ServedBundle[];
  /** More than one bundle: lines name each page's bundle, and the shapes beyond one bundle apply (D74). */
  prefixed: boolean;
}

function see(network: Network): Seen {
  const served = network.bundles.filter((bundle) => bundle.generation.report.fatal === undefined);
  return {
    network,
    views: network.bundles.map((bundle) => ({
      bundle: bundle.id,
      catalog: bundle.generation.catalog,
      ...(bundle.generation.report.fatal === undefined
        ? {}
        : { fatal: bundle.generation.report.fatal }),
    })),
    served,
    refused: network.bundles.filter((bundle) => bundle.generation.report.fatal !== undefined),
    prefixed: network.bundles.length > 1,
  };
}

/**
 * The answer while no bundle is served: one bundle's refusal as version 0 gave it, or, beyond one, each bundle's
 * reason (refused, its first load failed, its index broken, or still loading). Tools refuse only when no bundle is
 * served (D75); `status` never does.
 */
function refused(seen: Seen): ToolResult | undefined {
  if (seen.served.length > 0) return undefined;
  const [only] = seen.network.bundles;
  if (only !== undefined && seen.network.bundles.length === 1) {
    const fatal = only.generation.report.fatal as Refusal;
    return fail(`the bundle was refused and nothing is served: ${refusalText(fatal)}`);
  }
  return fail(
    `no bundle of the network is served: ${seen.refused
      .map((bundle) => `${bundle.id}: ${refusalText(bundle.generation.report.fatal as Refusal)}`)
      .join("; ")}`,
  );
}

/** A bundle the caller named that the network does not hold, or holds refused; the bundle itself otherwise. */
function namedBundle(seen: Seen, bundle: string): ServedBundle | ToolResult {
  const found = seen.network.bundles.find((candidate) => candidate.id === bundle);
  if (found === undefined) return unknownBundle(seen, bundle);
  const fatal = found.generation.report.fatal;
  if (fatal !== undefined) return refusedBundle(found.id, fatal);
  return found;
}

const unknownBundle = (seen: Seen, bundle: string): ToolResult =>
  fail(
    `there is no bundle ${JSON.stringify(safe(bundle))}; the bundles are: ${seen.network.bundles.map((b) => b.id).join(", ")}`,
  );

/** A named bundle that serves nothing: still loading (the first-load deadline, D75), or refused and why. */
const refusedBundle = (bundle: string, fatal: Refusal): ToolResult =>
  fatal.rule === "loading"
    ? fail(
        `the bundle ${bundle} is still loading, and nothing in it is served yet; ask again shortly`,
      )
    : fail(`the bundle ${bundle} was refused and nothing in it is served: ${refusalText(fatal)}`);

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
    "The page's path in its bundle, as a search result or a catalog lists it, or its concept id (the path without .md); a name as a result prints it is taken too, bundle:path, with the path in quotes when the line quotes it. A name is ambiguous when two bundles serve it, or, in one bundle, when a sibling page X.md.md exists, X.md being that page's concept id too; the error then names each page, with its bundle when the server serves more than one, and a name that means it alone in its bundle where there is one, to ask for with that bundle.",
  );

/** A bundle id as a caller writes it: never blank, which would read as every bundle (C-A-A7). */
const bundleId = () =>
  z.string().min(1).max(200).regex(/\S/, "a bundle cannot be blank: name one, or leave bundle out");

/** The bundle a name-taking tool reads alone: the id a hit, a catalog or an ambiguity error names (D74). */
const BUNDLE = bundleId()
  .optional()
  .describe(
    "The bundle to read, as a search hit or catalog names it (before the colon of a printed name); needed when two bundles serve the name. Omit it to look in every bundle; a blank one is refused.",
  );

/** A line's bundle beyond one bundle (D74), none for a network of one. */
const lineBundle = (seen: Seen, bundle: string): { bundle?: string } =>
  seen.prefixed ? { bundle } : {};

/**
 * A page name resolved as `get_page` resolves it (D60, D74), with `get_page`'s errors word for word: the file found,
 * or the error to answer with. One resolver serves `get_page`, `citations` and `provenance`. A network of one bundle
 * answers with version 0's sentences; beyond one, each page is named with its bundle and each name to ask for with
 * the bundle to ask in, since a name is unique only inside its own bundle.
 */
function resolveName(seen: Seen, value: string, bundle: string | undefined): Found | ToolResult {
  const resolution = resolvePageName(seen.views, value, bundle);
  if (resolution.ok) return resolution.found;
  switch (resolution.reason) {
    case "ambiguous":
      return fail(
        `${JSON.stringify(safe(resolution.name))} names more than one page: ${resolution.candidates
          .map((c) => {
            const where = seen.prefixed ? ` with bundle ${JSON.stringify(c.bundle)}` : "";
            const ask =
              c.ask === undefined
                ? `no name reaches it alone${seen.prefixed ? ` in bundle ${c.bundle}` : ""}`
                : `ask for ${JSON.stringify(safe(c.ask))}${where}`;
            return `${located(c.path, lineBundle(seen, c.bundle).bundle)} (${ask})`;
          })
          .join(", ")}`,
      );
    case "not-found": {
      const read = resolution.bundle ?? bundle;
      const inBundle = seen.prefixed && read !== undefined ? ` in bundle ${read}` : "";
      return fail(
        `no page at ${JSON.stringify(safe(resolution.name))}${inBundle}; the nearest served paths are: ${
          resolution.nearest
            .map((near) => located(near.path, lineBundle(seen, near.bundle).bundle))
            .join(", ") || "(none)"
        }`,
      );
    }
    case "unknown-bundle":
      return unknownBundle(seen, resolution.bundle);
    case "refused-bundle":
      return refusedBundle(resolution.bundle, resolution.fatal);
  }
}

/** Whether a value is an answer to send back as it is, rather than what was asked for. */
const isAnswer = (value: object): value is ToolResult => "content" in value;

/** The generation of the bundle a name resolved in. */
const generationIn = (seen: Seen, bundle: string): Generation =>
  (seen.network.bundles.find((candidate) => candidate.id === bundle) as ServedBundle).generation;

/** The admitted page a graph tool answers for, and its bundle, or the error: a reserved file is served by get_page but is no page. */
function resolveGraphPage(
  seen: Seen,
  value: string,
  bundle: string | undefined,
): { bundle: string; page: Page } | ToolResult {
  const found = resolveName(seen, value, bundle);
  if (isAnswer(found)) return found;
  if (found.kind === "page") return { bundle: found.bundle, page: found.page };
  return fail(
    `${JSON.stringify(safe(found.path))} is a reserved ${found.file.kind} file, not a page: citations and provenance answer for pages`,
  );
}

/** The one sentence every tool answers with while the server cannot serve: the fix, never a path the model has no business with. */
const refusingSentence = (refusing: string): string =>
  `the server is refusing every request until its configuration is fixed: ${refusingText(refusing)}`;

/**
 * The six tools. Every handler runs under a lease on the network, answers in both channels, and turns anything it
 * cannot repair into a fixed sentence; the detail goes to the log, never to the model.
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
      fn: (args: A, seen: Seen, engine: Engine) => Promise<ToolResult> | ToolResult,
      /** The answer while the network refuses, when the tool has one of its own (`status` beyond one bundle). */
      whileRefusing?: (args: A) => ToolResult | undefined,
    ) =>
    async (args: A): Promise<ToolResult> => {
      const started = performance.now();
      const refusing = runtime.status().refusing;
      if (refusing !== undefined) return whileRefusing?.(args) ?? fail(refusingSentence(refusing));
      try {
        const { logFields, ...result } = await runtime.lease<ToolResult>(async (network, engine) =>
          fn(args, see(network), engine),
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
        if (refusingNow !== undefined)
          return whileRefusing?.(args) ?? fail(refusingSentence(refusingNow));
        return fail("the server hit a defect answering this call; its log has the detail");
      }
    };

  server.registerTool(
    "search",
    {
      title: "Search the knowledge bundles",
      description: describeType(
        'Finds pages by keywords, in every bundle the server serves. Write one concept per word; common words are dropped, and when no page holds every word the match is relaxed and the result says so. Optional filters, applied to what the index returns: type, topic (a folder, matched inside each bundle), tag (one tag, or a list a page must carry all of), status, min_trust (that tier or a higher one) and freshness. tag, status, min_trust and freshness are never added to the keywords; type and topic also add their words to the first query. With freshness and include_stale both omitted, pages past their recheck date are included and each says it is overdue; freshness "fresh" leaves them out, and include_stale is the older name for the same choice (true is "any", false is "fresh"). Each hit carries its bundle, path, concept id, type, status, trust tier, recheck date, source count, resource and a quoted snippet; when the server serves more than one bundle, each line names the bundle before the path.',
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
          .describe("Only pages under this folder, the folder's path inside its bundle."),
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
    guarded("search", async (args, seen, engine) => {
      const stop = refused(seen);
      if (stop !== undefined) return stop;
      const catalogs = seen.served.map((bundle) => bundle.generation.catalog);
      const wantedType = blank(args.type);
      let type: string | undefined;
      if (wantedType !== undefined) {
        const types = unionOf(catalogs, listTypes);
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
        if (topic.length > 0 && !catalogs.some((catalog) => catalog.folders.has(topic as string))) {
          return fail(
            `there is no folder ${JSON.stringify(safe(topic))}; the folders are: ${folderList(catalogs)}`,
          );
        }
        if (topic.length === 0) topic = undefined;
      }
      // Tags: each entry trimmed, blank entries dropped; an empty list is no filter. Each must be in use (issue 4).
      const requested = typeof args.tag === "string" ? [args.tag] : (args.tag ?? []);
      const tags = requested.map((tag) => tag.trim()).filter((tag) => tag.length > 0);
      if (tags.length > 0) {
        const inUse = unionOf(catalogs, listTags);
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
        const inUse = unionOf(catalogs, listStatuses);
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
      const searched = new Map(
        seen.served.map((bundle) => [bundle.id, bundle.generation.catalog] as const),
      );
      const response = await search(
        searched,
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
      const devBundles = seen.served
        .filter((bundle) => bundle.generation.dev)
        .map((bundle) => bundle.id);
      const output = projectSearch(response, searched, now, {
        dev: seen.prefixed ? devBundles : devBundles.length > 0,
        undeclaredTypes: new Map(
          seen.served.map((bundle) => [bundle.id, new Set(bundle.generation.report.unknownTypes)]),
        ),
        prefixed: seen.prefixed,
        notSearched: seen.refused.map((bundle) => ({
          bundle: bundle.id,
          reason: bundle.generation.report.fatal?.rule ?? "refused",
        })),
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
        "Returns one page whole, with its provenance header first: path, type, status, trust tier, verifier, recheck date and deprecation. Takes the path, or the concept id (the path without .md), and the bundle when more than one bundle serves the name: a name two bundles serve, or that is one page's path and another's concept id, is an error naming each page (with its bundle when the server serves more than one) and a name to ask for with that bundle. Reserved files (index.md, log.md) are served too. A long page is cut at the result budget and says where to continue.",
      ),
      inputSchema: z.strictObject({
        path: PAGE_NAME,
        bundle: BUNDLE,
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
    guarded("get_page", (args, seen) => {
      const stop = refused(seen);
      if (stop !== undefined) return stop;
      const offset = args.offset ?? 0;
      const found = resolveName(seen, args.path, blank(args.bundle));
      if (isAnswer(found)) return found;
      const where = { bundle: found.bundle, prefixed: seen.prefixed };
      const output =
        found.kind === "page"
          ? projectPage(found.page, clock(), offset, options.resultBudget, {
              undeclaredTypes: new Set(generationIn(seen, found.bundle).report.unknownTypes),
              located: where,
            })
          : projectReserved(found.file, found.source, offset, options.resultBudget, where);
      return ok(pageText(output), output);
    }),
  );

  server.registerTool(
    "citations",
    {
      title: "What a page cites, and what cites it",
      description: describeType(
        "Answers what a page cites and what cites it, from what its bundle states; nothing is fetched, and no bundle points into another. Six lists: mentions (the page's body links, each with its text, its nearest heading and what it points at; a link to a page that is not served says unserved), inbound mentions (the body links that point here, the page's links to itself included, each with its page's status), claims (each footnote reference joined to the sources whose id it matches, case ignored, the first 50 with their total, with the sentence that carries it and each source's author, usage count, last change and usage window), bibliography (the sources no footnote cites), unjoined footnotes (footnotes with no source) and inbound derivations (pages whose resource or sources name this one, each with its status). A footnote reference counts only when its definition exists, as GFM reads it, and one written inside a footnote's definition is no claim. Takes the path or the concept id, and the bundle, as get_page does. Each list carries at most 50 rows with its total, and each value at most 2 000 characters; a result over the budget gives each list a share of it, keeps each list's first rows within its share, and says truncated.",
      ),
      inputSchema: z.strictObject({ path: PAGE_NAME, bundle: BUNDLE }),
      outputSchema: CitationsOutputSchema,
      annotations: { readOnlyHint: true },
    },
    guarded("citations", (args, seen) => {
      const stop = refused(seen);
      if (stop !== undefined) return stop;
      const target = resolveGraphPage(seen, args.path, blank(args.bundle));
      if (isAnswer(target)) return target;
      const output = projectCitations(
        citationsOf(generationIn(seen, target.bundle).catalog, target.page),
        options.resultBudget,
        { bundle: target.bundle, prefixed: seen.prefixed },
      );
      return ok(citationsText(output), output);
    }),
  );

  server.registerTool(
    "provenance",
    {
      title: "Where a page's sources lead",
      description: describeType(
        "Walks where a page's sources lead inside its bundle, without fetching, opening or running anything. Lists the page's resource, its sources and its contract fields (computation, executor, attester), each classified as a URL, a page, a reserved file, an attachment, a folder, a scope, ambiguous, unserved, or nothing in the bundle. A resource or source that names a page enters it and lists that page's sources in turn, breadth first, each page once, to the depth asked (0 to 8, 4 when omitted; at most 200 pages entered); a contract field is never entered. Each page carries its status, trust tier and recheck date, and each source its author, usage count, last change and usage window; a page lists at most 50 sources with their total, and a source with whitespace in its value is a scope, not a path. Takes the path or the concept id, and the bundle, as get_page does. A result over the budget is cut in walk order and says truncated: ask for a smaller depth, or start from a page further down.",
      ),
      inputSchema: z.strictObject({
        path: PAGE_NAME,
        bundle: BUNDLE,
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
    guarded("provenance", (args, seen) => {
      const stop = refused(seen);
      if (stop !== undefined) return stop;
      const target = resolveGraphPage(seen, args.path, blank(args.bundle));
      if (isAnswer(target)) return target;
      const walk = walkProvenance(
        generationIn(seen, target.bundle).catalog,
        target.page,
        args.depth ?? DEFAULT_DEPTH,
        clock(),
      );
      const output = projectWalk(walk, options.resultBudget, {
        bundle: target.bundle,
        prefixed: seen.prefixed,
      });
      return ok(walkText(output), output);
    }),
  );

  server.registerTool(
    "catalog",
    {
      title: "List a folder of a bundle, or the bundles",
      description: describeType(
        "Returns a folder's index: its pages with their titles and descriptions, and the folder's index text as the company wrote it or as the server generated it. Start here, at the root, to see what exists. When the server serves more than one bundle, catalog without a bundle lists the bundles, each with its page count and its root index (or why it is refused), and catalog with a bundle reads that bundle's folders.",
      ),
      inputSchema: z.strictObject({
        folder: z
          .string()
          .max(1024)
          .optional()
          .describe("A folder of the bundle; omit for the root."),
        bundle: bundleId()
          .optional()
          .describe(
            "The bundle whose folder to list; omit it to list the bundles when the server serves more than one. A blank one is refused.",
          ),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Continue a long index from this character offset."),
      }),
      outputSchema: CatalogToolOutputSchema,
      annotations: { readOnlyHint: true },
    },
    guarded("catalog", (args, seen) => {
      const stop = refused(seen);
      if (stop !== undefined) return stop;
      const wanted = blank(args.bundle);
      // Beyond one bundle, no bundle and the root folder (left out, "" or "/") lists the network's bundles (D74).
      if (wanted === undefined && seen.prefixed && normaliseFolder(args.folder ?? "") === "") {
        const { output, text } = projectNetworkCatalog(
          seen.network,
          options.network,
          options.resultBudget,
        );
        return ok(text, output);
      }
      let target: ServedBundle;
      if (wanted !== undefined) {
        const named = namedBundle(seen, wanted);
        if (isAnswer(named)) return named;
        target = named;
      } else if (!seen.prefixed) target = seen.served[0] as ServedBundle;
      else
        return fail(
          `a folder names a place in one bundle; pass the bundle too (the bundles are: ${seen.network.bundles.map((b) => b.id).join(", ")})`,
        );
      const catalog = target.generation.catalog;
      const folder = normaliseFolder(args.folder ?? "");
      const where = { bundle: target.id, prefixed: seen.prefixed };
      const output = projectCatalog(catalog, folder, args.offset ?? 0, options.resultBudget, where);
      if (output === undefined) {
        return fail(
          `there is no folder ${JSON.stringify(safe(folder))}${seen.prefixed ? ` in bundle ${target.id}` : ""}; the folders are: ${folderList([catalog])}`,
        );
      }
      const tail =
        output.truncated && output.nextOffset !== undefined
          ? `\n[truncated at the result budget; continue with offset ${output.nextOffset}]`
          : "";
      const place = seen.prefixed
        ? folder === ""
          ? `the root of bundle ${target.id}`
          : located(folder, target.id)
        : folder === ""
          ? "the bundle root"
          : printed(folder, "path");
      const head = `catalog of ${place} (${output.source} index, ${output.entries.length} pages)`;
      return ok(`${head}\n${output.notice}\n${output.text}${tail}`, output);
    }),
  );

  server.registerTool(
    "status",
    {
      title: "Report the network's state",
      description: describeType(
        "Reports what was loaded: for one bundle, counts of pages admitted, refused and degraded, the lists the report carries, the integrity mode, the manifest's commit and publish time, the root index's okf_version, the engine's counts and the lock; when the server serves more than one bundle, the network's lock and a row of those facts per bundle, with its source and why it is refused when it is. Nothing in it is page text.",
      ),
      inputSchema: z.strictObject({}),
      outputSchema: StatusOutputSchema,
      annotations: { readOnlyHint: true },
    },
    guarded(
      "status",
      (_args, seen) => {
        const output = projectStatus(seen.network, runtime.status(), options, clock());
        return ok(statusSummary(output), output);
      },
      // Beyond one bundle, status answers while the network refuses: a row per bundle and the network's sentence
      // (C-I-C1); a network of one bundle refuses as version 0 did (D74).
      () => {
        const network = runtime.snapshot();
        if (network.bundles.length < 2) return undefined;
        const output = projectStatus(network, runtime.status(), options, clock());
        return ok(statusSummary(output), output);
      },
    ),
  );
}
