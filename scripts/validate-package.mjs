/**
 * Checks package.json top-level fields against the SchemaStore schema so a
 * misspelled field (e.g. "devDependecies") fails the build instead of being
 * silently ignored by npm.
 */
import { readFileSync } from "fs";
import { resolve } from "path";

const root = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

const response = await fetch("https://json.schemastore.org/package.json");
if (!response.ok) {
  throw new Error(`Could not load package.json schema: HTTP ${response.status}`);
}
const schema = await response.json();

const known = new Set(Object.keys(schema.properties ?? {}));
const patterns = Object.keys(schema.patternProperties ?? {}).map((p) => new RegExp(p));
const unknown = Object.keys(pkg).filter(
  (key) => !known.has(key) && !patterns.some((pattern) => pattern.test(key)),
);

if (unknown.length > 0) {
  console.error(`package.json has unknown fields: ${unknown.join(", ")}`);
  process.exit(1);
}
console.log(`package.json fields OK (${Object.keys(pkg).length} checked)`);
