import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const screeningDir = path.join(projectRoot, "research/literature_review_2026/screening");
const outputDir = path.join(screeningDir, "second_review_inputs");
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

function parseTsv(filePath) {
  const source = fs.readFileSync(filePath, "utf8");
  const lines = source.replace(/\r?\n$/, "").split(/\r?\n/);
  const header = lines[0].split("\t");
  const rows = lines.slice(1).map((line, index) => {
    const fields = line.split("\t");
    if (fields.length !== header.length) {
      throw new Error(`${filePath}:${index + 2} malformed`);
    }
    return Object.fromEntries(header.map((field, fieldIndex) => [field, fields[fieldIndex]]));
  });
  return { source, header, rows };
}

fs.mkdirSync(outputDir, { recursive: true });
const outputs = {};
for (const strand of ["E1", "E2", "E3", "E4"]) {
  const decisionPath = path.join(screeningDir, `candidate_triage_${strand}.tsv`);
  if (!fs.existsSync(decisionPath)) continue;
  const input = parseTsv(
    path.join(screeningDir, `candidate_inputs/${strand}_title_abstract_input.tsv`),
  );
  const decisions = parseTsv(decisionPath);
  const candidateIds = new Set(
    decisions.rows
      .filter((row) => row.decision === "include" || row.decision === "unclear")
      .map((row) => row.raw_record_id),
  );
  const selected = input.rows.filter((row) => candidateIds.has(row.raw_record_id));
  if (selected.length !== candidateIds.size) {
    throw new Error(`${strand} candidate/input mismatch`);
  }
  const body = `${input.header.join("\t")}\n${selected
    .map((row) => input.header.map((field) => row[field]).join("\t"))
    .join("\n")}\n`;
  const filename = `${strand}_title_abstract_input.tsv`;
  fs.writeFileSync(path.join(outputDir, filename), body);
  outputs[strand] = {
    filename,
    record_count: selected.length,
    sha256: sha256(body),
    first_pass_decisions_not_exposed: true,
  };
}
const manifest = {
  generated_at: new Date().toISOString(),
  purpose: "independent second AI candidate review; human eligibility review still required",
  outputs,
};
fs.writeFileSync(
  path.join(outputDir, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
