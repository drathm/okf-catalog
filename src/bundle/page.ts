import { decodeUtf8, parseFrontmatter, splitFrontmatter } from "./frontmatter.js";
import { type LinkIndex, resolveLink } from "./links.js";
import { sha256Hex } from "./manifest.js";
import { readBody } from "./markdown.js";
import type {
  BundleFile,
  Contract,
  ContractParameter,
  Degradation,
  DegradationCode,
  Link,
  Page,
  PagePath,
  Refusal,
  RefusalRule,
  Source,
  SpecText,
  StaleAfter,
  Status,
  Timestamp,
  Trust,
  Verification,
} from "./model.js";
import { folderOf } from "./paths.js";
import { parseTimestamp } from "./timestamp.js";

export interface PageContext {
  linkIndex: LinkIndex;
  specText: SpecText;
}

export type ParsePageResult = { ok: true; page: Page } | { ok: false; refusal: Refusal };

const STATUSES: ReadonlySet<string> = new Set<Status>(["draft", "stable", "deprecated"]);

/** Characters kept of a legacy citation item's text, and of its link, as a source's resource or title (D63). */
const CITATION_CAP = 500;

/** A legacy citation item's text or link, cut at the cap with an ellipsis, never inside a surrogate pair. */
function capCitation(text: string): string {
  if (text.length <= CITATION_CAP) return text;
  const code = text.charCodeAt(CITATION_CAP - 1);
  const end = code >= 0xd800 && code <= 0xdbff ? CITATION_CAP - 1 : CITATION_CAP;
  return `${text.slice(0, end)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What a value is, for a sentence: "a list", "a mapping", "a number", "empty". */
function kindOf(value: unknown): string {
  if (value === null || value === undefined) return "empty";
  if (Array.isArray(value)) return "a list";
  if (typeof value === "object") return "a mapping";
  return `a ${typeof value}`;
}

function stemOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/, "");
}

/** The verification with the latest instant; among entries without one, the last listed. */
export function latestVerification(verified: readonly Verification[]): Verification | undefined {
  let best: Verification | undefined;
  let bestAt = Number.NEGATIVE_INFINITY;
  for (const v of verified) {
    const at = v.at?.at?.getTime();
    if (at === undefined) {
      if (best === undefined) best = v;
      continue;
    }
    if (best === undefined || best.at?.at === undefined || at >= bestAt) {
      best = v;
      bestAt = at;
    }
  }
  if (best !== undefined && best.at?.at === undefined) {
    for (const v of verified) if (v.at?.at === undefined) best = v;
  }
  return best;
}

/** Turns one file into a page, deriving every field with its source and a degradation wherever a fallback was used. */
export function parsePage(file: BundleFile, ctx: PageContext): ParsePageResult {
  const path = file.path;
  const degradations: Degradation[] = [];
  const degrade = (code: DegradationCode, field: string, detail: string): void => {
    degradations.push({ path, code, field, detail });
  };
  const refuse = (rule: RefusalRule, detail: string): ParsePageResult => ({
    ok: false,
    refusal: { path, rule, detail },
  });

  const decoded = decodeUtf8(file.bytes);
  if (!decoded.ok) return refuse("not-utf8", "the file is not valid UTF-8");
  const split = splitFrontmatter(decoded.text);
  if (split.block === undefined) {
    return refuse(
      "no-frontmatter",
      split.unclosed === true
        ? "the frontmatter block opened on line 1 is never closed"
        : "no frontmatter block opens the file",
    );
  }
  const parsed = parseFrontmatter(split.block, 1);
  if (!parsed.ok) return refuse("frontmatter-unparseable", parsed.error);
  const { data, sources: scalarText } = parsed;
  for (const warning of parsed.warnings) degrade("frontmatter-warning", "frontmatter", warning);

  /** A top-level value read as text: strings as they are, numbers and booleans by their source text, reported. */
  const text = (key: string): string | undefined => {
    const value = data[key];
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") {
      const asText = scalarText[key] ?? String(value);
      degrade("scalar-coerced", key, `${key} is a ${typeof value}, read as "${asText}"`);
      return asText;
    }
    return undefined;
  };

  if (!Object.hasOwn(data, "type")) return refuse("no-type", "the frontmatter has no type");
  const type = text("type")?.trim();
  if (type === undefined) return refuse("no-type", `type is ${kindOf(data.type)}, not text`);
  if (type.length === 0) return refuse("no-type", "type is empty");

  const facts = readBody(split.body);
  if (facts.unanalysed) {
    degrade(
      "body-unanalysed",
      "body",
      "the body nests deeper than the analyser allows; no title, description or links were taken from it",
    );
  }
  if (facts.truncated)
    degrade("body-truncated", "body", "only the first 256 KiB of the body were analysed");

  let title = text("title")?.trim();
  let titleSource: Page["titleSource"] = "frontmatter";
  if (Object.hasOwn(data, "title") && title === undefined) {
    degrade("field-ignored", "title", `title is ${kindOf(data.title)}, not text; ignored`);
  }
  if (title === undefined || title.length === 0) {
    if (facts.firstHeading !== undefined && facts.firstHeading.length > 0) {
      title = facts.firstHeading;
      titleSource = "heading";
      degrade(
        "title-from-heading",
        "title",
        `no title field; the first heading "${title}" is used`,
      );
    } else {
      title = stemOf(path);
      titleSource = "filename";
      degrade(
        "title-from-filename",
        "title",
        `no title field and no heading; the file name "${title}" is used`,
      );
    }
  }

  let description = text("description")?.trim();
  let descriptionSource: Page["descriptionSource"] = "frontmatter";
  if (Object.hasOwn(data, "description") && description === undefined) {
    degrade(
      "field-ignored",
      "description",
      `description is ${kindOf(data.description)}, not text; ignored`,
    );
  }
  if (description === undefined || description.length === 0) {
    if (facts.firstSentence !== undefined) {
      description = facts.firstSentence;
      descriptionSource = "body";
      degrade(
        "description-from-body",
        "description",
        "no description field; the body's first sentence is used",
      );
    } else {
      description = undefined;
      descriptionSource = "none";
      degrade(
        "description-missing",
        "description",
        "no description field and no body text to take one from",
      );
    }
  }

  const tags: string[] = [];
  const rawTags = data.tags;
  if (Array.isArray(rawTags)) {
    rawTags.forEach((tag, i) => {
      if (typeof tag === "string") tags.push(tag);
      else if (typeof tag === "number" || typeof tag === "boolean") tags.push(String(tag));
      else degrade("field-ignored", "tags", `tags[${i}] is ${kindOf(tag)}, not text; ignored`);
    });
  } else if (typeof rawTags === "string") {
    tags.push(rawTags);
    degrade("tags-not-list", "tags", "tags is a single string, read as one tag");
  } else if (rawTags !== undefined && rawTags !== null) {
    degrade("tags-not-list", "tags", `tags is ${kindOf(rawTags)}, not a list; ignored`);
  }

  const statusResult = normaliseStatus(
    data.status,
    Object.hasOwn(data, "status"),
    scalarText.status,
    degrade,
  );

  let staleAfter: StaleAfter | undefined;
  if (
    Object.hasOwn(data, "stale_after") &&
    data.stale_after !== null &&
    data.stale_after !== undefined
  ) {
    const raw = text("stale_after") ?? JSON.stringify(data.stale_after);
    const ts = parseTimestamp(raw);
    const expected = ctx.specText === "2026-08-15" ? "date" : "datetime";
    if (ts.kind === "date") staleAfter = { raw, form: "date", at: ts.at };
    else if (ts.kind === "datetime") {
      staleAfter = { raw, form: "datetime", at: ts.at };
      if (!ts.offset)
        degrade("stale-after-no-offset", "stale_after", `${raw} has no offset and is read as UTC`);
    } else {
      staleAfter = { raw, form: "unparseable" };
      degrade(
        "stale-after-unparseable",
        "stale_after",
        `${raw} is not a date or a datetime; the page is never overdue`,
      );
    }
    if (staleAfter.form !== "unparseable" && staleAfter.form !== expected) {
      degrade(
        "stale-after-unexpected-form",
        "stale_after",
        `the ${ctx.specText} text expects a ${expected}; ${raw} is a ${staleAfter.form}`,
      );
    }
  }

  /** A key written with no value is absent, as for every optional field. */
  const absent = (key: string): boolean => data[key] === undefined || data[key] === null;

  const timestamp = (value: unknown, field: string): Timestamp => {
    const raw = typeof value === "string" ? value : JSON.stringify(value);
    const ts = parseTimestamp(raw);
    if (ts.kind === "invalid") {
      degrade("timestamp-invalid", field, `${raw} is not a date or a datetime`);
      return { raw };
    }
    return { raw, at: ts.at };
  };

  let generated: Page["generated"];
  if (Object.hasOwn(data, "generated")) {
    const g = data.generated;
    if (isRecord(g) && typeof g.by === "string" && g.by.trim().length > 0) {
      generated = { by: g.by.trim() };
      if (Object.hasOwn(g, "at")) generated.at = timestamp(g.at, "generated.at");
    } else {
      degrade(
        "generated-malformed",
        "generated",
        `generated is ${kindOf(g)} without a by actor; ignored`,
      );
    }
  }

  // The OKF 0.1 `timestamp` (§13.1, D79): the page's last change when `generated` is absent, kept as its own field
  // and reported. No generator is made from it, since `generated` needs a `by` (§5.2).
  let legacyTimestamp: Timestamp | undefined;
  if (absent("generated") && !absent("timestamp")) {
    legacyTimestamp = timestamp(data.timestamp, "timestamp");
    degrade(
      "legacy-timestamp",
      "timestamp",
      "the OKF 0.1 timestamp is kept as the page's last change, since generated is absent; no generator is assumed",
    );
  }

  const verified: Verification[] = [];
  if (Object.hasOwn(data, "verified")) {
    const v = data.verified;
    const entries: unknown[] = Array.isArray(v) ? v : isRecord(v) ? [v] : [];
    if (!Array.isArray(v) && !isRecord(v)) {
      degrade(
        "verified-entry-malformed",
        "verified",
        `verified is ${kindOf(v)}, neither a list nor a mapping; ignored`,
      );
    }
    entries.forEach((entry, i) => {
      if (isRecord(entry) && typeof entry.by === "string" && entry.by.trim().length > 0) {
        const verification: Verification = { by: entry.by.trim() };
        if (Object.hasOwn(entry, "at") && entry.at !== null)
          verification.at = timestamp(entry.at, `verified[${i}].at`);
        else
          degrade(
            "verification-without-at",
            "verified",
            `verified[${i}] by ${verification.by} has no at`,
          );
        verified.push(verification);
      } else {
        degrade("verified-entry-malformed", "verified", `verified[${i}] has no by actor; ignored`);
      }
    });
  }
  const trust: Trust =
    verified.length === 0
      ? "unverified"
      : verified.some((v) => v.by.startsWith("human:"))
        ? "human-reviewed"
        : "machine-confirmed";

  const sources: Source[] = [];
  if (Object.hasOwn(data, "sources")) {
    const s = data.sources;
    if (Array.isArray(s)) {
      s.forEach((entry, i) => {
        if (isRecord(entry) && typeof entry.resource === "string" && entry.resource.length > 0) {
          const source: Source = { resource: entry.resource };
          if (typeof entry.id === "string") source.id = entry.id;
          else if (typeof entry.id === "number" || typeof entry.id === "boolean")
            source.id = String(entry.id);
          if (typeof entry.title === "string") source.title = entry.title;
          if (typeof entry.author === "string") source.author = entry.author;
          // A count that is not a finite number is dropped and reported, whatever it is (R4).
          const count = entry.usage_count;
          if (typeof count === "number" && Number.isFinite(count)) source.usageCount = count;
          else if (typeof count === "number")
            degrade(
              "source-malformed",
              "sources",
              `sources[${i}].usage_count is not a finite number; ignored`,
            );
          else if (count !== undefined && count !== null)
            degrade(
              "source-malformed",
              "sources",
              `sources[${i}].usage_count is ${kindOf(count)}, not a number; ignored`,
            );
          if (typeof entry.last_modified === "string") source.lastModified = entry.last_modified;
          // An own window that is not a from-to mapping is reported, and the source then takes no window at all: the
          // page's would frame a count its producer framed otherwise (§5.1, D62).
          const w = entry.usage_window;
          if (isRecord(w) && typeof w.from === "string" && typeof w.to === "string")
            source.usageWindow = { from: w.from, to: w.to };
          else if (w !== undefined && w !== null) {
            source.usageWindowIgnored = true;
            degrade(
              "source-malformed",
              "sources",
              isRecord(w)
                ? `sources[${i}].usage_window lacks a from or a to written as a date; ignored, and the source does not take the page's window`
                : `sources[${i}].usage_window is ${kindOf(w)}, not a mapping of from and to; ignored, and the source does not take the page's window`,
            );
          }
          sources.push(source);
        } else {
          degrade("source-malformed", "sources", `sources[${i}] has no resource; ignored`);
        }
      });
    } else {
      degrade("source-malformed", "sources", `sources is ${kindOf(s)}, not a list; ignored`);
    }
  }
  // The OKF 0.1 `# Citations` list (§13.1, D63): sources only on a page that carries none of the v0.2 fields that
  // replaced it, so a v0.2 page's own list of citations stays body text. One link gives a resource and a title;
  // anything else, a bare URL included (autolinks are not parsed), gives its text as the resource.
  // Each item is body text of any length, so its text and its link are cut at 500 characters, the bound bite b
  // gives a reference block (build review I-E2).
  if (
    absent("generated") &&
    absent("verified") &&
    absent("sources") &&
    facts.citations.length > 0
  ) {
    let cut = 0;
    for (const citation of facts.citations) {
      const long =
        citation.text.length > CITATION_CAP || (citation.url?.length ?? 0) > CITATION_CAP;
      if (long) cut += 1;
      const text = capCitation(citation.text);
      sources.push(
        citation.url === undefined
          ? { resource: text }
          : { resource: capCitation(citation.url), title: text },
      );
    }
    const items = facts.citations.length;
    degrade(
      "legacy-citations",
      "sources",
      `${items} item${items === 1 ? "" : "s"} of an OKF 0.1 # Citations list read as sources, since the page has no generated, verified or sources${cut > 0 ? `; ${cut} cut at ${CITATION_CAP} characters` : ""}`,
    );
  }

  let usageWindow: Page["usageWindow"];
  const w = data.usage_window;
  if (w !== undefined && w !== null) {
    if (isRecord(w) && typeof w.from === "string" && typeof w.to === "string")
      usageWindow = { from: w.from, to: w.to };
    else
      degrade(
        "field-ignored",
        "usage_window",
        isRecord(w)
          ? "usage_window lacks a from or a to written as a date; ignored"
          : `usage_window is ${kindOf(w)}, not a mapping of from and to; ignored`,
      );
  }

  const contract = readContract(data, degrade);

  const resource = text("resource");

  const links: Link[] = facts.links.map((l) => {
    const resolved = resolveLink(l.url, path, ctx.linkIndex);
    const link: Link = { raw: l.url, kind: resolved.kind };
    if (resolved.target !== undefined) link.target = resolved.target;
    return link;
  });

  // GFM lower-cases footnote identifiers; the join with sources[].id is case-insensitive, and each missing id is reported once.
  const sourceIds = new Set(
    sources.map((s) => s.id?.toLowerCase()).filter((id): id is string => id !== undefined),
  );
  const missing = new Set<string>();
  for (const id of facts.footnoteReferences) if (!sourceIds.has(id.toLowerCase())) missing.add(id);
  for (const id of missing)
    degrade("footnote-without-source", "sources", `footnote ${id} has no matching sources entry`);

  if (facts.htmlBlocks > 0 || facts.inlineHtml > 0 || facts.hasScriptLike) {
    const parts: string[] = [];
    if (facts.htmlBlocks > 0)
      parts.push(`${facts.htmlBlocks} HTML block${facts.htmlBlocks === 1 ? "" : "s"}`);
    if (facts.inlineHtml > 0)
      parts.push(`${facts.inlineHtml} inline HTML element${facts.inlineHtml === 1 ? "" : "s"}`);
    if (facts.hasScriptLike) parts.push("including a script-like element");
    degrade(
      "body-html",
      "body",
      `${parts.join(", ")}; indexed as text, never executed, kept out of the description`,
    );
  }

  const page: Page = {
    path,
    folder: folderOf(path),
    hash: sha256Hex(file.bytes),
    type,
    title,
    titleSource,
    descriptionSource,
    tags,
    status: statusResult.status,
    statusSource: statusResult.source,
    verified,
    trust,
    sources,
    links,
    footnoteReferences: facts.footnoteReferences,
    frontmatter: data,
    body: split.body,
    ...(facts.prose === undefined ? {} : { prose: facts.prose }),
    degradations,
  };
  if (description !== undefined) page.description = description;
  if (statusResult.raw !== undefined) page.statusRaw = statusResult.raw;
  if (staleAfter !== undefined) page.staleAfter = staleAfter;
  if (generated !== undefined) page.generated = generated;
  if (legacyTimestamp !== undefined) page.timestamp = legacyTimestamp;
  const latest = latestVerification(verified);
  if (latest !== undefined) page.latestVerification = latest;
  if (usageWindow !== undefined) page.usageWindow = usageWindow;
  if (contract !== undefined) page.contract = contract;
  if (resource !== undefined) page.resource = resource;
  return { ok: true, page };
}

/** A list of names as written: strings kept, numbers and booleans by their text, anything else reported. */
function nameList(
  value: unknown[],
  field: string,
  degrade: (code: DegradationCode, field: string, detail: string) => void,
): string[] {
  const names: string[] = [];
  value.forEach((item, i) => {
    if (typeof item === "string") names.push(item);
    else if (typeof item === "number" || typeof item === "boolean") names.push(String(item));
    else degrade("field-ignored", field, `${field}[${i}] is ${kindOf(item)}, not text; ignored`);
  });
  return names;
}

/**
 * The contract fields of §10.2 on a page of any type (D62). Each is kept as written when it has the shape the text
 * gives it, and otherwise reported `field-ignored` and left out, never refusing the page: `runtime` and
 * `computation` are text, `parameters` a list of `{ name, type, required }`, `executor` a mapping of a `resource`
 * and a `receipt` list, `attester` a mapping of a `resource`. An empty key is absent. Nothing is run or opened.
 */
function readContract(
  data: Record<string, unknown>,
  degrade: (code: DegradationCode, field: string, detail: string) => void,
): Contract | undefined {
  const contract: Contract = {};
  const present = (value: unknown): boolean => value !== undefined && value !== null;
  const ignored = (field: string, value: unknown, wanted: string): void =>
    degrade("field-ignored", field, `${field} is ${kindOf(value)}, not ${wanted}; ignored`);

  for (const key of ["runtime", "computation"] as const) {
    const value = data[key];
    if (!present(value)) continue;
    if (typeof value === "string") contract[key] = value;
    else ignored(key, value, "text");
  }

  const parameters = data.parameters;
  if (present(parameters)) {
    if (!Array.isArray(parameters)) ignored("parameters", parameters, "a list");
    else {
      const kept: ContractParameter[] = [];
      parameters.forEach((entry, i) => {
        if (!isRecord(entry) || typeof entry.name !== "string" || entry.name.trim().length === 0) {
          degrade("field-ignored", "parameters", `parameters[${i}] has no name; ignored`);
          return;
        }
        const parameter: ContractParameter = { name: entry.name };
        if (present(entry.type)) {
          if (typeof entry.type === "string") parameter.type = entry.type;
          else ignored(`parameters[${i}].type`, entry.type, "text");
        }
        if (present(entry.required)) {
          if (typeof entry.required === "boolean") parameter.required = entry.required;
          else ignored(`parameters[${i}].required`, entry.required, "true or false");
        }
        kept.push(parameter);
      });
      contract.parameters = kept;
    }
  }

  const executor = data.executor;
  if (present(executor)) {
    if (!isRecord(executor)) ignored("executor", executor, "a mapping");
    else {
      const kept: NonNullable<Contract["executor"]> = {};
      if (present(executor.resource)) {
        if (typeof executor.resource === "string") kept.resource = executor.resource;
        else ignored("executor.resource", executor.resource, "text");
      }
      if (present(executor.receipt)) {
        if (Array.isArray(executor.receipt))
          kept.receipt = nameList(executor.receipt, "executor.receipt", degrade);
        else ignored("executor.receipt", executor.receipt, "a list");
      }
      if (Object.keys(kept).length > 0) contract.executor = kept;
    }
  }

  const attester = data.attester;
  if (present(attester)) {
    if (!isRecord(attester)) ignored("attester", attester, "a mapping");
    else if (present(attester.resource)) {
      if (typeof attester.resource === "string")
        contract.attester = { resource: attester.resource };
      else ignored("attester.resource", attester.resource, "text");
    }
  }

  return Object.keys(contract).length > 0 ? contract : undefined;
}

/**
 * The page's status (D61). Absent, null or blank is `stable`, as §5.4 says. The three known values are read without
 * regard to case. Any other word is the producer's own and is kept, trimmed, with its case, and reported: it is
 * never rewritten, and admission decides whether it is served (D77). A number or boolean is read as written; a list
 * or mapping is no word, so its JSON text stands in for one and it counts as unknown. `raw` is the value as written.
 */
function normaliseStatus(
  value: unknown,
  present: boolean,
  sourceText: string | undefined,
  degrade: (code: DegradationCode, field: string, detail: string) => void,
): { status: string; source: Page["statusSource"]; raw?: string } {
  if (!present || value === undefined || value === null)
    return { status: "stable", source: "default" };
  const raw =
    typeof value === "string"
      ? value
      : typeof value === "number" || typeof value === "boolean"
        ? (sourceText ?? String(value))
        : JSON.stringify(value);
  const word = raw.trim();
  if (word.length === 0) return { status: "stable", source: "default" };
  const known = word.toLowerCase();
  if (typeof value !== "object" && STATUSES.has(known))
    return { status: known, source: "frontmatter", raw };
  degrade(
    "status-unknown",
    "status",
    typeof value === "object"
      ? `status is ${kindOf(value)}, not draft, stable or deprecated; kept as its text ${word}`
      : `status "${word}" is not draft, stable or deprecated; kept as written`,
  );
  return { status: word, source: "frontmatter", raw };
}

const ARTICLE: Record<string, string> = {
  folder: "a folder",
  reserved: "an index or log file",
  attachment: "an attachment",
};

/**
 * The replacement for a deprecated page: the first body link that is not a same-page anchor decides. It is the
 * replacement when it resolves to an admitted page other than this one; otherwise there is none, and the reason is
 * recorded. Nothing is decided for a page that is not deprecated.
 */
export function decideReplacement(
  page: Page,
  admitted: ReadonlySet<PagePath>,
): { replacement?: PagePath; degradation?: Degradation } {
  if (page.status !== "deprecated") return {};
  const reason = (code: DegradationCode, detail: string) => ({
    degradation: { path: page.path, code, field: "replacement", detail },
  });
  const first = page.links.find((l) => l.kind !== "anchor");
  if (first === undefined)
    return reason(
      "replacement-missing",
      "a deprecated page should link to the page that replaced it; no link was found",
    );
  switch (first.kind) {
    case "external":
      return reason(
        "replacement-external",
        `the first link, ${first.raw}, points outside the bundle`,
      );
    case "broken":
      return reason(
        "replacement-broken",
        `the first link, ${first.raw}, points at nothing in the bundle`,
      );
    case "page": {
      const target = first.target ?? "";
      if (target === page.path)
        return reason("replacement-self", "the first link points at the page itself");
      if (!admitted.has(target))
        return reason(
          "replacement-not-served",
          `the first link points at ${target}, which is not served`,
        );
      return { replacement: target };
    }
    default:
      return reason(
        "replacement-not-a-page",
        `the first link, ${first.raw}, points at ${ARTICLE[first.kind] ?? first.kind}, not a page`,
      );
  }
}
