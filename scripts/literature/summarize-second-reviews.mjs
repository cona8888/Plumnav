import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const screeningDir = path.join(projectRoot, "research/literature_review_2026/screening");
const strands = ["E1", "E2", "E3", "E4"];
const decisionHeader = [
  "raw_record_id",
  "source_record_id",
  "doi",
  "title",
  "query_batch_id",
  "strand",
  "stage",
  "decision",
  "reason_code",
  "notes",
  "reviewer",
  "review_date",
];
const allowedDecisions = new Set(["include", "exclude", "unclear"]);
const allowedReasons = new Set(
  Array.from({ length: 10 }, (_, index) => `X${String(index + 1).padStart(2, "0")}`),
);
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

function parseTsv(filePath) {
  const source = fs.readFileSync(filePath, "utf8");
  const lines = source.replace(/\r?\n$/, "").split(/\r?\n/);
  const header = lines[0].split("\t");
  const rows = lines.slice(1).map((line, index) => {
    const values = line.split("\t");
    if (values.length !== header.length) {
      throw new Error(`${filePath}:${index + 2} has ${values.length} fields; expected ${header.length}`);
    }
    return Object.fromEntries(header.map((field, fieldIndex) => [field, values[fieldIndex]]));
  });
  return { source, header, rows };
}

function validateDecision(row, strand, stage) {
  if (row.strand !== strand || row.stage !== stage) {
    throw new Error(`${strand} invalid strand/stage for ${row.raw_record_id}`);
  }
  if (!allowedDecisions.has(row.decision)) {
    throw new Error(`${strand} invalid decision for ${row.raw_record_id}`);
  }
  if (row.decision === "include" && row.reason_code) {
    throw new Error(`${strand} include has an exclusion reason for ${row.raw_record_id}`);
  }
  if (row.decision === "exclude" && !allowedReasons.has(row.reason_code)) {
    throw new Error(`${strand} exclude lacks a controlled reason for ${row.raw_record_id}`);
  }
  if (row.decision === "unclear" && row.reason_code !== "X09") {
    throw new Error(`${strand} unclear must use X09 for ${row.raw_record_id}`);
  }
}

const comparisonHeader = [
  "raw_record_id",
  "source_record_id",
  "doi",
  "title",
  "query_batch_id",
  "strand",
  "first_ai_decision",
  "second_ai_decision",
  "agreement",
  "candidate_disposition",
  "first_ai_reviewer",
  "second_ai_reviewer",
  "second_ai_reason_code",
  "second_ai_notes",
];
const comparisons = [];
const validation = {};

for (const strand of strands) {
  const firstPath = path.join(screeningDir, `candidate_triage_${strand}.tsv`);
  const inputPath = path.join(screeningDir, `second_review_inputs/${strand}_title_abstract_input.tsv`);
  const secondPath = path.join(screeningDir, `second_candidate_review_${strand}.tsv`);
  for (const requiredPath of [firstPath, inputPath, secondPath]) {
    if (!fs.existsSync(requiredPath)) throw new Error(`Missing required file: ${requiredPath}`);
  }
  const first = parseTsv(firstPath);
  const input = parseTsv(inputPath);
  const second = parseTsv(secondPath);
  if (first.header.join("\t") !== decisionHeader.join("\t")) {
    throw new Error(`${firstPath} does not use the required decision header`);
  }
  if (second.header.join("\t") !== decisionHeader.join("\t")) {
    throw new Error(`${secondPath} does not use the required decision header`);
  }

  const firstById = new Map(first.rows.map((row) => [row.raw_record_id, row]));
  const inputById = new Map(input.rows.map((row) => [row.raw_record_id, row]));
  const seen = new Set();
  for (const row of second.rows) {
    if (seen.has(row.raw_record_id)) throw new Error(`${strand} duplicate second review ${row.raw_record_id}`);
    seen.add(row.raw_record_id);
    const original = inputById.get(row.raw_record_id);
    const firstRow = firstById.get(row.raw_record_id);
    if (!original || !firstRow) throw new Error(`${strand} unexpected second-review record ${row.raw_record_id}`);
    for (const field of ["source_record_id", "doi", "title", "query_batch_id"]) {
      if (row[field] !== original[field]) {
        throw new Error(`${strand} second-review metadata mismatch for ${row.raw_record_id}: ${field}`);
      }
    }
    if (!new Set(["include", "unclear"]).has(firstRow.decision)) {
      throw new Error(`${strand} second review contains a first-pass exclusion: ${row.raw_record_id}`);
    }
    validateDecision(row, strand, "second_candidate_review");
    comparisons.push({
      raw_record_id: row.raw_record_id,
      source_record_id: row.source_record_id,
      doi: row.doi,
      title: row.title,
      query_batch_id: row.query_batch_id,
      strand,
      first_ai_decision: firstRow.decision,
      second_ai_decision: row.decision,
      agreement: firstRow.decision === row.decision ? "yes" : "no",
      candidate_disposition:
        row.decision === "include" ? "retain" : row.decision === "unclear" ? "retain_unclear" : "ai_conflict",
      first_ai_reviewer: firstRow.reviewer,
      second_ai_reviewer: row.reviewer,
      second_ai_reason_code: row.reason_code,
      second_ai_notes: row.notes,
    });
  }
  const missing = [...inputById.keys()].filter((id) => !seen.has(id));
  if (missing.length) throw new Error(`${strand} missing ${missing.length} second-review decisions`);
  validation[strand] = {
    input_records: input.rows.length,
    second_decision_records: second.rows.length,
    input_sha256: sha256(input.source),
    second_decision_sha256: sha256(second.source),
    second_counts: Object.fromEntries(
      [...allowedDecisions].map((decision) => [
        decision,
        second.rows.filter((row) => row.decision === decision).length,
      ]),
    ),
    agreement_records: comparisons.filter(
      (row) => row.strand === strand && row.agreement === "yes",
    ).length,
  };
}

fs.writeFileSync(
  path.join(screeningDir, "second_review_comparison.tsv"),
  `${comparisonHeader.join("\t")}\n${comparisons
    .map((row) => comparisonHeader.map((field) => row[field]).join("\t"))
    .join("\n")}\n`,
);

const normalized = parseTsv(path.join(screeningDir, "all_sources_normalized_records.tsv"));
const metadataBySourceId = new Map(normalized.rows.map((row) => [row.source_record_id, row]));
const grouped = new Map();
for (const row of comparisons) {
  if (!grouped.has(row.source_record_id)) grouped.set(row.source_record_id, []);
  grouped.get(row.source_record_id).push(row);
}

const humanHeader = [
  "source_record_id",
  "raw_record_id",
  "doi",
  "title",
  "authors",
  "publication_year",
  "journal_or_source",
  "abstract",
  "language",
  "document_type",
  "keywords",
  "query_batch_id",
  "candidate_strands",
  "first_ai_decisions",
  "second_ai_decisions",
  "second_review_status",
  "human_decision",
  "human_exclusion_reason",
  "human_reviewer",
  "human_review_date",
  "human_notes",
];
const baseHumanRows = [...grouped.entries()]
  .map(([sourceRecordId, rows]) => {
    const metadata = metadataBySourceId.get(sourceRecordId);
    if (!metadata) throw new Error(`No normalized metadata for ${sourceRecordId}`);
    const status = rows.some((row) => row.second_ai_decision === "include")
      ? "second_ai_retain"
      : rows.some((row) => row.second_ai_decision === "unclear")
        ? "second_ai_unclear"
        : "ai_conflict_requires_human";
    return {
      ...Object.fromEntries(humanHeader.map((field) => [field, ""])),
      ...Object.fromEntries(
        [
          "source_record_id",
          "raw_record_id",
          "doi",
          "title",
          "authors",
          "publication_year",
          "journal_or_source",
          "abstract",
          "language",
          "document_type",
          "keywords",
          "query_batch_id",
        ].map((field) => [field, metadata[field]]),
      ),
      candidate_strands: JSON.stringify(rows.map((row) => row.strand).sort()),
      first_ai_decisions: JSON.stringify(
        Object.fromEntries(rows.sort((a, b) => a.strand.localeCompare(b.strand)).map((row) => [row.strand, row.first_ai_decision])),
      ),
      second_ai_decisions: JSON.stringify(
        Object.fromEntries(rows.sort((a, b) => a.strand.localeCompare(b.strand)).map((row) => [row.strand, row.second_ai_decision])),
      ),
      second_review_status: status,
    };
  });

const additionsPath = path.join(screeningDir, "cross_strand_human_queue_additions.tsv");
const rerouteAdditions = fs.existsSync(additionsPath)
  ? (() => {
      const parsed = parseTsv(additionsPath);
      if (parsed.header.join("\t") !== humanHeader.join("\t")) {
        throw new Error(`${additionsPath} does not use the human-queue header`);
      }
      return parsed.rows;
    })()
  : [];
const baseIds = new Set(baseHumanRows.map((row) => row.source_record_id));
for (const row of rerouteAdditions) {
  if (baseIds.has(row.source_record_id)) {
    throw new Error(`Cross-strand addition duplicates standard queue: ${row.source_record_id}`);
  }
}
const humanRows = [...baseHumanRows, ...rerouteAdditions]
  .sort((a, b) => {
    const order = { ai_conflict_requires_human: 0, second_ai_unclear: 1, second_ai_retain: 2 };
    return order[a.second_review_status] - order[b.second_review_status]
      || a.publication_year.localeCompare(b.publication_year)
      || a.title.localeCompare(b.title);
  });

fs.writeFileSync(
  path.join(screeningDir, "human_screening_queue.tsv"),
  `${humanHeader.join("\t")}\n${humanRows
    .map((row) => humanHeader.map((field) => row[field]).join("\t"))
    .join("\n")}\n`,
);

const patternCounts = {};
for (const row of comparisons) {
  const key = `${row.first_ai_decision}->${row.second_ai_decision}`;
  patternCounts[key] = (patternCounts[key] ?? 0) + 1;
}
const summary = {
  generated_at: new Date().toISOString(),
  stage: "independent_second_ai_candidate_review",
  status: "ai_assisted_not_human_eligibility",
  strand_validation: validation,
  reviewed_strand_decisions: comparisons.length,
  standard_candidate_records: baseHumanRows.length,
  cross_strand_reroute_additions: rerouteAdditions.length,
  unique_records_in_human_queue: humanRows.length,
  agreement_records: comparisons.filter((row) => row.agreement === "yes").length,
  disagreement_records: comparisons.filter((row) => row.agreement === "no").length,
  decision_patterns: patternCounts,
  human_queue_status_counts: Object.fromEntries(
    ["second_ai_retain", "second_ai_unclear", "ai_conflict_requires_human"].map((status) => [
      status,
      humanRows.filter((row) => row.second_review_status === status).length,
    ]),
  ),
  caution:
    "Both passes are AI-assisted candidate review. Every queued record requires an independent human title/abstract decision before PRISMA screening counts or eligibility claims can be reported.",
};
fs.writeFileSync(
  path.join(screeningDir, "second_review_summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
