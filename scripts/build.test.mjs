import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

test("build succeeds when the checkout path contains spaces", () => {
  const copy = mkdtempSync(join(tmpdir(), "actions checkout "));
  try {
    for (const path of ["package.json", "tsconfig.json", "scripts/build.mjs", "shared", "setup-devin-oidc/action.yml", "setup-devin-oidc/src"]) {
      cpSync(join(root, path), join(copy, path), { recursive: true });
    }
    symlinkSync(join(root, "node_modules"), join(copy, "node_modules"), "dir");

    const output = execFileSync(process.execPath, [join(copy, "scripts", "build.mjs")], { cwd: copy, encoding: "utf8" });

    assert.match(output, /Built 1 actions, 0 failed\./);
    const dist = join(copy, "setup-devin-oidc", "dist");
    assert.ok(existsSync(join(dist, "index.js")));
    const leftovers = readdirSync(dist, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || /\.(d\.ts|d\.ts\.map|js\.map)$/.test(entry.name))
      .map((entry) => entry.name);
    assert.deepEqual(leftovers, []);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});
