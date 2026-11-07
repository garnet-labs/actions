import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, ".shared-tests-"));
try {
  const compile = spawnSync(process.execPath, [
    join(root, "node_modules/typescript/bin/tsc"),
    "--target", "ES2022", "--module", "commonjs", "--strict",
    "--esModuleInterop", "--skipLibCheck", "--outDir", outDir,
    "shared/drs.ts", "shared/devin-oidc-cli.ts",
  ], { cwd: root, stdio: "inherit" });
  if (compile.error) throw compile.error;
  if (compile.status !== 0) process.exitCode = compile.status ?? 1;
  else {
    const tests = spawnSync(process.execPath, ["--test", "scripts/shared.test.mjs"], {
      cwd: root, stdio: "inherit", env: { ...process.env, SHARED_TEST_DIR: outDir },
    });
    if (tests.error) throw tests.error;
    process.exitCode = tests.status ?? 1;
  }
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
