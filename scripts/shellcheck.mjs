/**
 * Runs a pinned ShellCheck release, downloading it on first use.
 *
 * The binary comes from the koalaman/shellcheck GitHub release, is verified
 * against the sha256 digest GitHub publishes for the asset, and is cached in
 * node_modules/.cache so later runs stay offline.
 *
 * Usage: node scripts/shellcheck.mjs [shellcheck args...]
 */
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "fs";
import { join, resolve } from "path";

const VERSION = "v0.11.0";
const ASSETS = {
  "linux-x64": ["linux.x86_64", "b7af85e41cc99489dcc21d66c6d5f3685138f06d34651e6d34b42ec6d54fe6f6"],
  "linux-arm64": ["linux.aarch64", "68a8133197a50beb8803f8d42f9908d1af1c5540d4bb05fdfca8c1fa47decefc"],
  "darwin-x64": ["darwin.x86_64", "c2c15e08df0e8fbc374c335b230a7ee958c313fa5714817a59aa59f1aa594f51"],
  "darwin-arm64": ["darwin.aarch64", "339b930feb1ea764467013cc1f72d09cd6b869ebf1013296ba9055ab2ffbd26f"],
};

const cacheDir = resolve(import.meta.dirname, "..", "node_modules", ".cache", `shellcheck-${VERSION}`);
const binary = join(cacheDir, "shellcheck");

async function install() {
  const asset = ASSETS[`${process.platform}-${process.arch}`];
  if (!asset) throw new Error(`no pinned ShellCheck ${VERSION} build for ${process.platform}-${process.arch}`);
  const [target, sha256] = asset;
  const name = `shellcheck-${VERSION}.${target}.tar.gz`;
  const url = `https://github.com/koalaman/shellcheck/releases/download/${VERSION}/${name}`;

  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`downloading ${url}: HTTP ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  const digest = createHash("sha256").update(archive).digest("hex");
  if (digest !== sha256) throw new Error(`${name}: sha256 ${digest}, expected ${sha256}`);

  mkdirSync(cacheDir, { recursive: true });
  const work = mkdtempSync(join(cacheDir, "download-"));
  try {
    writeFileSync(join(work, name), archive);
    const tar = spawnSync("tar", ["-xzf", name], { cwd: work, stdio: "inherit" });
    if (tar.status !== 0) throw new Error(`extracting ${name} failed`);
    const extracted = join(work, `shellcheck-${VERSION}`, "shellcheck");
    chmodSync(extracted, 0o755);
    renameSync(extracted, binary);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (!existsSync(binary)) await install();
const result = spawnSync(binary, process.argv.slice(2), { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
