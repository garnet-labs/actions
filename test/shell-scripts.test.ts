import { strict as assert } from "assert";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { after, before, test } from "node:test";
import { DEVIN_OIDC_SCRIPT } from "../shared/devin-oidc-cli";
import * as aws from "../setup-aws-oidc/src/scripts";
import * as azure from "../setup-azure-oidc/src/scripts";
import * as gcp from "../setup-gcp-oidc/src/scripts";
import * as infisical from "../setup-infisical-oidc/src/scripts";
import * as jfrog from "../setup-jfrog-oidc/src/scripts";
import * as vault from "../setup-vault-oidc/src/scripts";

// Compiled to lib/test/, so the repository root is two levels up.
const SHELLCHECK = resolve(__dirname, "..", "..", "scripts", "shellcheck.mjs");

const audience = "my-api";
const subjectKeys = "org_id repository_name";

const scripts: Record<string, string> = {
  "devin-oidc": DEVIN_OIDC_SCRIPT,
  "aws credential helper": aws.credentialHelperScript({
    roleArn: "arn:aws:iam::123456789012:role/devin",
    audience,
    subjectKeys,
    sessionName: "devin",
    durationSeconds: "3600",
  }),
  "azure refresh": azure.refreshScript({
    clientId: "00000000-0000-0000-0000-000000000001",
    tenantId: "00000000-0000-0000-0000-000000000002",
    subscriptionId: "00000000-0000-0000-0000-000000000003",
    audience,
    subjectKeys,
  }),
  "azure wrapper": azure.wrapperScript(),
  "azure real-az shim": azure.realAzShimScript("/usr/bin/az"),
  "gcp credential helper": gcp.credentialHelperScript({ audience, subjectKeys }),
  "infisical refresh": infisical.refreshScript({
    infisicalUrl: "https://app.infisical.com",
    identityId: "00000000-0000-0000-0000-000000000004",
    audience,
    subjectKeys,
  }),
  "infisical wrapper": infisical.wrapperScript(),
  "jfrog refresh": jfrog.refreshScript({
    jfrogUrl: "https://example.jfrog.io",
    providerName: "devin",
    audience,
    subjectKeys,
    serverId: "devin",
  }),
  "jfrog wrapper": jfrog.wrapperScript(),
  "vault token helper": vault.tokenHelperScript({
    vaultAddr: "https://vault.example.com",
    role: "devin",
    authMount: "jwt",
    audience,
    subjectKeys,
    vaultNamespace: "",
  }),
  "vault token helper with namespace": vault.tokenHelperScript({
    vaultAddr: "https://vault.example.com",
    role: "devin",
    authMount: "jwt",
    audience,
    subjectKeys,
    vaultNamespace: "admin/devin",
  }),
};

let dir = "";
before(() => {
  dir = mkdtempSync(join(tmpdir(), "shell-scripts-"));
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

for (const [name, script] of Object.entries(scripts)) {
  test(`${name} passes bash -n and shellcheck`, () => {
    assert.ok(script.startsWith("#!/usr/bin/env bash\n"), "missing bash shebang");
    const file = join(dir, `${name.replace(/\W+/g, "-")}.sh`);
    writeFileSync(file, script);

    const syntax = spawnSync("bash", ["-n", file], { encoding: "utf8" });
    assert.equal(syntax.status, 0, syntax.stderr);

    const lint = spawnSync(process.execPath, [SHELLCHECK, "--shell=bash", "--severity=warning", file], {
      encoding: "utf8",
    });
    assert.equal(lint.status, 0, lint.stdout + lint.stderr);
  });
}
