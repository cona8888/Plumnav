import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const screeningDir = path.join(projectRoot, "research/literature_review_2026/screening");
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const allowedDecisions = new Set(["include", "exclude", "unclear"]);
const allowedReasons = new Set(Array.from({ length: 10 }, (_, index) => `X${String(index + 1).padStart(2, "0")}`));
const decisionHeader = [
  "raw_record_id", "source_record_id", "doi", "title", "query_batch_id",
  "stage", "decision", "destination_strands", "reason_code", "notes", "reviewer", "review_date",
];

function parseTsv(filePath) {
  const source = fs.readFileSync(filePath, "utf8");
  const lines = source.replace(/\r?\n$/, "").split(/\r?\n/);
  const header = lines[0].split("\t");
  const rows = lines.slice(1).map((line, index) => {
    const values = line.split("\t");
    if (values.length !== header.length) throw new Error(`${filePath}:${index + 2} malformed`);
    return Object.fromEntries(header.map((field, fieldIndex) => [field, values[fieldIndex]]));
  });
  return { source, header, rows };
}

function validateReview(review, input, stage, label) {
  if (review.header.join("\t") !== decisionHeader.join("\t")) {
    throw new Error(`${label} does not use the required header`);
  }
  const inputById = new Map(input.rows.map((row) => [row.raw_record_id, row]));
  const seen = new Set();
  for (const row of review.rows) {
    if (seen.has(row.raw_record_id)) throw new Error(`${label} duplicate ${row.raw_record_id}`);
    seen.add(row.raw_record_id);
    const original = inputById.get(row.raw_record_id);
    if (!original) throw new Error(`${label} unexpected ${row.raw_record_id}`);
    for (const field of ["source_record_id", "doi", "title", "query_batch_id"]) {
      if (row[field] !== original[field]) throw new Error(`${label} metadata mismatch ${row.raw_record_id}:${field}`);
    }
    if (row.stage !== stage || !allowedDecisions.has(row.decision)) {
      throw new Error(`${label} invalid stage/decision ${row.raw_record_id}`);
    }
    let destinations;
    try { destinations = JSON.parse(row.destination_strands || "[]"); } catch { throw new Error(`${label} invalid destination JSON ${row.raw_record_id}`); }
    if (!Array.isArray(destinations) || destinations.some((value) => !["E1", "E2", "E3", "E4"].includes(value))) {
      throw new Error(`${label} invalid destination values ${row.raw_record_id}`);
    }
    if (row.decision === "include" && (!destinations.length || row.reason_code)) {
      throw new Error(`${label} invalid include fields ${row.raw_record_id}`);
    }
    if (row.decision === "exclude" && (!allowedReasons.has(row.reason_code) || row.reason_code === "X07")) {
      throw new Error(`${label} invalid global exclusion ${row.raw_record_id}`);
    }
    if (row.decision === "unclear" && row.reason_code !== "X09") {
      throw new Error(`${label} invalid unclear ${row.raw_record_id}`);
    }
  }
  const missing = [...inputById.keys()].filter((id) => !seen.has(id));
  if (missing.length) throw new Error(`${label} missing ${missing.length} records`);
}

const firstInput = parseTsv(path.join(screeningDir, "cross_strand_reroute_input.tsv"));
const first = parseTsv(path.join(screeningDir, "cross_strand_reroute_review.tsv"));
const secondInput = parseTsv(path.join(screeningDir, "cross_strand_second_review_input.tsv"));
const second = parseTsv(path.join(screeningDir, "cross_strand_second_review.tsv"));
validateReview(first, firstInput, "cross_strand_reroute", "first cross-strand review");
validateReview(second, secondInput, "second_cross_strand_reroute", "second cross-strand review");
const firstById = new Map(first.rows.map((row) => [row.raw_record_id, row]));
const secondById = new Map(second.rows.map((row) => [row.raw_record_id, row]));

const comparisonHeader = [
  "raw_record_id", "source_record_id", "doi", "title", "query_batch_id",
  "first_ai_decision", "second_ai_decision", "first_destination_strands",
  "second_destination_strands", "agreement", "candidate_disposition",
  "first_ai_reviewer", "second_ai_reviewer", "second_ai_reason_code", "second_ai_notes",
];
const comparisons = secondInput.rows.map((inputRow) => {
  const firstRow = firstById.get(inputRow.raw_record_id);
  const secondRow = secondById.get(inputRow.raw_record_id);
  if (!firstRow || !secondRow) throw new Error(`Missing comparison row ${inputRow.raw_record_id}`);
  return {
    raw_record_id: inputRow.raw_record_id,
    source_record_id: inputRow.source_record_id,
    doi: inputRow.doi,
    title: inputRow.title,
    query_batch_id: inputRow.query_batch_id,
    first_ai_decision: firstRow.decision,
    second_ai_decision: secondRow.decision,
    first_destination_strands: firstRow.destination_strands,
    second_destination_strands: secondRow.destination_strands,
    agreement: firstRow.decision === secondRow.decision ? "yes" : "no",
    candidate_disposition: secondRow.decision === "include"
      ? "retain"
      : secondRow.decision === "unclear" ? "retain_unclear" : "ai_conflict",
    first_ai_reviewer: firstRow.reviewer,
    second_ai_reviewer: secondRow.reviewer,
    second_ai_reason_code: secondRow.reason_code,
    second_ai_notes: secondRow.notes,
  };
});
fs.writeFileSync(
  path.join(screeningDir, "cross_strand_reroute_comparison.tsv"),
  `${comparisonHeader.join("\t")}\n${comparisons.map((row) => comparisonHeader.map((field) => row[field]).join("\t")).join("\n")}\n`,
);

const normalized = parseTsv(path.join(screeningDir, "all_sources_normalized_records.tsv"));
const metadataById = new Map(normalized.rows.map((row) => [row.source_record_id, row]));
const humanHeader = [
  "source_record_id", "raw_record_id", "doi", "title", "authors", "publication_year",
  "journal_or_source", "abstract", "language", "document_type", "keywords", "query_batch_id",
  "candidate_strands", "first_ai_decisions", "second_ai_decisions", "second_review_status",
  "human_decision", "human_exclusion_reason", "human_reviewer", "human_review_date", "human_notes",
];
const humanRows = comparisons.map((comparison) => {
  const metadata = metadataById.get(comparison.source_record_id);
  if (!metadata) throw new Error(`Missing normalized metadata ${comparison.source_record_id}`);
  const firstRow = firstById.get(comparison.raw_record_id);
  const secondRow = secondById.get(comparison.raw_record_id);
  const candidateStrands = [...new Set([
    ...JSON.parse(firstRow.destination_strands || "[]"),
    ...JSON.parse(secondRow.destination_strands || "[]"),
  ])].sort();
  return {
    ...Object.fromEntries(humanHeader.map((field) => [field, ""])),
    ...Object.fromEntries([
      "source_record_id", "raw_record_id", "doi", "title", "authors", "publication_year",
      "journal_or_source", "abstract", "language", "document_type", "keywords", "query_batch_id",
    ].map((field) => [field, metadata[field]])),
    candidate_strands: JSON.stringify(candidateStrands),
    first_ai_decisions: JSON.stringify({ reroute: firstRow.decision }),
    second_ai_decisions: JSON.stringify({ reroute: secondRow.decision }),
    second_review_status: comparison.candidate_disposition === "retain"
      ? "second_ai_retain"
      : comparison.candidate_disposition === "retain_unclear"
        ? "second_ai_unclear"
        : "ai_conflict_requires_human",
  };
});
fs.writeFileSync(
  path.join(screeningDir, "cross_strand_human_queue_additions.tsv"),
  `${humanHeader.join("\t")}\n${humanRows.map((row) => humanHeader.map((field) => row[field]).join("\t")).join("\n")}\n`,
);

const counts = (rows, field) => Object.fromEntries(
  ["include", "exclude", "unclear"].map((decision) => [decision, rows.filter((row) => row[field] === decision).length]),
);
const summary = {
  generated_at: new Date().toISOString(),
  stage: "cross_strand_reroute_with_independent_second_ai_review",
  status: "ai_assisted_not_human_eligibility",
  initial_reroute_records: firstInput.rows.length,
  first_review_counts: counts(first.rows, "decision"),
  second_reviewed_records: second.rows.length,
  second_review_counts: counts(second.rows, "decision"),
  agreement_records: comparisons.filter((row) => row.agreement === "yes").length,
  disagreement_records: comparisons.filter((row) => row.agreement === "no").length,
  human_queue_additions: humanRows.length,
  files: {
    first_input_sha256: sha256(firstInput.source),
    first_review_sha256: sha256(first.source),
    second_input_sha256: sha256(secondInput.source),
    second_review_sha256: sha256(second.source),
  },
  caution: "Both decisions are AI candidate routing. Human title/abstract review is required.",
};
fs.writeFileSync(path.join(screeningDir, "cross_strand_reroute_summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
