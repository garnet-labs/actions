import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const drs = require(join(process.env.SHARED_TEST_DIR, "drs.js"));
const { installDevinOidcCli, DEVIN_OIDC_CLI_PATH } = require(join(process.env.SHARED_TEST_DIR, "devin-oidc-cli.js"));
let DEVIN_OIDC_SCRIPT;

test("installer writes the generated CLI to the public path and makes it executable", async () => {
  const originalWrite = drs.writeFileWithSudo;
  const originalRun = drs.run;
  const commands = [];
  const writes = [];
  drs.writeFileWithSudo = async (path, content) => writes.push({ path, content });
  drs.run = async (command) => commands.push(command);
  try {
    await installDevinOidcCli();
  } finally {
    drs.writeFileWithSudo = originalWrite;
    drs.run = originalRun;
  }
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, DEVIN_OIDC_CLI_PATH);
  assert.equal(DEVIN_OIDC_CLI_PATH, "/usr/local/bin/devin-oidc");
  assert.deepEqual(commands, [`sudo chmod 755 "${DEVIN_OIDC_CLI_PATH}"`]);
  DEVIN_OIDC_SCRIPT = writes[0].content;
});

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "shared-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("run trims stdout, handles empty output and cwd, and rejects failed commands", async (t) => {
  const dir = fixture(t);
  assert.equal(await drs.run("printf '  hello\\n'", { silent: true }), "hello");
  assert.equal(await drs.run(":", { silent: true }), "");
  assert.equal(await drs.run("pwd", { silent: true, cwd: dir }), dir);
  await assert.rejects(drs.run("exit 7", { silent: true }), /7/);
});

test("tryRun preserves output and exit status without throwing", async () => {
  assert.deepEqual(await drs.tryRun("printf ' result\\n'; exit 9"), { exitCode: 9, stdout: "result" });
  assert.deepEqual(await drs.tryRun(":"), { exitCode: 0, stdout: "" });
  assert.equal(await drs.commandExists("bash"), true);
  assert.equal(await drs.commandExists("nonexistent_shared_test_command_89123"), false);
});

test("writeFile creates parents, overwrites verbatim and rejects invalid paths", async (t) => {
  const dir = fixture(t);
  const file = join(dir, "nested", "config");
  const content = "quotes ' \\\\ $HOME\\n\n";
  await drs.writeFile(file, content);
  assert.equal(readFileSync(file, "utf8"), content);
  await drs.writeFile(file, "");
  assert.equal(readFileSync(file, "utf8"), "");
  await assert.rejects(drs.writeFile(join(file, "child"), "x"));
});

test("appendToEnvrc appends lines and tolerates unset or unwritable ENVRC", (t) => {
  const dir = fixture(t);
  const previous = process.env.ENVRC;
  t.after(() => {
    if (previous === undefined) delete process.env.ENVRC;
    else process.env.ENVRC = previous;
  });
  process.env.ENVRC = join(dir, "envrc");
  drs.appendToEnvrc("ONE=1");
  drs.appendToEnvrc("");
  assert.equal(readFileSync(process.env.ENVRC, "utf8"), "ONE=1\n\n");
  process.env.ENVRC = dir;
  assert.doesNotThrow(() => drs.appendToEnvrc("ignored"));
  delete process.env.ENVRC;
  assert.doesNotThrow(() => drs.appendToEnvrc("ignored"));
});

function cli(t, env = {}) {
  const dir = fixture(t);
  const script = join(dir, "devin-oidc");
  const token = join(dir, "token");
  writeFileSync(script, DEVIN_OIDC_SCRIPT);
  return { token, run: (...args) => spawnSync("bash", [script, ...args], {
    encoding: "utf8", env: { ...process.env, DEVIN_OIDC_TOKEN_FILE: token, DEVIN_OIDC_EXCHANGE_URL: "", ...env },
  }) };
}

test("generated CLI provides help and rejects empty, unknown and incomplete commands", (t) => {
  const { run } = cli(t);
  assert.equal(run("--help").status, 0);
  assert.match(run("--help").stdout, /token --audience/);
  assert.equal(run().status, 1);
  assert.match(run("unknown").stderr, /unknown command/);
  assert.match(run("token").stderr, /--audience is required/);
  assert.match(run("token", "--unknown").stderr, /unknown option/);
});

test("generated CLI reads the configured token verbatim and diagnoses a missing token", (t) => {
  const { run, token } = cli(t);
  assert.equal(run("print-general-token").status, 1);
  assert.match(run("print-general-token").stderr, /no general OIDC token/);
  writeFileSync(token, "synthetic.token.value");
  const result = run("print-general-token");
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "synthetic.token.value\n");
  writeFileSync(token, "");
  assert.equal(run("print-general-token").stdout, "\n");
});

test("generated CLI sends exchange parameters and handles invalid server responses", (t) => {
  const dir = fixture(t);
  const argsFile = join(dir, "args");
  writeFileSync(join(dir, "curl"), '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$TEST_CURL_ARGS"\nprintf "%s\\n200" "$TEST_RESPONSE"\n', { mode: 0o755 });
  const invoke = (response) => {
    const { run, token } = cli(t, {
      PATH: `${dir}:${process.env.PATH}`, TEST_CURL_ARGS: argsFile, TEST_RESPONSE: response,
    });
    writeFileSync(token, "synthetic-general-token");
    return run("token", "--audience", "test audience", "--subject-keys", "org_id repository_name", "--exchange-url", "https://example.invalid/exchange");
  };
  const result = invoke('{"access_token":"exchanged-token"}');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "exchanged-token\n");
  const args = readFileSync(argsFile, "utf8").split("\n");
  for (const value of ["https://example.invalid/exchange", "audience=test audience", "subject_keys=org_id repository_name", "subject_token=synthetic-general-token", "grant_type=urn:ietf:params:oauth:grant-type:token-exchange"]) {
    assert.ok(args.includes(value), `missing curl argument: ${value}`);
  }
  for (const response of ["{}", ""]) {
    const failure = invoke(response);
    assert.equal(failure.status, 1);
    assert.match(failure.stderr, /no access_token in response/);
  }
});
