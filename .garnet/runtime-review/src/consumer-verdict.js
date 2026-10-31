import { parseRuntimeReviewComment } from "./parse-runtime-review.js";
import { noiseReason, parseRecordedJobs } from "./runtime-review-diff.js";

const SUMMARY_RE = /^<!-- garnet:summary (\{.*\}) -->$/m;

const VERDICTS = Object.freeze({
  UNCHANGED: "unchanged",
  CHANGED: "changed",
  RECORDED: "recorded",
  UNDETERMINABLE: "undeterminable",
});

/**
 * @typedef {object} ConsumerVerdictRequest
 * @property {string | null} body - The complete Runtime Review comment body, or null when no comment exists.
 * @property {string} expectedHeadSha - The 40-character head SHA the consumer is reviewing.
 */

/**
 * @typedef {object} ConsumerVerdict
 * @property {string} verdict - unchanged | changed | recorded | undeterminable
 * @property {string[]} reasons
 * @property {object | null} record - The normalized parse result when a record was readable.
 * @property {string | null} evidenceSentence - Ready-made grounding line, prefixed per the contract vocabulary.
 * @property {string[]} guidance
 */

/**
 * Apply the fail-closed consumer verdict table to a Runtime Review comment.
 *
 * The table is the one exercised end-to-end by the gate consumer
 * (garnet-labs/posthog #135–#137) and the script consumers
 * (garnet-labs/pnpm #16, garnet-labs/codex #14):
 *
 * - no comment, no marker, unparseable marker      -> undeterminable
 * - marker head differs from the reviewed head     -> undeterminable
 * - marker counts drift from the rendered surface  -> undeterminable
 * - capture is undeclared or a declaration is partial, unknown or not finalized -> undeterminable
 * - previous === null under finalized capture      -> recorded
 * - positive workload delta under finalized best-effort -> changed (escalate, quote the delta)
 * - changed === 0 under finalized best-effort      -> undeterminable
 * - changed === 0 under complete capture           -> unchanged (recorded jobs only)
 *
 * Evidence never approves: "unchanged" is the strongest possible answer and
 * it is scoped to the recorded jobs, never to the whole workflow run.
 *
 * @param {ConsumerVerdictRequest} request
 * @returns {ConsumerVerdict}
 */
export function evaluateConsumerVerdict(request) {
  if (!request || typeof request.expectedHeadSha !== "string" || !/^[0-9a-f]{40}$/.test(request.expectedHeadSha)) {
    throw new Error("evaluateConsumerVerdict requires expectedHeadSha as a 40-character lowercase SHA");
  }
  const expectedHeadSha = request.expectedHeadSha;

  if (typeof request.body !== "string" || request.body === "") {
    return undeterminable(expectedHeadSha, [
      "no Runtime Review comment body was supplied; no record exists for this head",
    ]);
  }

  let record;
  try {
    record = parseRuntimeReviewComment(request.body);
  } catch (error) {
    return undeterminable(expectedHeadSha, [
      `the comment body is not a readable Runtime Review record: ${error.message}`,
    ]);
  }

  const capture = readCaptureFields(request.body);
  const bestEffort = capture.bestEffort;
  record.capture = {
    declared: capture.declared,
    complete: capture.complete,
    reasons: capture.reasons,
  };

  if (record.comparison.headSha !== expectedHeadSha) {
    return undeterminable(expectedHeadSha, [
      `the record is bound to ${record.comparison.headSha}, not the reviewed head ${expectedHeadSha}; a record for another commit is rejected, never reinterpreted`,
    ], record);
  }

  if (capture.declared && !capture.complete && !capture.bestEffort) {
    return undeterminable(expectedHeadSha, capture.reasons, record);
  }
  if (!capture.declared) {
    return undeterminable(expectedHeadSha, [
      "capture completeness is not declared in the marker; the recorded counts cannot support a claim",
    ], record);
  }

  if (!record.selfCheck.ok) {
    if (record.selfCheck.errors.includes("rendered changes contradict the marker")) {
      return undeterminable(expectedHeadSha, ["rendered changes contradict the marker"], record);
    }
    return undeterminable(expectedHeadSha, [
      "marker counts do not reconcile with the rendered surface: " + record.selfCheck.errors.join("; "),
    ], record);
  }

  const sha7 = expectedHeadSha.slice(0, 7);
  if (!record.comparison.isComparison) {
    return {
      verdict: VERDICTS.RECORDED,
      reasons: ["first snapshot: previous is null, so no comparison exists and no change claim is possible"],
      record,
      evidenceSentence:
        `Runtime evidence (Garnet, head ${sha7}): first Execution Profile snapshot — ` +
        `${countText(record.counts.jobs, "job")} recorded, no previous commit to compare against.`,
      guidance: [
        "A snapshot never clears anything: with no baseline there is no change claim in either direction.",
      ],
    };
  }

  if (record.counts.changed === null) {
    return undeterminable(expectedHeadSha, [
      "the marker claims a comparison but carries no changed count",
    ], record);
  }

  const structuralChanges = record.structuralChanges ?? { newJobs: 0, removedJobs: 0 };
  const structuralDelta = [
    ...(structuralChanges.newJobs > 0 ? [countText(structuralChanges.newJobs, "new job")] : []),
    ...(structuralChanges.removedJobs > 0 ? [countText(structuralChanges.removedJobs, "removed job")] : []),
  ].join(", ");
  const hasWorkloadDelta = structuralDelta !== "" || (!capture.complete && parseRecordedJobs(request.body).some((job) =>
    (job.trimmed === true && job.delta != null && job.delta.added + job.delta.removed > 0)
    || job.destinations.some((row) =>
      row.origin === "workload" && row.change !== "unchanged" && noiseReason(row) === null))
    || record.items.some((item) => /^[+-]\s/.test(item)));
  if (
    (capture.complete && (record.counts.changed > 0 || structuralDelta !== ""))
    || (!capture.complete && hasWorkloadDelta)
  ) {
    const delta = record.counts.changed > 0 ? deltaText(record.counts) : structuralDelta;
    const reason = record.counts.changed > 0
      ? `${countText(record.counts.changed, "recorded job")} changed against ${record.comparison.comparedSha.slice(0, 7)}: ${delta}`
      : `the recorded job set changed against ${record.comparison.comparedSha.slice(0, 7)}: ${structuralDelta}`;
    return {
      verdict: VERDICTS.CHANGED,
      reasons: [reason],
      record,
      evidenceSentence:
        `Runtime evidence (Garnet, head ${sha7}): behavior changed against ` +
        `${record.comparison.comparedSha.slice(0, 7)} — ${delta}. Escalate quoting the delta; read the ` +
        "rendered diff to attribute each destination to its execution chain.",
      guidance: [
        "Escalate to a human or full review, quoting the workload delta. Never suppress a changed verdict.",
      ],
    };
  }

  if (bestEffort) {
    return undeterminable(expectedHeadSha, capture.reasons, record);
  }

  return {
    verdict: VERDICTS.UNCHANGED,
    reasons: [
      `0 recorded jobs changed against ${record.comparison.comparedSha.slice(0, 7)} across ${countText(record.counts.jobs, "recorded job")}`,
    ],
    record,
    evidenceSentence:
      `Runtime evidence (Garnet, head ${sha7}): no recorded job changed against ` +
      `${record.comparison.comparedSha.slice(0, 7)}. Scope: the recorded jobs only — unrecorded jobs are ` +
      "unobserved, not known-clean.",
    guidance: [
      "Unchanged is scoped to the recorded jobs. Never claim true k-of-n coverage or extend it to unrecorded jobs.",
      "Evidence never approves: a gate may clear at most one named deterministic deny on this verdict, nothing more.",
    ],
  };
}

/**
 * Read forward-compatible capture-quality fields straight from the marker.
 *
 * A declared status or quality must be paired with its counterpart. Finalized
 * best-effort capture supports positive changes and first snapshots, not zero-change claims.
 *
 * @param {string} body
 * @returns {{declared: boolean, complete: boolean, bestEffort: boolean, reasons: string[]}}
 */
function readCaptureFields(body) {
  const match = SUMMARY_RE.exec(body);
  if (match === null) {
    return { declared: false, complete: false, reasons: [] };
  }
  let summary;
  try {
    summary = JSON.parse(match[1]);
  } catch {
    return { declared: false, complete: false, reasons: [] };
  }
  const status = summary.status;
  const captureQuality = summary.capture_quality;
  // A producer that cannot name the capture quality writes "not-declared" in the key (testbed
  // comment.captureDeclaration); that is no declaration, the same as an absent key — unless the
  // status says the record is not finalized, which is a declaration that must fail closed.
  if (status === undefined && captureQuality === undefined) {
    return { declared: false, complete: false, bestEffort: false, reasons: [] };
  }
  if (captureQuality === "not-declared" && (status === undefined || status === "finalized")) {
    return { declared: false, complete: false, bestEffort: false, reasons: [] };
  }
  const reasons = [];
  if (status === undefined) {
    reasons.push("marker declares capture_quality but not status; a partial capture declaration fails closed");
  } else if (status !== "finalized") {
    reasons.push(`marker status is ${JSON.stringify(status)}, not "finalized"`);
  }
  if (captureQuality === undefined) {
    reasons.push("marker declares status but not capture_quality; a partial capture declaration fails closed");
  } else if (captureQuality !== "complete") {
    reasons.push(`marker capture_quality is ${JSON.stringify(captureQuality)}, not "complete"`);
  }
  const bestEffort = status === "finalized" && captureQuality === "best-effort";
  return { declared: true, complete: reasons.length === 0 && !bestEffort, bestEffort, reasons };
}

/**
 * @param {Record<string, number | null>} counts
 * @returns {string}
 */
function deltaText(counts) {
  const parts = [];
  parts.push(`+${counts.added ?? 0} −${counts.removed ?? 0} workload destinations`);
  if (counts.backgroundAdded !== null || counts.backgroundRemoved !== null) {
    parts.push(`+${counts.backgroundAdded ?? 0} −${counts.backgroundRemoved ?? 0} runner-background destinations`);
  }
  return parts.join(", ");
}

/**
 * @param {number | null} count
 * @param {string} noun
 * @returns {string}
 */
function countText(count, noun) {
  if (count === null) {
    return `an unstated number of ${noun}s`;
  }
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * @param {string} expectedHeadSha
 * @param {string[]} reasons
 * @param {object | null} [record]
 * @returns {ConsumerVerdict}
 */
function undeterminable(expectedHeadSha, reasons, record) {
  return {
    verdict: VERDICTS.UNDETERMINABLE,
    reasons,
    record: record === undefined ? null : record,
    evidenceSentence:
      `Runtime evidence (Garnet, head ${expectedHeadSha.slice(0, 7)}): undeterminable — ` +
      (record?.comparison?.headSha === expectedHeadSha
        ? "the record for this head cannot support a change claim either way. "
        : "no record is bound to this head. ") +
      "The honest answer is \"undeterminable\", never \"no change\".",
    guidance: [
      "Fail closed: clear nothing, approve nothing, and say \"undeterminable\" rather than inferring absence of change.",
    ],
  };
}
