import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const url = "https://unpkg.com/@tsconfig/node20@20.1.4/tsconfig.json";
// Pins the exact preset bytes.
const expectedSha256 =
  "d622b624459cad5ee5aa1f9dc9d0fe1404850eca9b015e89bc8800b2e1264ee4";
const root = resolve(import.meta.dirname, "..");

async function main() {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  const body = Buffer.from(await response.arrayBuffer());
  const actualSha256 = createHash("sha256").update(body).digest("hex");
  if (actualSha256 !== expectedSha256) {
    throw new Error(
      `SHA-256 mismatch for ${url}: expected ${expectedSha256}, got ${actualSha256}`,
    );
  }

  await writeFile(resolve(root, "tsconfig.base.json"), body);
}

main().catch((error) => {
  console.error(`Failed to fetch TypeScript config from ${url}: ${error.message}`);
  process.exitCode = 1;
});
