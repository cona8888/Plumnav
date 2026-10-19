import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const screeningDir = path.join(projectRoot, "research/literature_review_2026/screening");
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

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

const input = parseTsv(path.join(screeningDir, "cross_strand_reroute_input.tsv"));
const review = parseTsv(path.join(screeningDir, "cross_strand_reroute_review.tsv"));
const inputById = new Map(input.rows.map((row) => [row.raw_record_id, row]));
const selectedIds = new Set(
  review.rows
    .filter((row) => row.decision === "include" || row.decision === "unclear")
    .map((row) => row.raw_record_id),
);
const selected = input.rows.filter((row) => selectedIds.has(row.raw_record_id));
if (selected.length !== selectedIds.size) throw new Error("Cross-strand first review/input mismatch");
for (const row of review.rows) {
  if (!inputById.has(row.raw_record_id)) throw new Error(`Unexpected review record ${row.raw_record_id}`);
}
const body = `${input.header.join("\t")}\n${selected
  .map((row) => input.header.map((field) => row[field]).join("\t"))
  .join("\n")}\n`;
const outputPath = path.join(screeningDir, "cross_strand_second_review_input.tsv");
fs.writeFileSync(outputPath, body);
const manifest = {
  generated_at: new Date().toISOString(),
  purpose: "blinded independent second AI review of cross-strand reroute candidates",
  record_count: selected.length,
  filename: path.basename(outputPath),
  sha256: sha256(body),
  first_pass_decisions_not_exposed: true,
  status: "AI candidate routing; not human eligibility screening",
};
fs.writeFileSync(
  path.join(screeningDir, "cross_strand_second_review_manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
