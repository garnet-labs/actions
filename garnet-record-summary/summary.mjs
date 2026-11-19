import { pathToFileURL } from "node:url";

export const BEGIN = "<!-- garnet:record-summary:begin -->";
export const END = "<!-- garnet:record-summary:end -->";
const BLOCK = /^<!-- garnet:record-summary:begin -->\r?\n[\s\S]*?^<!-- garnet:record-summary:end -->[ \t]*\r?$/m;
const AUTHORS = new Set(["garnet-runtime-review[bot]", "garnet-runtime-review-dev[bot]", "garnet-ai[bot]"]);
const SHA = /^[a-f0-9]{40}$/;

function text(html) {
  return html.replace(/<code>([\s\S]*?)<\/code>/g, "`$1`")
    .replace(/<br\s*\/?\s*>/gi, " · ").replace(/<[^>]*>/g, "")
    .replace(/&(?:amp|lt|gt|quot|#39|emsp|nbsp);/g, (entity) => ({
      "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&emsp;": " ", "&nbsp;": " ",
    })[entity]).replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

function short(value, limit = 180) {
  const clean = text(String(value ?? "unknown")).replace(/<!--.*?-->/g, "").replace(/[<>]/g, "");
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

export function selectRecord(comments, head) {
  const matching = comments.filter((comment) => AUTHORS.has(comment.user?.login)
    && typeof comment.body === "string"
    && comment.body.includes("<!-- garnet-runtime-review -->")
    && /<!--\s*garnet-(?:control-plane|action)-pr-comment:v1(?::[a-z0-9.-]+)?\s*-->/.test(comment.body)
    && /<!--\s*garnet:commit\s+([a-f0-9]{40})\s*-->/.exec(comment.body)?.[1] === head);
  const comment = matching.find(({ body }) => body.includes(":v1:app.garnet.ai")) ?? matching[0];
  if (!comment) return null;
  try {
    const summary = JSON.parse(/<!-- garnet:summary (\{.*?\}) -->/.exec(comment.body)?.[1] ?? "null");
    return summary?.status === "finalized" && summary.commit === head ? { comment, summary } : null;
  } catch {
    return null;
  }
}

export function workloadItems(body) {
  const items = [];
  let job = "Recorded job";
  let workload = false;
  let hasSummary = false;
  let diff = false;
  for (const line of body.split("\n")) {
    const summary = /<summary>(.*?)<\/summary>/.exec(line);
    if (summary) {
      job = short(/<b>(.*?)<\/b>/.exec(summary[1])?.[1] ?? "Recorded job", 90);
      const behavior = /(?:↳|&#8618;)[\s\S]*?<\/span>([\s\S]*)/.exec(summary[1])?.[1];
      hasSummary = Boolean(behavior && /now reaches/.test(text(behavior)));
      if (hasSummary) items.push(`${job}: ${short(behavior)}`);
      workload = false;
    }
    if (/<sub>Workload\b/.test(line)) workload = true;
    if (/<sub>Runner\b/.test(line) || /<\/blockquote>/.test(line)) workload = false;
    if (line.startsWith("```")) { diff = !diff && line.startsWith("```diff"); continue; }
    if (workload && diff && !hasSummary && /^\+(?!\+)/.test(line)) {
      const added = short(line.slice(1).replace(/[│├└─]/g, " "));
      if (added) items.push(`${job}: added ${added}`);
    }
  }
  return [...new Set(items)];
}

function profileLinks(body) {
  const urls = [...body.matchAll(/https:\/\/[^\s<>"')]+/g)].map(([url]) => url.replace(/&amp;/g, "&"));
  return [...new Set(urls.filter((url) => {
    try {
      const parsed = new URL(url);
      return ["app.garnet.ai", "app.dev.garnet.ai"].includes(parsed.hostname) && /\/runs\//.test(parsed.pathname);
    } catch { return false; }
  }).map((url) => {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) if (key.startsWith("utm_")) parsed.searchParams.delete(key);
    return parsed.href;
  }))];
}

export function renderBlock({ comment, summary }, head, maxItems = 8) {
  const sha7 = head.slice(0, 7);
  const items = workloadItems(comment.body);
  const scopes = { "pr-base": "PR base", "previous-push": "previous push", "since-push": "previous push" };
  const compared = summary.previous && SHA.test(summary.previous)
    ? `${scopes[summary.scope] ?? short(summary.scope, 40)} \`${summary.previous.slice(0, 7)}\` → \`${sha7}\``
    : "first record, nothing to compare";
  const count = (key) => Number.isSafeInteger(summary[key]) && summary[key] >= 0 ? summary[key] : "unknown";
  const prefix = [BEGIN, `<!-- garnet:record-summary:commit ${head} -->`, `### Garnet record summary · head \`${sha7}\``,
    `${short(summary.line)} · status: finalized · capture: ${short(summary.capture_quality, 40)} · recorded ${short(summary.recorded, 40)}`,
    `Compared: ${compared}`,
    `Jobs: ${count("jobs")} · changed: ${count("changed")} · destinations: +${count("added")} / −${count("removed")}`];
  const links = [`[Garnet comment](${comment.html_url})`, ...profileLinks(comment.body).map((url) => `[Execution Profile](${url})`)];
  let shown = items.slice(0, maxItems);
  function block() {
    return [...prefix, ...(items.length ? shown.map((item) => `- ${item}`) : ["No new workload behavior recorded"]),
      ...(items.length > shown.length ? [`+${items.length - shown.length} more in the Garnet comment`] : []),
      links.join(" · "), `Cite as: Garnet record summary (head \`${sha7}\`)`, END].join("\n");
  }
  while (block().length >= 1200 && shown.length) shown.pop();
  while (block().length >= 1200 && links.length > 2) links.pop();
  return block();
}

export function nextBody(body, record, head, maxItems) {
  const existing = BLOCK.exec(body)?.[0];
  if (!record) {
    if (!existing || existing.includes(`<!-- garnet:record-summary:commit ${head} -->`)) return body;
    return body.replace(BLOCK, () => `${BEGIN}\n<!-- garnet:record-summary:commit ${head} -->\nGarnet record for \`${head.slice(0, 7)}\` not finalized yet\n${END}`);
  }
  const block = renderBlock(record, head, maxItems);
  return existing ? body.replace(BLOCK, () => block) : `${body.trimEnd()}${body.trim() ? "\n\n" : ""}${block}\n`;
}

export async function run(env = process.env, fetcher = fetch, log = console.log) {
  const repo = env.GITHUB_REPOSITORY;
  const number = env.GARNET_PR_NUMBER;
  const token = env.GARNET_GITHUB_TOKEN;
  const maxItems = Number(env.GARNET_MAX_ITEMS ?? "8");
  const publish = env.GARNET_PUBLISH_DRAFT ?? "false";
  if (!token || !/^[\w.-]+\/[\w.-]+$/.test(repo ?? "") || !/^[1-9]\d*$/.test(number ?? "")
    || !Number.isSafeInteger(maxItems) || maxItems < 0 || !["true", "false"].includes(publish)) {
    throw new Error("Valid github-token, repository, pr-number, publish-draft and nonnegative max-items are required");
  }
  async function api(path, options = {}, includeStatus = false) {
    const response = await fetcher(`${env.GITHUB_API_URL ?? "https://api.github.com"}${path}`, {
      ...options, headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) {
      const result = await response.json().catch(() => null);
      const messages = result?.errors?.map((error) => error.message).join("; ") || result?.message;
      throw new Error(`GitHub ${options.method ?? "GET"} ${path}: HTTP ${response.status}${messages ? `: ${messages}` : ""}`);
    }
    const data = await response.json();
    return includeStatus ? { data, status: response.status } : data;
  }
  const path = `/repos/${repo}/pulls/${number}`;
  const pr = await api(path);
  if (pr.state !== "open") { log("PR is not open; nothing to do."); return; }
  const head = pr.head?.sha;
  if (!SHA.test(head ?? "")) throw new Error("PR has no valid head SHA");
  const comments = [];
  for (let page = 1; ; page++) {
    const batch = await api(`/repos/${repo}/issues/${number}/comments?per_page=100&page=${page}`);
    comments.push(...batch);
    if (batch.length < 100) break;
  }
  const record = selectRecord(comments, head);
  const body = nextBody(pr.body ?? "", record, head, maxItems);
  if (!record) log("No trusted finalized summary matching the current head (missing, pending, stale or malformed).");
  const unchanged = body === (pr.body ?? "");
  if (unchanged) {
    log("Description unchanged.");
    if (!record || publish !== "true" || !pr.draft) return;
  }
  if (body.length > 65536) throw new Error("Summary would exceed the PR description limit");
  const current = await api(path);
  if (current.state !== "open" || current.head.sha !== head || current.body !== pr.body) {
    log("PR changed while reading evidence; not writing."); return;
  }
  if (!unchanged) {
    await api(path, { method: "PATCH", body: JSON.stringify({ body }) });
    log(record ? "Wrote finalized current-head summary." : "Replaced stale summary with a not-finalized notice.");
  }
  if (record && publish === "true" && current.draft) {
    try {
      const latest = await api(path);
      if (latest.state !== "open" || latest.head.sha !== head || latest.body !== body || !latest.draft) return;
      const { data: result, status } = await api("/graphql", { method: "POST", body: JSON.stringify({
        query: "mutation($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { pullRequest { isDraft } } }",
        variables: { id: latest.node_id },
      }) }, true);
      if (result?.errors?.length || result?.data?.markPullRequestReadyForReview?.pullRequest?.isDraft !== false) {
        const messages = result?.errors?.map((error) => error.message).join("; ") || "response did not confirm isDraft: false";
        throw new Error(`HTTP ${status}: ${messages}`);
      }
      log("Marked draft ready for review.");
    } catch (error) {
      const message = String(error.message).replaceAll(token, "[REDACTED]")
        .replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
      log(`::warning::GitHub could not mark the PR ready for review: ${message}`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
