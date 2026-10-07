import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("the dependency rules", { timeout: 120_000 }, () => {
  it("catch a core module that imports the composition layer", () => {
    const work = mkdtempSync(join(tmpdir(), "okf-catalog-depcruise-"));
    try {
      cpSync(join(REPO, "src"), join(work, "src"), { recursive: true });
      for (const file of [".dependency-cruiser.cjs", "tsconfig.json", "package.json"])
        cpSync(join(REPO, file), join(work, file));
      symlinkSync(join(REPO, "node_modules"), join(work, "node_modules"));
      const target = join(work, "src", "catalog", "text.ts");
      writeFileSync(target, `import "../serve/runtime.js";\n${readFileSync(target, "utf8")}`);
      const run = spawnSync(
        process.execPath,
        [
          join(REPO, "node_modules", ".bin", "depcruise"),
          "src",
          "--config",
          ".dependency-cruiser.cjs",
        ],
        { cwd: work, encoding: "utf8" },
      );
      expect(run.status).not.toBe(0);
      expect(`${run.stdout}${run.stderr}`).toContain("core-stays-core");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
