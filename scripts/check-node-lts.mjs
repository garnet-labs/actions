import { get } from "https";

const major = process.versions.node.split(".")[0];

async function readJson(url) {
  let timeout;
  try {
    const response = await new Promise((resolve, reject) => {
      const request = get(url, resolve);
      request.on("error", reject);
      timeout = setTimeout(() => request.destroy(new Error("Request timed out")), 5000);
    });
    if (response.statusCode !== 200) {
      response.destroy();
      return null;
    }
    response.setEncoding("utf8");
    let body = "";
    for await (const chunk of response) body += chunk;
    return JSON.parse(body);
  } finally {
    clearTimeout(timeout);
  }
}

async function checkLts() {
  try {
    const releases = await readJson("https://nodejs.org/dist/index.json");
    if (!releases) return;
    const hasLtsRelease = releases.some(
      ({ version, lts }) => version.startsWith(`v${major}.`) && lts,
    );
    if (!hasLtsRelease) {
      console.warn(`Warning: Node.js ${major} has no LTS release. Use an LTS major for development.`);
    }
  } catch {
    // This advisory check must never prevent installation.
  }
}

async function checkEndOfLife() {
  try {
    const schedule = await readJson("https://raw.githubusercontent.com/nodejs/Release/main/schedule.json");
    const end = schedule?.[`v${major}`]?.end;
    if (typeof end === "string" && Date.now() > Date.parse(end)) {
      console.warn(`Warning: Node.js ${major} reached end of life on ${end}. Use a supported LTS major for development.`);
    }
  } catch {
    // This advisory check must never prevent installation.
  }
}

await Promise.all([checkLts(), checkEndOfLife()]);
