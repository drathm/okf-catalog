import { createHash } from "node:crypto";
import * as z from "zod/v4";
import type { BundleFile } from "./model.js";
import { isSafeRelativePath } from "./paths.js";

export { isSafeRelativePath };

export const MANIFEST_NAME = "manifest.json";

const PathKey = z.string().refine(isSafeRelativePath, "not a safe bundle-relative path");

export const ManifestSchema = z.strictObject({
  okf_catalog: z.literal(1),
  commit: z
    .string()
    .regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/, "a full commit hash, SHA-1 or SHA-256"),
  published_at: z.iso.datetime({ offset: true }),
  files: z.record(
    PathKey,
    z.strictObject({
      sha256: z.string().regex(/^[0-9a-f]{64}$/, "a sha256 in lower-case hex"),
      bytes: z.number().int().nonnegative(),
    }),
  ),
});

export type Manifest = z.infer<typeof ManifestSchema>;

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function parseManifest(
  bytes: Uint8Array,
): { ok: true; manifest: Manifest } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    return { ok: false, error: `manifest is not JSON: ${(error as Error).message}` };
  }
  if (typeof json === "object" && json !== null && Object.hasOwn(json, "files")) {
    const files = (json as { files: unknown }).files;
    if (typeof files === "object" && files !== null && Object.keys(files).includes("__proto__")) {
      return {
        ok: false,
        error: "manifest invalid at files: a path key named __proto__ is not allowed",
      };
    }
  }
  const result = ManifestSchema.safeParse(json);
  if (!result.success) {
    const first = result.error.issues[0];
    const where = first?.path.map(String).join(".") ?? "";
    return {
      ok: false,
      error: `manifest invalid at ${where || "root"}: ${first?.message ?? "unknown"}`,
    };
  }
  return { ok: true, manifest: result.data };
}

/** Builds the manifest for a set of files, the manifest itself excluded, keys sorted by code unit. */
export function buildManifest(
  files: BundleFile[],
  meta: { commit: string; publishedAt: string },
): Manifest {
  for (const file of files) {
    if (!isSafeRelativePath(file.path))
      throw new Error(`cannot build a manifest for an unsafe path: ${file.path}`);
  }
  const entries = files
    .filter((f) => f.path !== MANIFEST_NAME)
    .map((f) => [f.path, { sha256: sha256Hex(f.bytes), bytes: f.bytes.length }] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    okf_catalog: 1,
    commit: meta.commit,
    published_at: meta.publishedAt,
    files: Object.fromEntries(entries),
  };
}

export type ManifestProblem = {
  path: string;
  problem: "hash-mismatch" | "size-mismatch" | "not-in-manifest" | "missing-on-disk";
};

/** Compares files against a manifest. One problem per path; a size difference is reported before a hash difference. */
export function verifyManifest(manifest: Manifest, files: BundleFile[]): ManifestProblem[] {
  const problems: ManifestProblem[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    if (file.path === MANIFEST_NAME) continue;
    seen.add(file.path);
    if (!Object.hasOwn(manifest.files, file.path)) {
      problems.push({ path: file.path, problem: "not-in-manifest" });
      continue;
    }
    const entry = manifest.files[file.path];
    if (entry === undefined) continue;
    if (entry.bytes !== file.bytes.length)
      problems.push({ path: file.path, problem: "size-mismatch" });
    else if (entry.sha256 !== sha256Hex(file.bytes))
      problems.push({ path: file.path, problem: "hash-mismatch" });
  }
  for (const path of Object.keys(manifest.files)) {
    if (!seen.has(path)) problems.push({ path, problem: "missing-on-disk" });
  }
  return problems;
}
