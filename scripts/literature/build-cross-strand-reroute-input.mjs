import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const screeningDir = path.join(projectRoot, "research/literature_review_2026/screening");
const strands = ["E1", "E2", "E3", "E4"];
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

function parseTsv(filePath) {
  const source = fs.readFileSync(filePath, "utf8");
  const lines = source.replace(/\r?\n$/, "").split(/\r?\n/);
  const header = lines[0].split("\t");
  const rows = lines.slice(1).map((line, index) => {
    const values = line.split("\t");
    if (values.length !== header.length) {
      throw new Error(`${filePath}:${index + 2} malformed`);
    }
    return Object.fromEntries(header.map((field, fieldIndex) => [field, values[fieldIndex]]));
  });
  return { source, header, rows };
}

const decisions = strands.flatMap((strand) =>
  parseTsv(path.join(screeningDir, `candidate_triage_${strand}.tsv`)).rows,
);
const grouped = new Map();
for (const row of decisions) {
  if (!grouped.has(row.source_record_id)) grouped.set(row.source_record_id, []);
  grouped.get(row.source_record_id).push(row);
}
const rerouteIds = new Set(
  [...grouped.entries()]
    .filter(([, rows]) =>
      rows.every((row) => row.decision === "exclude")
      && rows.some((row) => row.reason_code === "X07"),
    )
    .map(([sourceRecordId]) => sourceRecordId),
);

const normalized = parseTsv(path.join(screeningDir, "all_sources_normalized_records.tsv"));
const metadataById = new Map(normalized.rows.map((row) => [row.source_record_id, row]));
const outputFields = [
  "raw_record_id",
  "source_record_id",
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
  "origin_strands",
  "origin_reason_codes",
];
const outputRows = [...rerouteIds]
  .map((sourceRecordId) => {
    const metadata = metadataById.get(sourceRecordId);
    if (!metadata) throw new Error(`No metadata for reroute record ${sourceRecordId}`);
    const rows = grouped.get(sourceRecordId);
    return {
      ...metadata,
      origin_strands: JSON.stringify([...new Set(rows.map((row) => row.strand))].sort()),
      origin_reason_codes: JSON.stringify(
        Object.fromEntries(rows.sort((a, b) => a.strand.localeCompare(b.strand)).map((row) => [row.strand, row.reason_code])),
      ),
    };
  })
  .sort((a, b) => a.raw_record_id.localeCompare(b.raw_record_id));

const body = `${outputFields.join("\t")}\n${outputRows
  .map((row) => outputFields.map((field) => row[field]).join("\t"))
  .join("\n")}\n`;
const outputPath = path.join(screeningDir, "cross_strand_reroute_input.tsv");
fs.writeFileSync(outputPath, body);
const manifest = {
  generated_at: new Date().toISOString(),
  purpose: "global-scope review of records excluded only because they were assigned to a different evidence strand",
  record_count: outputRows.length,
  filename: path.basename(outputPath),
  sha256: sha256(body),
  status: "AI candidate routing; not human eligibility screening",
};
fs.writeFileSync(
  path.join(screeningDir, "cross_strand_reroute_manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
