import * as core from "@actions/core";
import * as fs from "fs";
import { run, tryRun, writeFileWithSudo, exportVariable, commandExists } from "../../shared/drs";
import { installDevinOidcCli } from "../../shared/devin-oidc-cli";
import { realAzShimScript, refreshScript, wrapperScript } from "./scripts";

async function installAzureCli(): Promise<void> {
  core.info("Installing Azure CLI");
  await run("curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash");
  const installed = await run("az version --output json", { silent: true });
  core.info(`Installed Azure CLI: ${installed}`);
}

async function resolveRealAz(): Promise<boolean> {
  let azPath = (await tryRun("command -v az", { silent: true })).stdout.trim();
  if (!azPath) {
    return false;
  }

  const realAzPath = "/usr/local/bin/.az-real";
  if (await commandExists(realAzPath)) {
    return true;
  }

  if (azPath === "/usr/local/bin/az") {
    try {
      const wrapper = fs.readFileSync(azPath, "utf8");
      const realAz = wrapper.match(/^REAL_AZ=(\S+)$/m)?.[1];
      if (!realAz || realAz === azPath) {
        core.warning("Could not resolve the real Azure CLI behind /usr/local/bin/az");
        return false;
      }
      azPath = realAz;
    } catch {
      core.warning("Could not read the existing /usr/local/bin/az wrapper");
      return false;
    }
  }

  await writeFileWithSudo(realAzPath, realAzShimScript(azPath));
  await run(`sudo chmod 755 "${realAzPath}"`);
  return true;
}

async function main(): Promise<void> {
  try {
    const clientId = core.getInput("client-id", { required: true });
    const tenantId = core.getInput("tenant-id", { required: true });
    const subscriptionId = core.getInput("subscription-id");
    const audience = core.getInput("audience") || "api://AzureADTokenExchange";
    const subjectKeys = core.getInput("subject-keys") || "org_id";
    const shouldInstallAzureCli = core.getInput("install-azure-cli") !== "false";

    // 1. Install devin-oidc CLI
    await installDevinOidcCli();

    // 2. Install Azure CLI when requested and absent
    let azAvailable = await commandExists("az");
    if (!azAvailable && shouldInstallAzureCli) {
      await installAzureCli();
      azAvailable = await commandExists("az");
    } else if (azAvailable) {
      const current = await run("az version --output json", { silent: true });
      core.info(`Azure CLI already installed: ${current}`);
    } else {
      core.warning("Azure CLI not found; skipping Azure CLI wrapper and login");
    }

    // 3. Preserve the real Azure CLI before installing the wrapper
    const hasRealAz = azAvailable && (await resolveRealAz());

    // 4. Install the refresh helper
    const refreshPath = "/usr/local/bin/devin-oidc-azure-refresh";
    await writeFileWithSudo(
      refreshPath,
      refreshScript({ clientId, tenantId, subscriptionId, audience, subjectKeys }),
    );
    await run(`sudo chmod 755 "${refreshPath}"`);

    // 5. Install the Azure CLI wrapper only when a real CLI is available
    if (hasRealAz) {
      await writeFileWithSudo("/usr/local/bin/az", wrapperScript());
      await run("sudo chmod 755 /usr/local/bin/az");
    }

    // 6. Initial login is non-fatal; the wrapper retries at runtime
    const { exitCode: refreshExit } = await tryRun(`${refreshPath} --force`, { silent: true });
    if (refreshExit !== 0) {
      core.warning(
        "Initial Azure OIDC login failed — auth will be attempted on the first Azure CLI command",
      );
    }

    // 7. Configure Azure SDK workload identity environment variables
    const tokenFile = `${process.env.HOME || "/home/ubuntu"}/.azure-federated-token`;
    exportVariable("AZURE_CLIENT_ID", clientId);
    exportVariable("AZURE_TENANT_ID", tenantId);
    exportVariable("AZURE_FEDERATED_TOKEN_FILE", tokenFile);
    exportVariable("AZURE_AUTHORITY_HOST", "https://login.microsoftonline.com");
    if (subscriptionId) {
      exportVariable("AZURE_SUBSCRIPTION_ID", subscriptionId);
    }

    core.info(
      "Azure OIDC authentication configured. Azure CLI and Azure SDKs will obtain credentials via Devin OIDC.",
    );
  } catch (error: unknown) {
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
}

main();
