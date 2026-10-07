import type { Report } from "../bundle/model.js";

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The report as text for `status` and `check`: the fatal refusal first when there is one, then counts, then detail. */
export function renderReport(report: Report): string {
  const lines: string[] = [];
  if (report.fatal !== undefined) {
    lines.push(
      `FATAL ${report.fatal.rule}${report.fatal.path ? ` (${report.fatal.path})` : ""}: ${report.fatal.detail}`,
    );
  }
  lines.push(
    `${plural(report.admitted, "page")} admitted; ${report.excludedByStatus} excluded by status; ${plural(report.attachments, "attachment")}; ${report.hidden} hidden; ${report.refusals.length} refused; ${report.degradations.length} degraded${report.commit ? `; commit ${report.commit.slice(0, 12)}` : ""}`,
  );
  if (report.refusals.length > 0) {
    lines.push("Refused:");
    for (const r of report.refusals) lines.push(`  ${r.path}: ${r.rule} (${r.detail})`);
  }
  if (report.integrity === "skipped") {
    lines.push("Integrity was not checked: the manifest was not required for this load.");
  }
  if (report.degradations.length > 0) {
    lines.push("Degraded:");
    for (const d of report.degradations) lines.push(`  ${d.path}: ${d.code} (${d.detail})`);
  }
  if (report.unknownTypes.length > 0)
    lines.push(`Undeclared types: ${report.unknownTypes.join(", ")}`);
  if (report.unknownStatuses.length > 0) {
    lines.push(
      `Unknown statuses: ${report.unknownStatuses.map((s) => `${s.path} (${s.value})`).join(", ")}`,
    );
  }
  if (report.brokenLinks.length > 0)
    lines.push(`Broken links: ${report.brokenLinks.map((l) => `${l.from} → ${l.raw}`).join(", ")}`);
  if (report.linksToUnserved.length > 0) {
    lines.push(
      `Links to pages not served: ${report.linksToUnserved.map((l) => `${l.from} → ${l.target}`).join(", ")}`,
    );
  }
  if (report.missingOnDisk.length > 0)
    lines.push(`Listed in the manifest but missing: ${report.missingOnDisk.join(", ")}`);
  if (report.foldersWithoutIndex.length > 0) {
    lines.push(
      `Folders without an index (generated): ${report.foldersWithoutIndex.map((f) => f || "(root)").join(", ")}`,
    );
  }
  return `${lines.join("\n")}\n`;
}
