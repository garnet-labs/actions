import { get } from "https";

let timeout;
try {
  const response = await new Promise((resolve, reject) => {
    const request = get("https://nodejs.org/dist/index.json", resolve);
    request.on("error", reject);
    timeout = setTimeout(() => request.destroy(new Error("Request timed out")), 5000);
  });
  if (response.statusCode === 200) {
    response.setEncoding("utf8");
    let body = "";
    for await (const chunk of response) body += chunk;
    const releases = JSON.parse(body);
    const major = process.versions.node.split(".")[0];
    const hasLtsRelease = releases.some(
      ({ version, lts }) => version.startsWith(`v${major}.`) && lts,
    );
    if (!hasLtsRelease) {
      console.warn(`Warning: Node.js ${major} has no LTS release. Use an LTS major for development.`);
    }
  } else {
    response.destroy();
  }
} catch {
  // This advisory check must never prevent installation.
} finally {
  clearTimeout(timeout);
}
