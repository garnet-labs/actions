import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BEGIN, END, selectRecord, renderBlock, nextBody, workloadItems, run } from "../summary.mjs";

const fixture = JSON.parse(readFileSync(new URL("./litellm-141.json", import.meta.url), "utf8"));
const head = "07b85c1a22d1cefd44e52adc91a28a81ccd78495";
const old = "a".repeat(40);
const record = selectRecord([fixture], head);

test("real finalized changed fixture produces a short workload-only summary", () => {
  const block = renderBlock(record, head);
  assert.ok(block.length < 1200, block.length);
  assert.match(block, /python3.12` now reaches `example\[\.\]com/);
  assert.match(block, /Dependency install and test \/ Install and test/);
  assert.match(block, /status: finalized · capture: best-effort/);
  assert.match(block, /Compared: PR base `ea98442` → `07b85c1`/);
  assert.match(block, /Execution Profile/);
  assert.doesNotMatch(block, /169\[\.\]254|<details>|```|systemd/);
});

test("unchanged first record has no invented new behavior", () => {
  const unchanged = { comment: { ...fixture, body: "" }, summary: { ...record.summary, previous: null, changed: 0, added: 0 } };
  const block = renderBlock(unchanged, head);
  assert.match(block, /first record, nothing to compare/);
  assert.match(block, /No new workload behavior recorded/);
});

test("rejects non-finalized, stale, malformed, untrusted and unowned evidence", () => {
  for (const comment of [
    { ...fixture, body: fixture.body.replace('"status":"finalized"', '"status":"recording"') },
    { ...fixture, body: fixture.body.replace(`"commit":"${head}"`, `"commit":"${old}"`) },
    { ...fixture, body: fixture.body.replace(`garnet:commit ${head}`, `garnet:commit ${old}`) },
    { ...fixture, user: { login: "attacker[bot]" } },
    { ...fixture, body: fixture.body.replace("garnet-control-plane-pr-comment:v1:app.garnet.ai", "unowned") },
    { ...fixture, body: fixture.body.replace('"contract":', '"contract"!') },
  ]) assert.equal(selectRecord([comment], head), null);
  assert.equal(selectRecord([], head), null);
});

test("prefers production comment", () => {
  const dev = { ...fixture, body: fixture.body.replace(":v1:app.garnet.ai", ":v1:dev.garnet.ai") };
  assert.equal(selectRecord([dev, fixture], head).comment, fixture);
});

test("idempotent rerun and replacement preserve surrounding description", () => {
  const body = nextBody("Human description", record, head, 8);
  assert.equal(nextBody(body, record, head, 8), body);
  const previous = `Before\n${BEGIN}\n### Garnet record summary · head \`${old.slice(0, 7)}\`\n${END}\nAfter`;
  const replaced = nextBody(previous, record, head, 8);
  assert.ok(replaced.startsWith("Before\n"));
  assert.ok(replaced.endsWith("\nAfter"));
  assert.equal(replaced.split(BEGIN).length, 2);
  assert.doesNotMatch(replaced, /aaaaaaa/);
  assert.match(nextBody(previous, null, head, 8), /record for `07b85c1` not finalized yet/);
  assert.equal(nextBody("Human description", null, head, 8), "Human description");
});

test("workload diff fallback excludes runner additions and honors truncation", () => {
  const body = '<summary><b>Job</b></summary>\n<sub>Workload diff</sub>\n```diff\n+ └─ one.example\n+ └─ two.example\n```\n<sub>Runner &amp; GitHub</sub>\n```diff\n+ └─ infra.example\n```';
  assert.deepEqual(workloadItems(body), ["Job: added one.example", "Job: added two.example"]);
  const block = renderBlock({ ...record, comment: { ...fixture, body } }, head, 1);
  assert.match(block, /\+1 more in the Garnet comment/);
  assert.doesNotMatch(block, /infra.example|two.example/);
});

const env = { GITHUB_REPOSITORY: "garnet-labs/actions", GARNET_GITHUB_TOKEN: "test-token", GARNET_PR_NUMBER: "1" };

function mockAPI(pr, comments = [fixture], options = {}) {
  const calls = [];
  async function fetcher(url, init) {
    const path = new URL(url).pathname;
    calls.push({ path, ...init });
    if (options.fail) return { ok: false, status: 403 };
    let value = pr;
    if (path.endsWith("/comments")) value = comments;
    if (init.method === "PATCH") {
      Object.assign(pr, JSON.parse(init.body));
      value = pr;
    }
    if (path === "/graphql") value = options.graphqlError ? { errors: [{ message: "denied" }] }
      : { data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } };
    return { ok: true, json: async () => structuredClone(value) };
  }
  return { calls, fetcher };
}

test("writes once, publishes only when requested, rerun is read-only", async () => {
  const pr = { state: "open", head: { sha: head }, body: "Human", draft: true, node_id: "PR_node" };
  const api = mockAPI(pr);
  await run({ ...env, GARNET_PUBLISH_DRAFT: "true" }, api.fetcher, () => {});
  assert.equal(api.calls.filter((c) => c.method === "PATCH").length, 1);
  assert.equal(api.calls.filter((c) => c.path === "/graphql").length, 1);
  const before = api.calls.length;
  await run({ ...env, GARNET_PUBLISH_DRAFT: "true" }, api.fetcher, () => {});
  assert.ok(api.calls.slice(before).every((c) => !c.method));
});

test("closed, missing and pending records do not write or publish", async () => {
  for (const state of ["closed", "open"]) {
    const api = mockAPI({ state, head: { sha: head }, body: "Human", draft: true }, []);
    await run({ ...env, GARNET_PUBLISH_DRAFT: "true" }, api.fetcher, () => {});
    assert.ok(api.calls.every((c) => !c.method));
  }
});

test("pending new head replaces stale block without publishing", async () => {
  const pending = { ...fixture, body: fixture.body.replace('"status":"finalized"', '"status":"pending"') };
  const pr = { state: "open", head: { sha: head }, body: `${BEGIN}\nold head\n${END}`, draft: true };
  const api = mockAPI(pr, [pending]);
  await run({ ...env, GARNET_PUBLISH_DRAFT: "true" }, api.fetcher, () => {});
  assert.match(pr.body, /record for `07b85c1` not finalized yet/);
  assert.equal(api.calls.filter((c) => c.method === "PATCH").length, 1);
  assert.ok(api.calls.every((c) => c.path !== "/graphql"));
});

test("publication defaults off even for drafts", async () => {
  const api = mockAPI({ state: "open", head: { sha: head }, body: "", draft: true });
  await run(env, api.fetcher, () => {});
  assert.equal(api.calls.filter((c) => c.method === "PATCH").length, 1);
  assert.ok(api.calls.every((c) => c.path !== "/graphql"));
});

test("API failures and GraphQL failures surface without exposing tokens", async () => {
  const pr = { state: "open", head: { sha: head }, body: "", draft: true };
  await assert.rejects(run(env, mockAPI(pr, [], { fail: true }).fetcher), /403/);
  await assert.rejects(run({ ...env, GARNET_PUBLISH_DRAFT: "true" }, mockAPI(pr, [fixture], { graphqlError: true }).fetcher, () => {}), /could not mark/);
  await assert.rejects(run({ ...env, GARNET_MAX_ITEMS: "NaN" }), /Valid/);
});

test("concurrent head or body changes prevent a stale write", async () => {
  const pr = { state: "open", head: { sha: head }, body: "Human", draft: false };
  const api = mockAPI(pr);
  let reads = 0;
  await run(env, async (url, init) => {
    if (new URL(url).pathname.endsWith("/pulls/1") && ++reads === 2) pr.head.sha = old;
    return api.fetcher(url, init);
  }, () => {});
  assert.ok(api.calls.every((c) => !c.method));
});
