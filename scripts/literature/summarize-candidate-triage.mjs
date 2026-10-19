import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const screeningDir = path.join(
  projectRoot,
  "research/literature_review_2026/screening",
);
const strands = ["E1", "E2", "E3", "E4"];
const expectedHeader = [
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

const combined = [];
const validation = {};
for (const strand of strands) {
  const inputPath = path.join(
    screeningDir,
    `candidate_inputs/${strand}_title_abstract_input.tsv`,
  );
  const decisionPath = path.join(screeningDir, `candidate_triage_${strand}.tsv`);
  const input = parseTsv(inputPath);
  const decisions = parseTsv(decisionPath);
  if (decisions.header.join("\t") !== expectedHeader.join("\t")) {
    throw new Error(`${decisionPath} does not use the required candidate-triage header`);
  }

  const inputById = new Map(input.rows.map((row) => [row.raw_record_id, row]));
  const seen = new Set();
  for (const row of decisions.rows) {
    if (seen.has(row.raw_record_id)) throw new Error(`${strand} duplicate ${row.raw_record_id}`);
    seen.add(row.raw_record_id);
    const original = inputById.get(row.raw_record_id);
    if (!original) throw new Error(`${strand} extra ${row.raw_record_id}`);
    for (const field of ["source_record_id", "doi", "title", "query_batch_id"]) {
      if (row[field] !== original[field]) {
        throw new Error(`${strand} metadata mismatch for ${row.raw_record_id}: ${field}`);
      }
    }
    if (row.strand !== strand || row.stage !== "candidate_triage") {
      throw new Error(`${strand} invalid strand/stage for ${row.raw_record_id}`);
    }
    if (!allowedDecisions.has(row.decision)) {
      throw new Error(`${strand} invalid decision for ${row.raw_record_id}`);
    }
    if (row.decision === "include" && row.reason_code) {
      throw new Error(`${strand} include has exclusion reason for ${row.raw_record_id}`);
    }
    if (row.decision === "exclude" && !allowedReasons.has(row.reason_code)) {
      throw new Error(`${strand} exclude lacks controlled reason for ${row.raw_record_id}`);
    }
    if (row.decision === "unclear" && row.reason_code !== "X09") {
      throw new Error(`${strand} unclear must use X09 for ${row.raw_record_id}`);
    }
    combined.push(row);
  }
  const missing = [...inputById.keys()].filter((id) => !seen.has(id));
  if (missing.length) throw new Error(`${strand} missing ${missing.length} input records`);
  validation[strand] = {
    input_records: input.rows.length,
    decision_records: decisions.rows.length,
    input_sha256: sha256(input.source),
    decision_sha256: sha256(decisions.source),
    counts: Object.fromEntries(
      [...allowedDecisions].map((decision) => [
        decision,
        decisions.rows.filter((row) => row.decision === decision).length,
      ]),
    ),
  };
}

fs.writeFileSync(
  path.join(screeningDir, "candidate_triage_all_strands.tsv"),
  `${expectedHeader.join("\t")}\n${combined
    .map((row) => expectedHeader.map((field) => row[field]).join("\t"))
    .join("\n")}\n`,
);

const grouped = new Map();
for (const row of combined) {
  if (!grouped.has(row.source_record_id)) grouped.set(row.source_record_id, []);
  grouped.get(row.source_record_id).push(row);
}
const globalHeader = [
  "source_record_id",
  "raw_record_id",
  "doi",
  "title",
  "query_batch_id",
  "global_candidate_decision",
  "candidate_strands",
  "strand_decisions",
  "second_review_required",
];
const globalRows = [...grouped.entries()].map(([sourceRecordId, rows]) => {
  const globalDecision = rows.some((row) => row.decision === "include")
    ? "include"
    : rows.some((row) => row.decision === "unclear")
      ? "unclear"
      : rows.some((row) => row.reason_code === "X07")
        ? "reroute"
        : "exclude";
  const candidateStrands = rows
    .filter((row) => row.decision !== "exclude")
    .map((row) => row.strand)
    .sort();
  return {
    source_record_id: sourceRecordId,
    raw_record_id: rows[0].raw_record_id,
    doi: rows[0].doi,
    title: rows[0].title,
    query_batch_id: rows[0].query_batch_id,
    global_candidate_decision: globalDecision,
    candidate_strands: JSON.stringify(candidateStrands),
    strand_decisions: JSON.stringify(
      Object.fromEntries(rows.sort((a, b) => a.strand.localeCompare(b.strand)).map((row) => [row.strand, row.decision])),
    ),
    second_review_required: globalDecision === "exclude" ? "no" : "yes",
  };
});

const serializeGlobal = (rows) =>
  `${globalHeader.join("\t")}\n${rows
    .map((row) => globalHeader.map((field) => row[field]).join("\t"))
    .join("\n")}\n`;
fs.writeFileSync(
  path.join(screeningDir, "candidate_triage_global.tsv"),
  serializeGlobal(globalRows),
);
fs.writeFileSync(
  path.join(screeningDir, "second_review_queue.tsv"),
  serializeGlobal(globalRows.filter((row) => row.second_review_required === "yes")),
);

const summary = {
  generated_at: new Date().toISOString(),
  stage: "candidate_triage",
  status: "ai_assisted_not_human_eligibility",
  strand_validation: validation,
  strand_decision_rows: combined.length,
  unique_source_records: globalRows.length,
  global_counts: Object.fromEntries(
    ["include", "exclude", "unclear", "reroute"].map((decision) => [
      decision,
      globalRows.filter((row) => row.global_candidate_decision === decision).length,
    ]),
  ),
  second_review_queue_records: globalRows.filter(
    (row) => row.second_review_required === "yes",
  ).length,
  caution:
    "Candidate triage prioritizes records for independent human title/abstract screening; it is not a final inclusion decision or a completed PRISMA screening stage.",
};
fs.writeFileSync(
  path.join(screeningDir, "candidate_triage_summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
