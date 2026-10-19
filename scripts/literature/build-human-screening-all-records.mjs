import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const screeningDir = path.join(projectRoot, "research/literature_review_2026/screening");

function parseTsv(filePath) {
  const source = fs.readFileSync(filePath, "utf8");
  const lines = source.replace(/\r?\n$/, "").split(/\r?\n/);
  const header = lines[0].split("\t");
  const rows = lines.slice(1).map((line, index) => {
    const values = line.split("\t");
    if (values.length !== header.length) throw new Error(`${filePath}:${index + 2} malformed`);
    return Object.fromEntries(header.map((field, fieldIndex) => [field, values[fieldIndex]]));
  });
  return { header, rows };
}

const normalized = parseTsv(path.join(screeningDir, "all_sources_normalized_records.tsv"));
const global = parseTsv(path.join(screeningDir, "candidate_triage_global.tsv"));
const standard = parseTsv(path.join(screeningDir, "second_review_comparison.tsv"));
const rerouteFirst = parseTsv(path.join(screeningDir, "cross_strand_reroute_review.tsv"));
const rerouteSecond = parseTsv(path.join(screeningDir, "cross_strand_reroute_comparison.tsv"));
const globalById = new Map(global.rows.map((row) => [row.source_record_id, row]));

function groupBySource(rows) {
  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.source_record_id)) grouped.set(row.source_record_id, []);
    grouped.get(row.source_record_id).push(row);
  }
  return grouped;
}
const standardById = groupBySource(standard.rows);
const rerouteFirstById = groupBySource(rerouteFirst.rows);
const rerouteSecondById = groupBySource(rerouteSecond.rows);

const outputHeader = [
  "source_record_id", "raw_record_id", "doi", "title", "authors", "publication_year",
  "journal_or_source", "abstract", "language", "document_type", "keywords", "query_batch_id",
  "global_ai_candidate_decision", "candidate_strands", "first_ai_details", "second_ai_details",
  "ai_priority_status", "human_decision", "human_exclusion_reason", "human_reviewer",
  "human_review_date", "human_notes",
];

const rows = normalized.rows.map((metadata) => {
  const globalRow = globalById.get(metadata.source_record_id);
  if (!globalRow) throw new Error(`Missing global candidate row ${metadata.source_record_id}`);
  const standardRows = standardById.get(metadata.source_record_id) ?? [];
  const firstRerouteRows = rerouteFirstById.get(metadata.source_record_id) ?? [];
  const secondRerouteRows = rerouteSecondById.get(metadata.source_record_id) ?? [];
  let aiStatus;
  let firstDetails;
  let secondDetails;
  if (standardRows.length) {
    aiStatus = standardRows.some((row) => row.second_ai_decision === "include")
      ? "second_ai_retain"
      : standardRows.some((row) => row.second_ai_decision === "unclear")
        ? "second_ai_unclear"
        : "ai_conflict_requires_human";
    firstDetails = JSON.stringify(Object.fromEntries(standardRows.map((row) => [row.strand, row.first_ai_decision])));
    secondDetails = JSON.stringify(Object.fromEntries(standardRows.map((row) => [row.strand, row.second_ai_decision])));
  } else if (secondRerouteRows.length) {
    const row = secondRerouteRows[0];
    aiStatus = row.second_ai_decision === "include"
      ? "second_ai_retain_after_reroute"
      : row.second_ai_decision === "unclear"
        ? "second_ai_unclear_after_reroute"
        : "ai_conflict_requires_human";
    firstDetails = JSON.stringify({ reroute: row.first_ai_decision });
    secondDetails = JSON.stringify({ reroute: row.second_ai_decision });
  } else if (firstRerouteRows.length) {
    const row = firstRerouteRows[0];
    if (row.decision !== "exclude") throw new Error(`Unreviewed retained reroute record ${metadata.source_record_id}`);
    aiStatus = "cross_strand_ai_exclude_no_second";
    firstDetails = JSON.stringify({ reroute: row.decision, reason_code: row.reason_code });
    secondDetails = "{}";
  } else {
    if (globalRow.global_candidate_decision !== "exclude") {
      throw new Error(`Candidate lacks second review ${metadata.source_record_id}`);
    }
    aiStatus = "first_ai_exclude_no_second";
    firstDetails = globalRow.strand_decisions;
    secondDetails = "{}";
  }
  return {
    ...Object.fromEntries(outputHeader.map((field) => [field, ""])),
    ...Object.fromEntries([
      "source_record_id", "raw_record_id", "doi", "title", "authors", "publication_year",
      "journal_or_source", "abstract", "language", "document_type", "keywords", "query_batch_id",
    ].map((field) => [field, metadata[field]])),
    global_ai_candidate_decision: globalRow.global_candidate_decision,
    candidate_strands: globalRow.candidate_strands,
    first_ai_details: firstDetails,
    second_ai_details: secondDetails,
    ai_priority_status: aiStatus,
  };
});

const priority = {
  ai_conflict_requires_human: 0,
  second_ai_unclear: 1,
  second_ai_unclear_after_reroute: 1,
  second_ai_retain_after_reroute: 2,
  second_ai_retain: 2,
  cross_strand_ai_exclude_no_second: 3,
  first_ai_exclude_no_second: 4,
};
rows.sort((a, b) => priority[a.ai_priority_status] - priority[b.ai_priority_status]
  || b.publication_year.localeCompare(a.publication_year)
  || a.title.localeCompare(b.title));

fs.writeFileSync(
  path.join(screeningDir, "human_screening_all_records.tsv"),
  `${outputHeader.join("\t")}\n${rows.map((row) => outputHeader.map((field) => row[field]).join("\t")).join("\n")}\n`,
);
const statusCounts = Object.fromEntries(
  [...new Set(rows.map((row) => row.ai_priority_status))]
    .sort()
    .map((status) => [status, rows.filter((row) => row.ai_priority_status === status).length]),
);
const summary = {
  generated_at: new Date().toISOString(),
  total_unique_records: rows.length,
  human_decisions_completed: rows.filter((row) => row.human_decision).length,
  ai_priority_status_counts: statusCounts,
  purpose: "complete human title/abstract screening ledger; AI fields are prioritization aids only",
  caution: "Every record requires a recorded human decision before this ledger can support final eligibility or PRISMA screening counts.",
};
fs.writeFileSync(path.join(screeningDir, "human_screening_all_records_summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
