import { hasFinalRuntimeReviewFooter, parseRecordedJobs } from "./runtime-review-diff.js";

const SUMMARY_RE = /^<!-- garnet:summary (\{.*\}) -->$/m;
const COMMIT_RE = /^<!-- garnet:commit ([0-9a-f]{40}) -->$/m;

const COUNT_FIELDS = [
  "jobs",
  "changed",
  "unchanged",
  "noOutbound",
  "vanished",
  "added",
  "removed",
  "backgroundAdded",
  "backgroundRemoved",
  "vanishedDestinations",
  "chains",
  "destinations",
];

/**
 * @typedef {object} RuntimeReviewParseResult
 * @property {string} contractVersion
 * @property {{headSha: string, comparedSha: string | null, isComparison: boolean}} comparison
 * @property {Record<string, number | null>} counts
 * @property {number | null} findings
 * @property {string[] | null} kinds
 * @property {string | null} recordedAt
 * @property {string | null} capturedAt
 * @property {{ok: boolean, checks: Record<string, object>, errors: string[]}} selfCheck
 */

/**
 * Parse the machine register from a Garnet Runtime Review comment.
 *
 * The marker is the compatibility boundary: unknown future keys are ignored,
 * while the stable fields are normalized and the adjacent human surface is
 * checked for count drift.
 *
 * @param {string} body
 * @returns {RuntimeReviewParseResult}
 */
export function parseRuntimeReviewComment(body) {
  if (typeof body !== "string" || body === "") {
    throw new Error("parseRuntimeReviewComment requires a non-empty comment body");
  }

  const summaryMatch = SUMMARY_RE.exec(body);
  if (summaryMatch === null) {
    throw new Error("Garnet Runtime Review comment has no garnet:summary marker");
  }

  let summary;
  try {
    summary = JSON.parse(summaryMatch[1]);
  } catch (error) {
    throw new Error(`Invalid garnet:summary JSON: ${error.message}`);
  }
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) {
    throw new Error("garnet:summary must contain a JSON object");
  }

  const headSha = requireSha(summary.commit, "commit");
  const comparedSha = summary.previous === null || summary.previous === undefined
    ? null
    : requireSha(summary.previous, "previous");
  const counts = {};
  for (const field of COUNT_FIELDS) {
    counts[field] = normalizeCount(summary[field], field);
  }
  const findings = Number.isInteger(summary.findings) && summary.findings >= 0
    ? summary.findings
    : null;

  const headingFirst = typeof summary.line === "string" && typeof summary.heading === "string";
  const selfCheck = headingFirst
    ? checkHeadingFirst(body, summary)
    : checkRenderedCounts(body, counts, comparedSha !== null);
  const renderedJobs = hasFinalRuntimeReviewFooter(body) ? parseRecordedJobs(body) : null;
  return {
    contractVersion: requireString(summary.contract, "contract"),
    // Contract 7.0 (heading-first): the producer's outcome word, the heading string and the one
    // line every consumer shows verbatim (check title, brief head). Null on 6.x records.
    outcome: headingFirst && typeof summary.outcome === "string" ? summary.outcome : null,
    heading: headingFirst ? summary.heading : null,
    line: headingFirst ? summary.line : null,
    // v6/v7 summary block: one line per changed two-level chain ("+ parent › process → destination"),
    // from the marker when the producer carries them, else read from the ```diff block that sits
    // above the first job fold. Empty on 6.x records and on 7.0 records without a summary block.
    items: headingFirst ? summaryItems(summary, body) : [],
    comparison: {
      headSha,
      comparedSha,
      isComparison: comparedSha !== null,
    },
    counts,
    findings,
    kinds: Array.isArray(summary.kinds)
      ? summary.kinds.filter((kind) => typeof kind === "string")
      : null,
    recordedAt: summary.recorded === null || summary.recorded === undefined
      ? null
      : requireString(summary.recorded, "recorded"),
    capturedAt: summary.recorded === null || summary.recorded === undefined
      ? null
      : requireString(summary.recorded, "recorded"),
    structuralChanges: {
      newJobs: renderedJobs?.filter((job) => job.newJob === true).length ?? 0,
      removedJobs: renderedJobs?.removedJobs?.length ?? 0,
    },
    selfCheck,
  };
}

/**
 * @param {Record<string, unknown>} summary
 * @param {string} body
 * @returns {string[]}
 */
function summaryItems(summary, body) {
  if (Array.isArray(summary.items)) {
    return summary.items.filter((item) => typeof item === "string" && item !== "");
  }
  const top = body.split("<details")[0];
  const fence = /```diff\n([\s\S]*?)\n```/.exec(top);
  if (fence === null) {
    return [];
  }
  return fence[1].split("\n").filter((line) => /^[+-−] /.test(line));
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {number | null}
 */
function normalizeCount(value, field) {
  if (value === null || value === undefined) {
    return null;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`garnet:summary.${field} must be a non-negative integer or null`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
function requireString(value, field) {
  if (typeof value !== "string" || value === "") {
    throw new Error(`garnet:summary.${field} must be a non-empty string`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
function requireSha(value, field) {
  const sha = requireString(value, field);
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`garnet:summary.${field} must be a 40-character lowercase SHA`);
  }
  return sha;
}

/**
 * @param {string} body
 * @param {Record<string, number | null>} counts
 * @param {boolean} isComparison
 * @returns {{ok: boolean, checks: Record<string, object>, errors: string[]}}
 */
/**
 * Contract 7.0 self-check: the marker's heading is the first visible line, the marker's line
 * opens with that heading, and any check title the producer declared is that same line.
 * @param {string} body
 * @param {Record<string, unknown>} summary
 */
function checkHeadingFirst(body, summary) {
  const errors = [];
  const firstVisible = body.split("\n").find((line) => line !== "" && !line.startsWith("<!--")) ?? "";
  const checks = {
    heading: compareCheck(`### ${summary.heading}`, firstVisible, "heading", errors),
    line: compareCheck(true, String(summary.line).startsWith(`${summary.heading} · `), "line opens with the heading", errors),
  };
  // 7.0 markers before the v7 lock declared the check they posted; v7 posts none and omits the field.
  if (summary.check && typeof summary.check === "object") {
    checks.checkTitle = compareCheck(summary.line, summary.check.title ?? null, "check title", errors);
  }
  if (hasFinalRuntimeReviewFooter(body)) {
    const jobs = parseRecordedJobs(body);
    if (jobs.unreadable > 0) {
      checks.renderedChanges = { checked: false, reason: "a changed job fold has no readable tree" };
    } else {
      const expected = { changed: summary.changed, added: summary.added, removed: summary.removed };
      const rendered = { changed: 0, added: 0, removed: 0 };
      const rowTotals = { added: 0, removed: 0 };
      const contractEight = String(summary.contract).startsWith("8.");
      for (const job of jobs) {
        if (contractEight && job.newJob === true) continue;
        const changedRows = job.destinations.filter((row) => row.change !== "unchanged" && row.noise === null);
        const rows = contractEight
          ? [...new Map(changedRows.map((row) => [`${row.change}\u0000${row.destination}`, row])).values()]
          : changedRows;
        const rowDeltas = {
          added: rows.filter((row) => row.change === "added").length,
          removed: rows.filter((row) => row.change === "removed").length,
        };
        if (rows.length > 0) rendered.changed += 1;
        rendered.added += job.delta != null && (!contractEight || job.newJob !== true) ? job.delta.added : rowDeltas.added;
        rendered.removed += job.delta != null && (!contractEight || job.newJob !== true) ? job.delta.removed : rowDeltas.removed;
        rowTotals.added += rowDeltas.added;
        rowTotals.removed += rowDeltas.removed;
      }
      const consistent = expected.changed === rendered.changed
        && expected.added === rendered.added
        && expected.removed === rendered.removed
        && expected.added === rowTotals.added
        && expected.removed === rowTotals.removed;
      checks.renderedChanges = { checked: true, expected, rendered, rowDeltas: rowTotals, ok: consistent };
      if (!consistent) errors.push("rendered changes contradict the marker");
    }
    if (String(summary.contract).startsWith("8.")) {
      const newJobMatch = /(\d+) new jobs?\b/.exec(String(summary.line));
      const removedJobs = jobs.removedJobs?.length ?? 0;
      checks.newJobs = compareOptionalCheck(
        jobs.filter((job) => job.newJob === true).length,
        newJobMatch,
        "new jobs",
        errors,
      );
      if (summary.vanished !== null && summary.vanished !== undefined) {
        checks.removedJobs = compareCheck(summary.vanished, removedJobs, "removed jobs", errors);
      }
    }
  }
  return { ok: errors.length === 0, checks, errors };
}

function checkRenderedCounts(body, counts, isComparison) {
  const checks = {};
  const errors = [];
  const headlineMatch = /\*\*Execution Profiles recorded for (\d+) jobs?\b/.exec(body);
  checks.jobsHeadline = compareCheck(
    counts.jobs,
    headlineMatch === null ? null : Number(headlineMatch[1]),
    "jobs headline",
    errors,
  );

  const snapshotMetaMatch = /> \*(\d+)&nbsp;destinations(?: across (\d+)&nbsp;jobs)?\*/.exec(body);
  if (!isComparison && snapshotMetaMatch !== null) {
    checks.snapshotMeta = compareCheck(
      counts.destinations,
      Number(snapshotMetaMatch[1]),
      "snapshot destinations",
      errors,
    );
    if (snapshotMetaMatch[2] !== undefined && counts.jobs !== null) {
      checks.snapshotMetaJobs = compareCheck(
        counts.jobs,
        Number(snapshotMetaMatch[2]),
        "snapshot metadata jobs",
        errors,
      );
    }
  } else {
    checks.snapshotMeta = {
      checked: false,
      reason: isComparison ? "comparison surface has no run-level destination total" : "destination metadata absent",
    };
  }

  if (isComparison) {
    // The renderer drops zero sides and inflects the unit: `+1&nbsp;−2&nbsp;destinations`,
    // `−1&nbsp;destination`, `+3&nbsp;destinations`.
    const deltaMatches = [...body.matchAll(/(?:\+(\d+)(?:&nbsp;−(\d+))?|−(\d+))&nbsp;destinations?\b/g)];
    const renderedAdded = deltaMatches.reduce((total, match) => total + Number(match[1] ?? 0), 0);
    const renderedRemoved = deltaMatches.reduce((total, match) => total + Number(match[2] ?? match[3] ?? 0), 0);
    checks.added = compareCheck(counts.added, renderedAdded, "added destinations", errors);
    checks.removed = compareCheck(counts.removed, renderedRemoved, "removed destinations", errors);

    const changedMatch = /(\d+)&nbsp;job(?:s)? changed\b/.exec(body);
    const unchangedMatch = /(\d+)&nbsp;job(?:s)? unchanged\b/.exec(body);
    const noOutboundMatch = /(\d+)&nbsp;job(?:s)? with no outbound destinations recorded/.exec(body);
    checks.changed = compareOptionalCheck(counts.changed, changedMatch, "changed jobs", errors);
    checks.unchanged = compareOptionalCheck(counts.unchanged, unchangedMatch, "unchanged jobs", errors);
    checks.noOutbound = compareOptionalCheck(counts.noOutbound, noOutboundMatch, "no-outbound jobs", errors);

    const vanishedMatch = /(\d+)&nbsp;job(?:s)? no longer recorded/.exec(body);
    checks.vanished = compareOptionalCheck(counts.vanished, vanishedMatch, "vanished jobs", errors);
    const vanishedDestinationsMatch = /no longer recorded · \d+ job\(s\) · (\d+) destination/.exec(body);
    checks.vanishedDestinations = compareOptionalCheck(
      counts.vanishedDestinations,
      vanishedDestinationsMatch,
      "vanished destinations",
      errors,
    );
    const currentComparisonDestinations = countCurrentComparisonDestinations(body);
    checks.destinations = compareCheck(
      counts.destinations,
      currentComparisonDestinations,
      "comparison destinations",
      errors,
    );
  } else if (counts.destinations !== null) {
    const snapshotFoldDestinations = countSnapshotFoldDestinations(body);
    if (snapshotFoldDestinations !== null || counts.destinations > 0) {
      checks.destinations = compareCheck(
        counts.destinations,
        snapshotFoldDestinations,
        "snapshot fold destinations",
        errors,
      );
    }
  }

  checks.chains = {
    checked: false,
    reason: "chain counts are machine-register-only and never render on the human surface",
  };
  return { ok: errors.length === 0, checks, errors };
}

/**
 * @param {string} body
 * @returns {number}
 */
function countCurrentComparisonDestinations(body) {
  let total = 0;
  for (const fence of body.matchAll(/```diff\n([\s\S]*?)\n```/g)) {
    for (const line of fence[1].split("\n")) {
      if (/^[ +].*○ /.test(line)) {
        total += 1;
      }
    }
  }
  for (const match of body.matchAll(/<summary>[^<]*.*?· (\d+)&nbsp;destinations · unchanged<\/summary>/g)) {
    total += Number(match[1]);
  }
  return total;
}

/**
 * @param {string} body
 * @returns {number | null}
 */
function countSnapshotFoldDestinations(body) {
  const matches = [...body.matchAll(/<summary>.*?· (\d+)&nbsp;destinations(?:<\/summary>| · unchanged<\/summary>)/g)];
  return matches.length === 0 ? null : matches.reduce((total, match) => total + Number(match[1]), 0);
}

/**
 * @param {number | null} expected
 * @param {number | null} actual
 * @param {string} label
 * @param {string[]} errors
 * @returns {object}
 */
function compareCheck(expected, actual, label, errors) {
  const ok = expected === actual;
  if (!ok) {
    errors.push(`${label} mismatch: marker=${String(expected)}, rendered=${String(actual)}`);
  }
  return { checked: true, expected, rendered: actual, ok };
}

/**
 * @param {number | null} expected
 * @param {RegExpExecArray | null} match
 * @param {string} label
 * @param {string[]} errors
 * @returns {object}
 */
function compareOptionalCheck(expected, match, label, errors) {
  if (expected === null) {
    return { checked: false, reason: `marker field ${label} is null` };
  }
  return compareCheck(expected, match === null && expected === 0 ? 0 : match === null ? null : Number(match[1]), label, errors);
}
