const BLOCK_RE = /<details[^>]*>\s*<summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/g;
const DIFF_RE = /```diff\n([\s\S]*?)```/;
const PLAIN_FENCE_RE = /```\n([\s\S]*?)```/;
const TEXT_FENCE_RE = /```text\n([\s\S]*?)```/;
const PRE_RE = /<pre>\n?([\s\S]*?)<\/pre>/;
const JOB_LINK_RE = /<code>([^<]+)<\/code>\s*\/\s*<a href="(https:\/\/github\.com\/[^"]+\/actions\/runs\/\d+[^"]*)"><code>([^<]+)<\/code>/;
const PROFILE_LINK_RE = /https:\/\/((?:dev-)?app\.garnet\.ai)\/public\/runs\/(\d+)\?profile=([0-9a-f-]{36})/;
const TREE_LINE_RE = /^([+\- ]) ((?:[│ ] {2})*)(?:[├└]─ )?(.*)$/;
const ACTIONS_RESULTS_RE = /^productionresultssa\d+\.blob\.core\.windows(?:\.net)?$/;

/**
 * @typedef {object} Destination
 * @property {string} destination - Destination as rendered, with `[.]` defanging removed.
 * @property {"added" | "removed" | "unchanged"} change
 * @property {"workload" | "runner background"} origin
 * @property {string[]} chain - Process names from the root to the process that acted.
 * @property {string | null} step - Nearest GitHub step annotation on the chain.
 * @property {string | null} context - The renderer's parenthesised context, e.g. "dns resolver".
 * @property {string | null} noise - Why a change is not review-relevant, or null when it is.
 */

/**
 * @typedef {object} RecordedJob
 * @property {string} workflow
 * @property {string} job
 * @property {string | null} runUrl - null only for a 7.x job whose name the record did not carry.
 * @property {string | null} profileUrl - Public Execution Profile page for the job.
 * @property {string | null} profileJsonUrl - Public JSON twin of that page.
 * @property {Destination[]} destinations
 * @property {{ added: number, removed: number } | null} [delta] - 7.x only: the fold's own delta count.
 * @property {boolean} [trimmed] - 7.x only: the fold kept its count but dropped its tree under the size budget.
 * @property {boolean} [newJob] - The fold marks a job as new in this commit.
 * @property {JobFoldChange[]} [summaryChanges] - Change sentences carried by the job-fold title.
 */

/**
 * @typedef {object} JobFoldChange
 * @property {string[]} [chain]
 * @property {"now reaches" | "no longer reaches" | "reaches"} [verb]
 * @property {string[]} [destinations]
 * @property {number} [more]
 * @property {number} [moreInTree]
 */

/**
 * Split a Runtime Review comment into its recorded jobs and destination rows.
 *
 * Reads only the rendered `diff` tree; the marker counts are reconciled
 * separately by `evaluateConsumerVerdict`.
 *
 * @param {string} body
 * @returns {RecordedJob[] & {unreadable: number, removedJobs?: string[]}}
 */
export function parseRecordedJobs(body) {
  if (hasFinalRuntimeReviewFooter(body)) return parseFinalDesignJobs(body);
  if (isHeadingFirst(body)) return parseHeadingFirstJobs(body);
  const jobs = [];
  let unreadable = 0;
  for (const match of body.matchAll(BLOCK_RE)) {
    const [, summary, content] = match;
    const link = JOB_LINK_RE.exec(summary);
    const tree = readTree(content);
    if (link !== null && tree === null) unreadable += 1;
    if (link === null || tree === null) continue;
    const profile = PROFILE_LINK_RE.exec(content);
    jobs.push({
      workflow: decodeEntities(link[1]),
      job: decodeEntities(link[3]),
      runUrl: decodeEntities(link[2]),
      profileUrl: profile === null ? null : `https://${profile[1]}/public/runs/${profile[2]}?profile=${profile[3]}`,
      profileJsonUrl: profile === null || profile[1] !== "app.garnet.ai" ? null : `https://app.garnet.ai/api/public/runs/${profile[2]}?profile=${profile[3]}`,
      destinations: parseTree(tree),
    });
  }
  return Object.assign(jobs, { unreadable });
}

/**
 * @param {string | null} body
 * @returns {boolean}
 */
export function hasFinalRuntimeReviewFooter(body) {
  return typeof body === "string" && body.includes("Runtime behavior, recorded by Garnet.");
}

function parseFinalDesignJobs(body) {
  const jobs = [];
  let unreadable = 0;
  const tokens = /<details(?:\s+open)?>|<\/details>/g;
  let depth = 0;
  let start = -1;
  for (const match of body.matchAll(tokens)) {
    if (match[0].startsWith("</")) {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        const job = parseFinalDesignJob(body.slice(start, match.index + match[0].length));
        if (job !== null) {
          if (job.unreadable === true) unreadable += 1;
          else if (Array.isArray(job)) jobs.push(...job);
          else jobs.push(job);
        }
        start = -1;
      }
    } else {
      if (depth === 0) start = match.index;
      depth += 1;
    }
  }
  const removedJobs = [...body.matchAll(/^<b>([^<]+)<\/b> · job removed(?: · ran at (?:the PR base|your previous push), not in this commit|<br>&emsp;↳ ran at (?:the PR base|your previous push), not in this commit)(?: ·|$)/gm)]
    .map((match) => decodeEntities(match[1]));
  return Object.assign(jobs, { unreadable, removedJobs });
}

function parseFinalDesignJob(block) {
  const summary = /<summary>([\s\S]*?)<\/summary>/.exec(block)?.[1] ?? "";
  if (/How to read this|Ask your AI reviewer|jobs? not recorded|jobs? not in this commit|^<sub>/i.test(summary)) return null;
  const group = /(\d+) jobs? · nothing new/.exec(summary);
  if (group !== null) {
    const linkedJobs = [...block.matchAll(/<a href="([^"]*)">([^<]+)<\/a> · (\d+) destinations?/g)].map((match) => ({
      workflow: "",
      job: decodeEntities(match[2]),
      runUrl: githubActionsJobUrl(match[1]),
      profileUrl: null,
      profileJsonUrl: null,
      destinations: [],
    }));
    if (linkedJobs.length > 0) return linkedJobs;
    const labels = [...summary.matchAll(/<code>([^<]+)<\/code>/g)].map((match) => decodeEntities(match[1]));
    if (labels.length === 0) {
      labels.push(...[...block.matchAll(/`([^`]+)`/g)].map((match) => decodeEntities(match[1])));
    }
    const runnerFold = findRunnerFold(block);
    const destinations = runnerFold === null ? [] : parseFinalBackground(runnerFold.content);
    return labels.map((label) => ({
      workflow: "",
      job: label,
      runUrl: null,
      profileUrl: null,
      profileJsonUrl: null,
      destinations,
    }));
  }
  const boldLabel = /<b>([^<]*)<\/b>/.exec(summary)?.[1];
  const label = boldLabel ?? summary.split("<br>")[0].replace(/<[^>]*>/g, "");
  const segments = label.split("·").map((part) => part.trim());
  const job = boldLabel === undefined ? segments[0] : segments.at(-1);
  if (job === "" || /Runner, outside your workflow/.test(job)) return null;
  const runnerFold = findRunnerFold(block);
  const main = runnerFold === null ? readTree(block) : readTree(block.slice(0, runnerFold.index));
  let destinations = main === null ? [] : parseTree(main, true);
  if (runnerFold !== null) destinations.push(...parseFinalBackground(runnerFold.content));
  const infrastructureFold = /<summary>github infra in your workflow[^<]*<\/summary>([\s\S]*?)<\/details>/i.exec(block);
  if (infrastructureFold !== null) {
    const text = TEXT_FENCE_RE.exec(infrastructureFold[1]);
    if (text !== null) {
      destinations.push(...parseTree(text[1], true).map((row) => {
        const infraRow = { ...row, context: row.context ?? "github infra" };
        infraRow.noise = noiseReason(infraRow);
        return infraRow;
      }));
    }
  }
  const newJob = /\bnew job\b/i.test(summary) || /^new job\s*·/i.test(label);
  if (newJob) {
    destinations = destinations.map((row) => row.origin === "workload"
      ? { ...row, change: "added" }
      : row);
  }
  const profile = PROFILE_LINK_RE.exec(block);
  const runLog = /<a href="([^"]*)">Job log<\/a>/.exec(block);
  const delta = parseFinalJobDelta(summary);
  const result = {
    workflow: "",
    job,
    runUrl: runLog === null ? null : githubActionsJobUrl(runLog[1]),
    profileUrl: profile === null ? null : `https://${profile[1]}/public/runs/${profile[2]}?profile=${profile[3]}`,
    profileJsonUrl: profile === null || profile[1] !== "app.garnet.ai" ? null : `https://app.garnet.ai/api/public/runs/${profile[2]}?profile=${profile[3]}`,
    destinations,
    delta,
    newJob,
    summaryChanges: parseJobFoldChanges(summary),
  };
  result.unreadable = main === null && result.delta !== null && result.delta.added + result.delta.removed > 0;
  return result;
}

function findRunnerFold(block) {
  const match = /<summary>(?:Runner, outside your workflow|Runner activity outside your workflow|<code>[^<]+<\/code>\s*·\s*runner activity outside your workflow)[^<]*<\/summary>([\s\S]*?)<\/details>/i.exec(block);
  if (match === null) return null;
  return { index: match.index, content: match[1] };
}

function parseFinalJobDelta(summary) {
  const rendered = /<b>[^<]*<\/b>\s*·\s*([+−]\d+(?:\s*−\d+)?)/.exec(summary)?.[1]
    ?? /<b>\s*([+−]\d+(?:\s*−\d+)?)/.exec(summary)?.[1];
  if (rendered === undefined) return null;
  const added = /\+(\d+)/.exec(rendered)?.[1];
  const removed = /−(\d+)/.exec(rendered)?.[1];
  return { added: Number(added ?? 0), removed: Number(removed ?? 0) };
}

function parseJobFoldChanges(summary) {
  const changes = [];
  const lines = summary.split(/<br\s*\/?>/i);
  for (const part of lines.slice(1)) {
    const line = decodeEntities(part).trim().replace(/^↳\s*/, "").trim();
    const moreInTree = /^(\d+) more in the tree$/i.exec(line);
    if (moreInTree !== null) {
      changes.push({ moreInTree: Number(moreInTree[1]) });
      continue;
    }
    const sentence = /^<code>([\s\S]*?)<\/code>(?:\s*›\s*<code>([\s\S]*?)<\/code>)?\s+(now reaches|no longer reaches|reaches)\s+([\s\S]+)$/.exec(line);
    if (sentence === null) continue;
    const destinationsText = sentence[4];
    const destinations = [...destinationsText.matchAll(/<code>([\s\S]*?)<\/code>/g)]
      .map((match) => decodeEntities(match[1]));
    if (destinations.length === 0) continue;
    const remainder = destinationsText.replace(/<code>[\s\S]*?<\/code>/g, "");
    const more = /\band (\d+) more\b/i.exec(decodeEntities(remainder))?.[1];
    changes.push({
      chain: sentence[2] === undefined
        ? [decodeEntities(sentence[1])]
        : [decodeEntities(sentence[1]), decodeEntities(sentence[2])],
      verb: sentence[3],
      destinations,
      ...(more === undefined ? {} : { more: Number(more) }),
    });
  }
  return changes;
}

function githubActionsJobUrl(href) {
  try {
    const url = new URL(decodeEntities(href));
    if (url.protocol !== "https:" || url.hostname !== "github.com") return null;
    if (!/^\/[^/]+\/[^/]+\/actions\/runs\/\d+\/job\/\d+$/.test(url.pathname)) return null;
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

function parseFinalBackground(content) {
  const text = TEXT_FENCE_RE.exec(content.split("\n").map((line) => line.replace(/^> ?/, "")).join("\n"));
  if (text === null) return [];
  const rows = [];
  for (const line of text[1].split("\n")) {
    const match = /^([+-])?[\s│]*[├└]─\s+○\s+(.+)$/.exec(line);
    if (match === null) continue;
    const { text: destination, context } = splitContext(match[2].trim());
    const row = {
      destination,
      change: match[1] === "+" ? "added" : match[1] === "-" ? "removed" : "unchanged",
      origin: "runner background",
      chain: [],
      step: null,
      context,
      noise: null,
    };
    row.noise = noiseReason(row);
    rows.push(row);
  }
  return rows;
}

/**
 * Comparison records render a ```diff block; first snapshots render an HTML
 * `<pre>` tree and older unchanged folds a plain fence, both without change
 * markers. All are normalised to diff lines.
 *
 * @param {string} content
 * @returns {string | null}
 */
function readTree(content) {
  const diff = DIFF_RE.exec(content);
  if (diff !== null) return diff[1];
  const text = TEXT_FENCE_RE.exec(content);
  if (text !== null) return text[1];
  const plain = PLAIN_FENCE_RE.exec(content);
  const pre = plain === null ? PRE_RE.exec(content) : null;
  const tree = plain?.[1] ?? (pre === null ? null : decodeEntities(pre[1].replace(/<[^>]+>/g, "")));
  if (tree === null) return null;
  return tree.split("\n").map((line) => `  ${line}`).join("\n");
}

/**
 * @param {string} diff
 * @returns {Destination[]}
 */
function parseTree(diff, preserveDefanged = false) {
  const destinations = [];
  /** @type {{name: string, step: string | null, background: boolean}[]} */
  const stack = [];
  const levelLengths = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@")) continue;
    const parsed = TREE_LINE_RE.exec(line);
    if (parsed === null || parsed[3].trim() === "") continue;
    const [, marker, indent, rest] = parsed;
    const depth = rest === line.slice(2 + indent.length) && !/^[├└]─ /.test(line.slice(2 + indent.length)) ? 0 : indent.length / 3 + 1;
    stack.length = depth === 0 ? 0 : levelLengths[depth] ?? depth;
    const { text, context } = splitContext(rest);
    if (text.startsWith("○ ")) {
      const rendered = text.slice(2).trim();
      const destination = preserveDefanged ? rendered : undefang(rendered);
      const chain = stack.map((node) => node.name);
      const step = [...stack].reverse().find((node) => node.step !== null)?.step ?? null;
      const origin = stack.some((node) => node.background) ? "runner background" : "workload";
      const change = marker === "+" ? "added" : marker === "-" ? "removed" : "unchanged";
      destinations.push({ destination, change, origin, chain, step, context, noise: noiseReason({ destination, change, origin, context, chain }) });
      continue;
    }
    const stepLine = /^(.*?) · step "(.*)"$/.exec(text);
    const step = stepLine?.[2] ?? /^step: "(.*)"$/.exec(context ?? "")?.[1] ?? null;
    const names = (stepLine?.[1] ?? text).split(/\s+›\s+/).map((name) => name.trim());
    stack.push(...names.map((name, index) => ({
      name,
      step: index === names.length - 1 ? step : null,
      background: /\brunner background\b/.test(context ?? ""),
    })));
    levelLengths.length = depth + 1;
    levelLengths[depth + 1] = stack.length;
  }
  return destinations;
}

/**
 * Explain why a changed destination is runner or platform noise rather than
 * workload behavior. Unchanged rows are never noise; they are not a change.
 *
 * @param {Pick<Destination, "destination" | "change" | "origin" | "context" | "chain">} row
 * @returns {string | null}
 */
export function noiseReason({ destination, change, origin, context, chain }) {
  if (change === "unchanged") return null;
  if (/cloud imds/i.test(context ?? "") || isNonPublicAddress(destination)) return null;
  const host = undefang(destination).split(" ")[0];
  if (origin === "runner background") return "runner background: the runner's infrastructure, not the workflow";
  if (/\bgithub infra\b|\brotated from\b/.test(context ?? "")) return "GitHub infrastructure address rotation";
  if (/\bdns resolver\b/.test(context ?? "")) return "local DNS resolver";
  if (/\bgarnet sensor\b/.test(context ?? "")) return "Garnet sensor traffic";
  if (ACTIONS_RESULTS_RE.test(host) && chain[0] === "Runner.Worker") {
    return "GitHub Actions results-storage shard rotation (Runner.Worker upload), not workflow code";
  }
  return null;
}

function isNonPublicAddress(destination) {
  const normalized = undefang(destination);
  const addresses = [...normalized.matchAll(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/g)].map((match) => match[1]);
  if (addresses.some((address) => {
    const [first, second] = address.split(".").map(Number);
    return first === 10 || first === 127 || first === 169 && second === 254
      || first === 172 && second >= 16 && second <= 31
      || first === 192 && second === 168;
  })) return true;
  return /(?:^|[\s(])(?:fe80:|fc[0-9a-f]{2}:|fd[0-9a-f]{2}:|::1(?:[)\s]|$))/i.test(normalized);
}

/**
 * @param {string} text
 * @returns {{text: string, context: string | null}}
 */
function splitContext(text) {
  const match = /^(.*?)\s+\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*$/.exec(text);
  if (match === null) return { text, context: null };
  if (/^\d{1,3}(?:\.\d{1,3}){3}$|:/.test(match[2]) && match[1].startsWith("○ ")) {
    return { text: `${match[1]} (${match[2]})`, context: null };
  }
  return { text: match[1], context: match[2] };
}

/**
 * @param {string} value
 * @returns {string}
 */
export function undefang(value) {
  return value.replaceAll("[.]", ".");
}

/**
 * @param {string} value
 * @returns {string}
 */
function decodeEntities(value) {
  return value.replaceAll("&amp;", "&").replaceAll("&nbsp;", " ").replaceAll("&emsp;", "\u2003")
    .replaceAll("&ensp;", "\u2002").replaceAll("&lt;", "<").replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&#96;", "`");
}

const SUMMARY_MARKER_RE = /<!--\s*garnet:summary\s+(\{[\s\S]*?\})\s*-->/;
const QUOTE_RE = /^> ?/;
const COUNTED_FOLD_LINE_RE = /^\d+ (?:unchanged|more) destinations?\b/;
const JOB_LINK_RE_G = new RegExp(JOB_LINK_RE.source, "g");

/**
 * A 7.x (heading-first) comment declares its contract in the `garnet:summary` marker.
 *
 * @param {string} body
 * @returns {boolean}
 */
function isHeadingFirst(body) {
  return /^7\./.test(String(readSummaryMarker(body)?.contract ?? ""));
}

/**
 * 7.x job folds: a top-level `<details>` whose body is a blockquote holding the job tree
 * (` ```diff ` for a comparison, `<pre>` for a first record), then nested quoted folds for the
 * counted unchanged destinations and the runner background. Nested folds are quoted, so the
 * top-level `</details>` is the first unquoted one. Big records group jobs: a "N jobs, same
 * change" fold lists the job links in one `<sub>` line over a shared tree, a "N jobs · no runtime
 * change recorded" fold nests one quoted fold per job. Under the size budget (`trimmed: true` in
 * the marker) a job fold keeps its delta count but drops its tree; that is a trimmed job, not an
 * unreadable one.
 *
 * @param {string} body
 * @returns {RecordedJob[]}
 */
function parseHeadingFirstJobs(body) {
  const jobs = [];
  let unreadable = 0;
  const trimmed = readSummaryMarker(body)?.trimmed === true;
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^<details(?: open)?>$/.test(lines[i])) continue;
    let end = lines.indexOf("</details>", i);
    if (end === -1) end = lines.length;
    const block = lines.slice(i + 1, end);
    i = end;
    const summary = block.find((line) => line.startsWith("<summary>")) ?? "";
    const quoted = block.filter((line) => line.startsWith(">")).map((line) => line.replace(QUOTE_RE, ""));
    const { main, folds } = splitQuotedFolds(quoted);
    if (/\bjobs? not in this commit\b/.test(summary)) continue;
    const own = identityOf(summary);
    if (own !== null) {
      const job = readHeadingFirstJob(own, summary, readTree(main.join("\n")), folds, quoted.join("\n"), trimmed);
      if (job === null) unreadable += 1;
      else jobs.push(job);
      continue;
    }
    const sharedTree = readTree(main.join("\n"));
    const nested = folds.filter((fold) => JOB_LINK_RE.test(fold.summary));
    if (nested.length > 0) {
      for (const fold of nested) {
        const unquoted = fold.lines.map((line) => line.replace(QUOTE_RE, ""));
        const inner = splitQuotedFolds(unquoted);
        const job = readHeadingFirstJob(identityOf(fold.summary), fold.summary, readTree(inner.main.join("\n")) ?? sharedTree, inner.folds, unquoted.join("\n"), trimmed);
        if (job === null) unreadable += 1;
        else jobs.push(job);
      }
      continue;
    }
    for (const link of main.join("\n").matchAll(JOB_LINK_RE_G)) {
      const job = readHeadingFirstJob(identityOf(link[0]), summary, sharedTree, [], "", trimmed);
      if (job === null) unreadable += 1;
      else jobs.push(job);
    }
  }
  return Object.assign(jobs, { unreadable });
}

/**
 * A 7.x job fold names its job as `<code>workflow</code> / <a href="run"><code>job</code> ↗</a>`; a job
 * whose name the record did not carry reads `<em>job name not recorded</em>` with no link and still
 * counts as a recorded job (golden 11, a 0-destination record).
 *
 * @param {string} summary
 * @returns {{ workflow: string, job: string, runUrl: string | null } | null}
 */
function identityOf(summary) {
  const link = JOB_LINK_RE.exec(summary);
  if (link !== null) return { workflow: decodeEntities(link[1]), job: decodeEntities(link[3]), runUrl: decodeEntities(link[2]) };
  const unnamed = /<em>(job name not recorded)<\/em>/.exec(summary);
  if (unnamed !== null) return { workflow: "", job: unnamed[1], runUrl: null };
  return null;
}

/**
 * @param {{ workflow: string, job: string, runUrl: string | null }} identity
 * @param {string} summary - The fold's `<summary>` line, carrying the job's `<b>+N −M</b>` delta.
 * @param {string | null} tree
 * @param {{ summary: string, lines: string[] }[]} folds
 * @param {string} content - Where the Execution Profile link lives.
 * @param {boolean} trimmed - The marker's `trimmed` flag: a missing tree is a trimmed job, not an unreadable one.
 * @returns {RecordedJob | null}
 */
function readHeadingFirstJob(identity, summary, tree, folds, content, trimmed) {
  const empty = /·\s*0 destinations<\/summary>/.test(summary);
  if (tree === null && !trimmed && !empty) return null;
  const destinations = tree === null ? [] : foldProcessMoves(parseHeadingFirstTree(tree, "workload"));
  for (const fold of folds) {
    if (/Runner background/.test(fold.summary)) {
      const background = readTree(fold.lines.join("\n"));
      if (background !== null) destinations.push(...parseHeadingFirstTree(background, "runner background"));
      continue;
    }
    const pre = PRE_RE.exec(fold.lines.join("\n"));
    if (pre === null) continue;
    for (const line of decodeEntities(pre[1].replace(/<[^>]+>/g, "")).split("\n")) {
      const listed = /^○ (.+)$/.exec(line.trim());
      if (listed === null) continue;
      const destination = undefang(listed[1].trim());
      if (destinations.some((row) => row.destination === destination && row.origin === "workload")) continue;
      destinations.push({ destination, change: "unchanged", origin: "workload", chain: [], step: null, context: null, noise: null });
    }
  }
  const delta = /<b>(?:\+(\d+))?(?:\s*−(\d+))?<\/b>/.exec(summary);
  const profile = PROFILE_LINK_RE.exec(content);
  return {
    workflow: identity.workflow,
    job: identity.job,
    runUrl: identity.runUrl,
    profileUrl: profile === null ? null : `https://${profile[1]}/public/runs/${profile[2]}?profile=${profile[3]}`,
    profileJsonUrl: profile === null || profile[1] !== "app.garnet.ai" ? null : `https://app.garnet.ai/api/public/runs/${profile[2]}?profile=${profile[3]}`,
    destinations,
    delta: delta === null || (delta[1] === undefined && delta[2] === undefined) ? null : { added: Number(delta[1] ?? 0), removed: Number(delta[2] ?? 0) },
    trimmed: tree === null && !empty,
    newJob: /<b>New job<\/b>/.test(summary),
  };
}

const PROCESS_MOVE = "process changed for a known destination · not counted";

/**
 * 7.x counts by destination identity: a destination that moved to another process renders as a
 * `−`/`+` pair in the job tree but is "not counted" (testbed mockup e). Such a pair is no change
 * of destination; both rows stay, as unchanged, with the move named in their context.
 *
 * @param {Destination[]} destinations
 * @returns {Destination[]}
 */
function foldProcessMoves(destinations) {
  const added = new Map();
  const removed = new Map();
  for (const row of destinations) {
    if (row.origin !== "workload") continue;
    if (row.change === "added") added.set(row.destination, [...(added.get(row.destination) ?? []), row]);
    if (row.change === "removed") removed.set(row.destination, [...(removed.get(row.destination) ?? []), row]);
  }
  for (const [destination, rows] of added) {
    const gone = removed.get(destination) ?? [];
    const pairs = Math.min(rows.length, gone.length);
    for (const row of [...rows.slice(0, pairs), ...gone.slice(0, pairs)]) {
      row.change = "unchanged";
      row.context = PROCESS_MOVE;
      row.noise = null;
    }
  }
  return destinations;
}

/**
 * @param {string} body
 * @returns {Record<string, unknown> | null}
 */
function readSummaryMarker(body) {
  const match = SUMMARY_MARKER_RE.exec(body);
  if (match === null) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

/**
 * @param {string[]} lines - The unquoted body of a 7.x job fold.
 * @returns {{ main: string[], folds: { summary: string, lines: string[] }[] }}
 */
function splitQuotedFolds(lines) {
  const main = [];
  const folds = [];
  let fold = null;
  for (const line of lines) {
    if (fold === null) {
      if (/^<details(?: open)?>$/.test(line)) fold = { summary: "", lines: [] };
      else main.push(line);
      continue;
    }
    if (line === "</details>") {
      folds.push(fold);
      fold = null;
    } else if (line.startsWith("<summary>")) fold.summary = line;
    else fold.lines.push(line);
  }
  return { main, folds };
}

/**
 * 7.x trees carry no `○` leaf mark in the diff form: a destination is a node without children.
 * Process nodes read `name  ▸ step`; the root is the collapsed chain `Runner.Worker › bash`.
 *
 * @param {string} tree
 * @param {"workload" | "runner background"} origin
 * @returns {Destination[]}
 */
function parseHeadingFirstTree(tree, origin) {
  const rows = [];
  for (const line of tree.split("\n")) {
    if (line.startsWith("@@") || line.trim() === "") continue;
    const parsed = TREE_LINE_RE.exec(line);
    if (parsed === null || parsed[3].trim() === "") continue;
    const [, marker, indent, rest] = parsed;
    const depth = rest === line.slice(2 + indent.length) && !/^[├└]─ /.test(line.slice(2 + indent.length)) ? 0 : indent.length / 3 + 1;
    rows.push({ marker, depth, text: rest.trim() });
  }
  const destinations = [];
  /** @type {{names: string[], step: string | null}[]} */
  const stack = [];
  rows.forEach((row, index) => {
    stack.length = row.depth;
    const next = rows[index + 1];
    const leaf = row.depth > 0 && (next === undefined || next.depth <= row.depth);
    if (leaf) {
      if (COUNTED_FOLD_LINE_RE.test(row.text)) return;
      const destination = undefang(row.text.replace(/^○ /, "").trim());
      const chain = stack.flatMap((node) => node.names);
      const step = [...stack].reverse().find((node) => node.step !== null)?.step ?? null;
      const change = row.marker === "+" ? "added" : row.marker === "-" ? "removed" : "unchanged";
      destinations.push({ destination, change, origin, chain, step, context: null, noise: noiseReason({ destination, change, origin, context: null, chain }) });
      return;
    }
    const [name, step] = row.text.split(/\s+▸\s+/, 2);
    stack.push({ names: name.split(" › ").map((part) => part.trim()).filter(Boolean), step: step?.trim() ?? null });
  });
  return destinations;
}
