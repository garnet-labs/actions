import { get } from "https";
import { writeFile } from "fs/promises";
import { resolve } from "path";

const url = "https://unpkg.com/@tsconfig/node20@20.1.4/tsconfig.json";

function fetch(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        if (redirects >= 10) {
          reject(new Error("Too many redirects"));
          return;
        }
        resolve(fetch(new URL(response.headers.location, url), redirects + 1));
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`HTTP ${response.statusCode} fetching ${url}`));
        return;
      }
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve(Buffer.concat(chunks)));
      response.on("error", reject);
    }).on("error", reject);
  });
}

await writeFile(resolve(import.meta.dirname, "..", "tsconfig.base.json"), await fetch(url));
