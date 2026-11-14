import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  addPath,
  appendToEnvrc,
  commandExists,
  exportVariable,
  run,
  tryRun,
  writeFile,
} from "./drs";

function fixture(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "shared helpers "));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function setEnv(t: TestContext, values: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(values)) {
    const previous = process.env[name];
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

test("run returns trimmed stdout, including empty output", async () => {
  assert.equal(await run("printf '  hello\\nworld  \\n'", { silent: true }), "hello\nworld");
  assert.equal(await run(":", { silent: true }), "");
});

test("run honors cwd with spaces and rejects failing commands", async (t) => {
  const dir = fixture(t);
  assert.equal(await run("pwd", { cwd: dir, silent: true }), dir);
  await assert.rejects(run("exit 7", { silent: true }), /7/);
});

test("tryRun returns stdout and exit status without throwing", async () => {
  assert.deepEqual(await tryRun("printf ' output\\n'; exit 9"), {
    exitCode: 9, stdout: "output",
  });
  assert.deepEqual(await tryRun(":"), { exitCode: 0, stdout: "" });
});

test("commandExists distinguishes an available command from a missing one", async () => {
  assert.equal(await commandExists("bash"), true);
  assert.equal(await commandExists("__shared_helpers_missing_command__"), false);
});

test("writeFile creates parents and overwrites content verbatim", async (t) => {
  const file = join(fixture(t), "nested", "config");
  const content = "quotes ' \\\\ $HOME\nsecond line\n";
  await writeFile(file, content);
  assert.equal(readFileSync(file, "utf8"), content);
  await writeFile(file, "");
  assert.equal(readFileSync(file, "utf8"), "");
  await assert.rejects(writeFile(join(file, "child"), "invalid"));
});

test("appendToEnvrc appends newline-terminated lines", (t) => {
  const envrc = join(fixture(t), "envrc");
  writeFileSync(envrc, "EXISTING=1\n");
  setEnv(t, { ENVRC: envrc });
  appendToEnvrc("NEXT=two");
  appendToEnvrc("");
  assert.equal(readFileSync(envrc, "utf8"), "EXISTING=1\nNEXT=two\n\n");
});

test("appendToEnvrc tolerates missing and unwritable ENVRC", (t) => {
  setEnv(t, { ENVRC: undefined });
  assert.doesNotThrow(() => appendToEnvrc("IGNORED=1"));
  process.env.ENVRC = fixture(t);
  assert.doesNotThrow(() => appendToEnvrc("IGNORED=1"));
});

test("exportVariable propagates to process.env, GITHUB_ENV and ENVRC", (t) => {
  const dir = fixture(t);
  const githubEnv = join(dir, "github-env");
  const envrc = join(dir, "envrc");
  writeFileSync(githubEnv, "");
  setEnv(t, { GITHUB_ENV: githubEnv, ENVRC: envrc, SHARED_HELPERS_TEST: undefined });
  exportVariable("SHARED_HELPERS_TEST", "value with spaces");
  assert.equal(process.env.SHARED_HELPERS_TEST, "value with spaces");
  assert.match(readFileSync(githubEnv, "utf8"), /SHARED_HELPERS_TEST<<[^\n]+\nvalue with spaces\n/);
  assert.equal(readFileSync(envrc, "utf8"), "SHARED_HELPERS_TEST=value with spaces\n");
});

test("addPath propagates to PATH, GITHUB_PATH and ENVRC", (t) => {
  const dir = fixture(t);
  const githubPath = join(dir, "github-path");
  const envrc = join(dir, "envrc");
  const bin = join(dir, "bin");
  writeFileSync(githubPath, "");
  setEnv(t, { GITHUB_PATH: githubPath, ENVRC: envrc, PATH: "/usr/bin:/bin" });
  addPath(bin);
  assert.equal(process.env.PATH, `${bin}:/usr/bin:/bin`);
  assert.equal(readFileSync(githubPath, "utf8"), `${bin}\n`);
  assert.equal(readFileSync(envrc, "utf8"), `PATH=${bin}:$PATH\n`);
});
