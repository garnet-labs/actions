/**
 * Build script: compiles each action's src/main.ts into dist/index.js via ncc.
 */
import { execFileSync } from "child_process";
import { readdirSync, existsSync, rmSync } from "fs";
import { resolve } from "path";

const root = resolve(import.meta.dirname, "..");
const dirs = readdirSync(root, { withFileTypes: true })
  .filter(
    (d) =>
      d.isDirectory() &&
      !d.name.startsWith(".") &&
      !["node_modules", "shared", "scripts", "lib"].includes(d.name),
  )
  .map((d) => d.name);

let built = 0;
let failed = 0;

for (const dir of dirs) {
  const srcFile = resolve(root, dir, "src", "main.ts");
  const actionFile = resolve(root, dir, "action.yml");
  if (!existsSync(srcFile) || !existsSync(actionFile)) continue;

  process.stdout.write(`  Building ${dir}...`);
  try {
    const outDir = resolve(root, dir, "dist");
    // Paths go to ncc as argv, never through a shell, so a checkout path with spaces builds.
    execFileSync(
      "npx",
      ["ncc", "build", srcFile, "-o", outDir, "--license", "licenses.txt", "-q"],
      { cwd: root, stdio: "pipe" },
    );
    // Remove type declaration files that ncc copies from other actions
    for (const entry of readdirSync(outDir, { withFileTypes: true })) {
      if (entry.isDirectory() || /\.(d\.ts|d\.ts\.map|js\.map)$/.test(entry.name)) {
        rmSync(resolve(outDir, entry.name), { recursive: true, force: true });
      }
    }
    console.log(" OK");
    built++;
  } catch (e) {
    console.log(` FAILED: ${e.stderr?.toString().trim() || e.message}`);
    failed++;
  }
}

console.log(`\nBuilt ${built} actions, ${failed} failed.`);
if (failed > 0) process.exit(1);
