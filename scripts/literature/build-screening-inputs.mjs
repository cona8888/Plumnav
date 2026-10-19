import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "../..");
const sourcePath = path.join(
  projectRoot,
  "research/literature_review_2026/screening/normalized_records.tsv",
);
const pubmedUniquePath = path.join(
  projectRoot,
  "research/literature_review_2026/screening/pubmed_unique_records.tsv",
);
const outputDir = path.join(
  projectRoot,
  "research/literature_review_2026/screening/candidate_inputs",
);

const source = fs.readFileSync(sourcePath, "utf8");
const lines = source.replace(/\r?\n$/, "").split(/\r?\n/);
const header = lines[0].split("\t");
const rows = lines.slice(1).map((line) => {
  const values = line.split("\t");
  if (values.length !== header.length) {
    throw new Error(`Malformed normalized row with ${values.length} fields`);
  }
  return Object.fromEntries(header.map((name, index) => [name, values[index]]));
});

const pubmedRows = fs.existsSync(pubmedUniquePath)
  ? (() => {
      const pubmedSource = fs.readFileSync(pubmedUniquePath, "utf8");
      const pubmedLines = pubmedSource.replace(/\r?\n$/, "").split(/\r?\n/);
      const pubmedHeader = pubmedLines[0].split("\t");
      return pubmedLines.slice(1).map((line) => {
        const values = line.split("\t");
        if (values.length !== pubmedHeader.length) {
          throw new Error(`Malformed PubMed row with ${values.length} fields`);
        }
        return Object.fromEntries(
          pubmedHeader.map((name, index) => [name, values[index]]),
        );
      });
    })()
  : [];

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
];

const strands = {
  E1: new Set(["Q4"]),
  E2: new Set(["Q1", "Q2"]),
  E3: new Set(["Q3", "Q6"]),
  E4: new Set(["Q5"]),
};

fs.mkdirSync(outputDir, { recursive: true });
const outputs = {};

for (const [strand, queryIds] of Object.entries(strands)) {
  const selected = rows.filter((row) => {
    const rowQueries = JSON.parse(row.query_batch_id);
    return rowQueries.some((queryId) => queryIds.has(queryId));
  });
  if (strand === "E1") selected.push(...pubmedRows);
  const body = [
    outputFields.join("\t"),
    ...selected.map((row) => outputFields.map((field) => row[field]).join("\t")),
  ].join("\n") + "\n";
  const filename = `${strand}_title_abstract_input.tsv`;
  fs.writeFileSync(path.join(outputDir, filename), body);
  outputs[strand] = {
    filename,
    record_count: selected.length,
    sha256: crypto.createHash("sha256").update(body).digest("hex"),
    query_ids: strand === "E1" && pubmedRows.length
      ? [...queryIds, "Q4P"]
      : [...queryIds],
  };
}

const manifest = {
  generated_at: new Date().toISOString(),
  source: path.relative(projectRoot, sourcePath),
  source_sha256: crypto.createHash("sha256").update(source).digest("hex"),
  canonical_record_count: rows.length,
  supplemental_pubmed_unique_records: pubmedRows.length,
  combined_unique_record_count: rows.length + pubmedRows.length,
  outputs,
};
fs.writeFileSync(
  path.join(outputDir, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
