/**
 * Checks package.json top-level fields against the SchemaStore package.json
 * schema so a misspelled field (e.g. "devDependecies") fails the build instead
 * of being silently ignored by npm.
 *
 * The field list is vendored in package-json-fields.json: the build makes no
 * network call. Refresh it from the "source" URL in that file when needed.
 */
import { readFileSync } from "fs";
import { resolve } from "path";

const root = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const fields = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "package-json-fields.json"), "utf8"),
);

const known = new Set(fields.properties);
const patterns = fields.patternProperties.map((p) => new RegExp(p));
const unknown = Object.keys(pkg).filter(
  (key) => !known.has(key) && !patterns.some((pattern) => pattern.test(key)),
);

if (unknown.length > 0) {
  console.error(`package.json has unknown fields: ${unknown.join(", ")}`);
  process.exit(1);
}
console.log(`package.json fields OK (${Object.keys(pkg).length} checked)`);
