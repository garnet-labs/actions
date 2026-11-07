/**
 * Build script: compiles each action's src/main.ts into dist/index.js via ncc.
 */
import { execSync } from "child_process";
import { readdirSync, existsSync, readFileSync } from "fs";
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

await warnIfNccOutdated();

let built = 0;
let failed = 0;

for (const dir of dirs) {
  const srcFile = resolve(root, dir, "src", "main.ts");
  const actionFile = resolve(root, dir, "action.yml");
  if (!existsSync(srcFile) || !existsSync(actionFile)) continue;

  process.stdout.write(`  Building ${dir}...`);
  try {
    const outDir = resolve(root, dir, "dist");
    execSync(
      `npx ncc build ${srcFile} -o ${outDir} --license licenses.txt -q`,
      { cwd: root, stdio: "pipe" },
    );
    // Remove type declaration files that ncc copies from other actions
    execSync(
      `find ${outDir} -mindepth 1 -maxdepth 1 -type d -exec rm -rf {} + 2>/dev/null; ` +
      `rm -f ${outDir}/*.d.ts ${outDir}/*.d.ts.map ${outDir}/*.js.map 2>/dev/null; true`,
      { cwd: root, stdio: "pipe" },
    );
    console.log(" OK");
    built++;
  } catch (e) {
    console.log(` FAILED: ${e.stderr?.toString().trim() || e.message}`);
    failed++;
  }
}

console.log(`\nBuilt ${built} actions, ${failed} failed.`);
if (failed > 0) process.exit(1);

async function warnIfNccOutdated() {
  try {
    const pkg = resolve(root, "node_modules", "@vercel", "ncc", "package.json");
    const installed = JSON.parse(readFileSync(pkg, "utf8")).version;
    const response = await fetch("https://registry.npmjs.org/@vercel/ncc/latest", {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return;
    const latest = (await response.json()).version;
    if (compareVersions(installed, latest) < 0) {
      console.warn(
        `  Warning: @vercel/ncc ${installed} is installed, but ${latest} is the latest release.`,
      );
    }
  } catch {
    // Offline or not installed: the check is advisory and never blocks the build.
  }
}

function compareVersions(a, b) {
  const pa = a.split("-")[0].split(".").map(Number);
  const pb = b.split("-")[0].split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}
