import * as core from "@actions/core";
import * as fs from "fs";
import * as path from "path";
import { run, writeFileWithSudo, exportVariable, getArch, commandExists } from "../../shared/drs";
import { installDevinOidcCli } from "../../shared/devin-oidc-cli";
import { tokenHelperScript } from "./scripts";

function writeVaultConfig(helperPath: string): void {
  const homeDir = process.env.HOME || "/home/ubuntu";
  const configPath = path.join(homeDir, ".vault");

  // If ~/.vault already exists as a directory, remove it first; the Vault CLI
  // expects a plain file here for the token helper configuration.
  if (fs.existsSync(configPath) && fs.statSync(configPath).isDirectory()) {
    core.warning(`${configPath} exists as a directory; replacing with config file`);
    fs.rmSync(configPath, { recursive: true });
  }

  fs.writeFileSync(configPath, `token_helper = "${helperPath}"\n`);
  core.info(`Configured Vault token helper in ${configPath}`);
}

async function installVaultCli(version: string): Promise<void> {
  if (await commandExists("vault")) {
    const current = await run("vault version", { silent: true });
    core.info(`Vault CLI already installed: ${current}`);
    return;
  }

  const arch = await getArch();
  const goArch = arch === "arm64" ? "arm64" : "amd64";
  const url = `https://releases.hashicorp.com/vault/${version}/vault_${version}_linux_${goArch}.zip`;
  core.info(`Installing Vault CLI ${version} from ${url}`);
  await run(`curl -fsSL "${url}" -o /tmp/vault.zip`);
  await run("sudo unzip -oq /tmp/vault.zip -d /usr/local/bin");
  await run("sudo chmod 755 /usr/local/bin/vault");
  await run("rm -f /tmp/vault.zip");
  const installed = await run("vault version", { silent: true });
  core.info(`Installed: ${installed}`);
}

async function main(): Promise<void> {
  try {
    const vaultAddr = core.getInput("vault-addr", { required: true });
    const role = core.getInput("role", { required: true });
    const authMount = core.getInput("auth-mount") || "jwt";
    const audience = core.getInput("audience") || vaultAddr;
    const subjectKeys = core.getInput("subject-keys") || "org_id";
    const vaultNamespace = core.getInput("vault-namespace");
    const shouldInstallVault = core.getInput("install-vault") !== "false";
    const vaultVersion = core.getInput("vault-version") || "1.17.2";

    await installDevinOidcCli();

    if (shouldInstallVault) {
      await installVaultCli(vaultVersion);
    }

    const helperPath = "/usr/local/bin/devin-oidc-vault-token-helper";
    await writeFileWithSudo(
      helperPath,
      tokenHelperScript({ vaultAddr, role, authMount, audience, subjectKeys, vaultNamespace }),
    );
    await run(`sudo chmod 755 "${helperPath}"`);

    writeVaultConfig(helperPath);

    exportVariable("VAULT_ADDR", vaultAddr);
    if (vaultNamespace) {
      exportVariable("VAULT_NAMESPACE", vaultNamespace);
    }

    core.info(
      "HashiCorp Vault OIDC authentication configured. " +
      "The vault CLI will automatically obtain tokens via Devin OIDC.",
    );
  } catch (error: unknown) {
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
}

main();
