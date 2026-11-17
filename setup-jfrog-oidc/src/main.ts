import * as core from "@actions/core";
import { run, tryRun, writeFileWithSudo, exportVariable, getArch, commandExists } from "../../shared/drs";
import { installDevinOidcCli } from "../../shared/devin-oidc-cli";
import { refreshScript, wrapperScript } from "./scripts";

async function installJfrogCli(version: string): Promise<void> {
  if (await commandExists(".jf-real")) {
    const current = await run("/usr/local/bin/.jf-real --version", { silent: true });
    core.info(`JFrog CLI already installed: ${current}`);
    return;
  }

  if (await commandExists("jf")) {
    // Move existing jf to .jf-real before installing wrapper
    const jfPath = (await run("which jf", { silent: true })).trim();
    if (jfPath) {
      await run(`sudo mv "${jfPath}" /usr/local/bin/.jf-real`);
      const current = await run("/usr/local/bin/.jf-real --version", { silent: true });
      core.info(`Moved existing JFrog CLI to .jf-real: ${current}`);
      return;
    }
  }

  const arch = await getArch();
  const goArch = arch === "arm64" ? "arm64" : "amd64";
  const url = `https://releases.jfrog.io/artifactory/jfrog-cli/v2-jf/${version}/jfrog-cli-linux-${goArch}/jf`;
  core.info(`Installing JFrog CLI ${version} from ${url}`);
  await run(`sudo curl -fsSL "${url}" -o /usr/local/bin/.jf-real`);
  await run("sudo chmod 755 /usr/local/bin/.jf-real");
  const installed = await run("/usr/local/bin/.jf-real --version", { silent: true });
  core.info(`Installed: ${installed}`);
}

async function main(): Promise<void> {
  try {
    const jfrogUrl = core.getInput("jfrog-url", { required: true });
    const providerName = core.getInput("provider-name", { required: true });
    const audience = core.getInput("audience") || jfrogUrl;
    const subjectKeys = core.getInput("subject-keys") || "org_id";
    const serverId = core.getInput("server-id") || "default";
    const shouldInstall = core.getInput("install-jfrog-cli") !== "false";
    const cliVersion = core.getInput("jfrog-cli-version") || "2.72.2";

    // 1. Install devin-oidc CLI
    await installDevinOidcCli();

    // 2. Install JFrog CLI (as .jf-real)
    if (shouldInstall) {
      await installJfrogCli(cliVersion);
    } else {
      // Move existing jf to .jf-real if not already done
      if (!(await commandExists(".jf-real")) && (await commandExists("jf"))) {
        const jfPath = (await run("which jf", { silent: true })).trim();
        if (jfPath && jfPath !== "/usr/local/bin/.jf-real") {
          await run(`sudo mv "${jfPath}" /usr/local/bin/.jf-real`);
        }
      }
    }

    // 3. Install refresh helper
    await writeFileWithSudo(
      "/usr/local/bin/devin-oidc-jfrog-refresh",
      refreshScript({ jfrogUrl, providerName, audience, subjectKeys, serverId }),
    );
    await run("sudo chmod 755 /usr/local/bin/devin-oidc-jfrog-refresh");

    // 4. Install jf wrapper
    await writeFileWithSudo("/usr/local/bin/jf", wrapperScript());
    await run("sudo chmod 755 /usr/local/bin/jf");

    // 5. Initial token exchange (non-fatal — wrapper handles refresh at runtime)
    const { exitCode: refreshExit, stdout: refreshOut } = await tryRun("/usr/local/bin/devin-oidc-jfrog-refresh", { silent: true });
    if (refreshExit !== 0) {
      core.warning("Initial token exchange failed — auth will be attempted on first jf command via the wrapper");
    } else if (!refreshOut.trim()) {
      core.warning("Initial token exchange returned empty — auth may not work until the session has a valid OIDC token");
    }

    // 6. Export JFROG_URL
    exportVariable("JFROG_URL", jfrogUrl);

    core.info(
      "JFrog OIDC configured. Use 'jf npm install', 'jf docker pull', etc. " +
      "Auth refreshes automatically on 401.",
    );
  } catch (error: unknown) {
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
}

main();
