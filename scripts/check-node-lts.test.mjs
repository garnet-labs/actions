import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import test from "node:test";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";

const source = await readFile(new URL("./check-node-lts.mjs", import.meta.url), "utf8");
const ltsWarning = "Warning: Node.js 20 has no LTS release. Use an LTS major for development.";
const eolWarning = "Warning: Node.js 20 reached end of life on 2026-04-30. Use a supported LTS major for development.";

async function run({ releases = [{ version: "v20.1.0", lts: "Iron" }],
  schedule = { v20: { end: "2026-04-30" } }, now = "2026-05-01T00:00:00Z",
  ltsFailure, eolFailure } = {}) {
  const warnings = [];
  const timers = new Set();
  const requests = [];
  let lastFailure;
  const context = createContext({
    process: { versions: { node: "20.1.0" } },
    console: { warn: (message) => warnings.push(message) },
    Date: class extends Date { static now() { return Date.parse(now); } },
    setTimeout(callback, delay) {
      assert.equal(delay, 5000);
      const timer = {};
      timers.add(timer);
      if (lastFailure === "timeout" || lastFailure === "body-timeout") queueMicrotask(callback);
      return timer;
    },
    clearTimeout(timer) { timers.delete(timer); },
  });
  const https = new SyntheticModule(["get"], function () {
    this.setExport("get", (url, callback) => {
      requests.push(url);
      const isLts = url === "https://nodejs.org/dist/index.json";
      assert.ok(isLts || url === "https://raw.githubusercontent.com/nodejs/Release/main/schedule.json");
      const failure = isLts ? ltsFailure : eolFailure;
      lastFailure = failure;
      const request = new EventEmitter();
      const response = failure === "body-timeout" ? new Readable({ read() {} })
        : Readable.from([failure === "json" ? "{" : JSON.stringify(isLts ? releases : schedule)]);
      response.statusCode = failure === "http" ? 503 : 200;
      request.destroy = (error) => {
        response.destroy(error);
        request.emit("error", error);
      };
      queueMicrotask(() => {
        if (failure === "network") request.emit("error", new Error("offline"));
        else if (failure !== "timeout") callback(response);
      });
      return request;
    });
  }, { context });
  const module = new SourceTextModule(source, { context });
  await module.link((specifier) => {
    assert.equal(specifier, "https");
    return https;
  });
  await module.evaluate();
  assert.equal(requests.length, 2);
  assert.equal(timers.size, 0);
  return warnings.sort();
}

test("warns for an EOL major even if it had an LTS release", async () => {
  assert.deepEqual(await run(), [eolWarning]);
});

test("retains the non-LTS warning alongside the EOL warning", async () => {
  assert.deepEqual(await run({ releases: [{ version: "v20.1.0", lts: false }] }), [ltsWarning, eolWarning].sort());
});

test("does not warn before or exactly at the EOL timestamp", async () => {
  for (const now of ["2026-04-29T23:59:59Z", "2026-04-30T00:00:00Z"]) {
    assert.deepEqual(await run({ now }), []);
  }
});

test("warns once the EOL timestamp has passed", async () => {
  assert.deepEqual(await run({ now: "2026-04-30T00:00:00.001Z" }), [eolWarning]);
});

test("ignores unknown majors and absent or invalid end dates", async () => {
  for (const schedule of [{}, { v20: {} }, { v20: { end: false } }, { v20: { end: "invalid" } }]) {
    assert.deepEqual(await run({ schedule }), []);
  }
});

for (const failure of ["network", "http", "json", "timeout", "body-timeout"]) {
  test(`EOL advisory survives LTS ${failure} failure`, async () => {
    assert.deepEqual(await run({ ltsFailure: failure }), [eolWarning]);
  });
  test(`LTS advisory survives EOL ${failure} failure`, async () => {
    assert.deepEqual(await run({ releases: [], eolFailure: failure }), [ltsWarning]);
  });
}
