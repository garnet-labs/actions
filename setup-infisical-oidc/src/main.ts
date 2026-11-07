import * as core from "@actions/core";
import { run, tryRun, writeFileWithSudo, exportVariable, getArch, commandExists } from "../../shared/drs";
import { installDevinOidcCli } from "../../shared/devin-oidc-cli";
import { refreshScript, wrapperScript } from "./scripts";

async function installInfisicalCli(version: string): Promise<void> {
  if (await commandExists(".infisical-real")) {
    const current = await run("/usr/local/bin/.infisical-real --version", { silent: true });
    core.info(`Infisical CLI already installed: ${current}`);
    return;
  }

  if (await commandExists("infisical")) {
    // Move existing infisical to .infisical-real before installing wrapper
    const cliPath = (await run("which infisical", { silent: true })).trim();
    if (cliPath) {
      await run(`sudo mv "${cliPath}" /usr/local/bin/.infisical-real`);
      const current = await run("/usr/local/bin/.infisical-real --version", { silent: true });
      core.info(`Moved existing Infisical CLI to .infisical-real: ${current}`);
      return;
    }
  }

  const arch = await getArch();
  const goArch = arch === "arm64" ? "arm64" : "amd64";
  const url = `https://github.com/Infisical/cli/releases/download/v${version}/cli_${version}_linux_${goArch}.tar.gz`;
  core.info(`Installing Infisical CLI ${version} from ${url}`);
  await run(`curl -fsSL "${url}" -o /tmp/infisical-cli.tar.gz`);
  await run("sudo tar -xzf /tmp/infisical-cli.tar.gz -C /usr/local/bin infisical");
  await run("sudo mv /usr/local/bin/infisical /usr/local/bin/.infisical-real");
  await run("sudo chmod 755 /usr/local/bin/.infisical-real");
  await run("rm -f /tmp/infisical-cli.tar.gz");
  const installed = await run("/usr/local/bin/.infisical-real --version", { silent: true });
  core.info(`Installed: ${installed}`);
}

async function main(): Promise<void> {
  try {
    const infisicalUrl = (core.getInput("infisical-url") || "https://app.infisical.com").replace(/\/+$/, "");
    const identityId = core.getInput("identity-id", { required: true });
    const audience = core.getInput("audience") || infisicalUrl;
    const subjectKeys = core.getInput("subject-keys") || "org_id";
    const shouldInstall = core.getInput("install-infisical-cli") !== "false";
    const cliVersion = core.getInput("infisical-cli-version") || "0.43.110";

    // 1. Install devin-oidc CLI
    await installDevinOidcCli();

    // 2. Install Infisical CLI (as .infisical-real)
    if (shouldInstall) {
      await installInfisicalCli(cliVersion);
    } else {
      // Move existing infisical to .infisical-real if not already done
      if (!(await commandExists(".infisical-real")) && (await commandExists("infisical"))) {
        const cliPath = (await run("which infisical", { silent: true })).trim();
        if (cliPath && cliPath !== "/usr/local/bin/.infisical-real") {
          await run(`sudo mv "${cliPath}" /usr/local/bin/.infisical-real`);
        }
      }
    }

    // 3. Install refresh helper
    await writeFileWithSudo(
      "/usr/local/bin/devin-oidc-infisical-refresh",
      refreshScript({ infisicalUrl, identityId, audience, subjectKeys }),
    );
    await run("sudo chmod 755 /usr/local/bin/devin-oidc-infisical-refresh");

    // 4. Install infisical wrapper
    await writeFileWithSudo("/usr/local/bin/infisical", wrapperScript());
    await run("sudo chmod 755 /usr/local/bin/infisical");

    // 5. Initial login (non-fatal — wrapper refreshes at runtime)
    const { exitCode: refreshExit, stdout: refreshOut } = await tryRun(
      "/usr/local/bin/devin-oidc-infisical-refresh --force",
      { silent: true },
    );
    if (refreshExit !== 0) {
      core.warning("Initial OIDC login failed — auth will be attempted on first infisical command via the wrapper");
    } else if (!refreshOut.trim()) {
      core.warning("Initial OIDC login returned empty — auth may not work until the session has a valid OIDC token");
    }

    // 6. Export INFISICAL_API_URL so the CLI targets the right instance
    exportVariable("INFISICAL_API_URL", `${infisicalUrl}/api`);

    core.info(
      "Infisical OIDC configured. Use 'infisical secrets', 'infisical run', etc. " +
      "Access tokens are obtained automatically via Devin OIDC.",
    );
  } catch (error: unknown) {
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
}

main();
