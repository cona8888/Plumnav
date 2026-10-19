import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "../..");
const reviewRoot = path.join(projectRoot, "research/literature_review_2026");
const rawDir = path.join(reviewRoot, "raw/pubmed/Q4_2026-08-26_batch01");
const searchPath = path.join(rawDir, "esearch.json");
const nbibPath = path.join(rawDir, "savedrecs.nbib");
const wosPath = path.join(reviewRoot, "screening/normalized_records.tsv");
const normalizedPath = path.join(reviewRoot, "screening/pubmed_normalized_records.tsv");
const uniquePath = path.join(reviewRoot, "screening/pubmed_unique_records.tsv");
const duplicatePath = path.join(reviewRoot, "screening/pubmed_duplicate_map.tsv");
const allSourcesPath = path.join(reviewRoot, "screening/all_sources_normalized_records.tsv");
const summaryPath = path.join(reviewRoot, "screening/pubmed_normalization_summary.json");

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const clean = (value = "") =>
  String(value).replace(/[\t\r\n]+/g, " ").replace(/\s+/g, " ").trim();
const normalizeDoi = (value = "") =>
  clean(value)
    .toLowerCase()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//, "")
    .replace(/^doi:\s*/, "")
    .replace(/[.,;]+$/, "");
const normalizeTitle = (value = "") =>
  clean(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const firstAuthorKey = (authors = []) =>
  clean(authors[0] ?? "").toLowerCase().split(/[ ,]/)[0];

function parseTsv(source) {
  const lines = source.replace(/\r?\n$/, "").split(/\r?\n/);
  const header = lines[0].split("\t");
  return {
    header,
    rows: lines.slice(1).map((line, rowIndex) => {
      const fields = line.split("\t");
      if (fields.length !== header.length) {
        throw new Error(`Malformed TSV row ${rowIndex + 2}: ${fields.length} fields`);
      }
      return Object.fromEntries(header.map((name, index) => [name, fields[index]]));
    }),
  };
}

function parseMedline(source) {
  const records = [];
  let current = null;
  let lastTag = null;
  for (const line of source.split(/\r?\n/)) {
    const tagged = line.match(/^([A-Z0-9]{2,4})\s*-\s?(.*)$/);
    if (tagged) {
      const [, tag, value] = tagged;
      if (tag === "PMID") {
        if (current) records.push(current);
        current = {};
      }
      if (!current) continue;
      current[tag] ??= [];
      current[tag].push(value);
      lastTag = tag;
      continue;
    }
    const continuation = line.match(/^\s{6}(.*)$/);
    if (continuation && current && lastTag) {
      const values = current[lastTag];
      values[values.length - 1] = `${values[values.length - 1]} ${continuation[1]}`;
    }
  }
  if (current) records.push(current);
  return records;
}

const searchBytes = fs.readFileSync(searchPath);
const nbibBytes = fs.readFileSync(nbibPath);
const search = JSON.parse(searchBytes.toString("utf8"));
const expectedCount = Number(search.esearchresult.count);
const medlineRecords = parseMedline(nbibBytes.toString("utf8"));
if (medlineRecords.length !== expectedCount) {
  throw new Error(`PubMed record mismatch: expected ${expectedCount}, parsed ${medlineRecords.length}`);
}

const pmids = medlineRecords.map((record) => clean(record.PMID?.[0]));
if (new Set(pmids).size !== pmids.length || pmids.some((pmid) => !pmid)) {
  throw new Error("PubMed PMID set is missing identifiers or contains duplicates");
}

const header = [
  "raw_record_id",
  "source_database",
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
  "raw_file_sha256",
  "raw_relative_path",
  "duplicate_group_id",
  "screen_title_abstract",
  "screen_full_text",
  "exclusion_reason",
  "notes",
];

const normalized = medlineRecords.map((record) => {
  const pmid = clean(record.PMID?.[0]);
  const doiEntry = [...(record.AID ?? []), ...(record.LID ?? [])].find((value) => /\[doi\]\s*$/i.test(value));
  const doi = normalizeDoi(doiEntry?.replace(/\s*\[doi\]\s*$/i, "") ?? "");
  const authors = (record.AU ?? record.FAU ?? []).map(clean).filter(Boolean);
  const year = clean(record.DP?.[0]).match(/\b(18|19|20)\d{2}\b/)?.[0] ?? "";
  const publicationTypes = (record.PT ?? []).map(clean).filter(Boolean);
  const language = (record.LA ?? []).map(clean).join("; ");
  const keywords = [...(record.OT ?? []), ...(record.MH ?? [])].map(clean).filter(Boolean);
  return {
    raw_record_id: `Q4P:${pmid}`,
    source_database: "PubMed",
    source_record_id: `PMID:${pmid}`,
    doi,
    title: clean((record.TI ?? []).join(" ")),
    authors: JSON.stringify(authors),
    publication_year: year,
    journal_or_source: clean(record.JT?.[0] ?? record.TA?.[0] ?? ""),
    abstract: clean((record.AB ?? []).join(" ")),
    language,
    document_type: publicationTypes.join("; "),
    keywords: JSON.stringify(keywords),
    query_batch_id: JSON.stringify(["Q4P"]),
    raw_file_sha256: JSON.stringify([sha256(nbibBytes)]),
    raw_relative_path: JSON.stringify(["raw/pubmed/Q4_2026-08-26_batch01/savedrecs.nbib"]),
    duplicate_group_id: `pubmed_${sha256(pmid).slice(0, 16)}`,
    screen_title_abstract: "",
    screen_full_text: "",
    exclusion_reason: "",
    notes: "",
    _authors: authors,
  };
});

const wos = parseTsv(fs.readFileSync(wosPath, "utf8"));
const wosByDoi = new Map();
const wosByTitle = new Map();
for (const record of wos.rows) {
  const doi = normalizeDoi(record.doi);
  if (doi && !wosByDoi.has(doi)) wosByDoi.set(doi, record);
  const authors = JSON.parse(record.authors || "[]");
  const key = `${normalizeTitle(record.title)}|${record.publication_year}|${firstAuthorKey(authors)}`;
  if (normalizeTitle(record.title) && !wosByTitle.has(key)) wosByTitle.set(key, record);
}

const duplicateRows = [];
const uniqueRows = [];
for (const record of normalized) {
  let match = record.doi ? wosByDoi.get(record.doi) : undefined;
  let method = match ? "normalized_doi" : "";
  if (!match) {
    const key = `${normalizeTitle(record.title)}|${record.publication_year}|${firstAuthorKey(record._authors)}`;
    match = wosByTitle.get(key);
    method = match ? "normalized_title_year_first_author" : "";
  }
  if (match) {
    record.duplicate_group_id = match.duplicate_group_id;
    duplicateRows.push({
      pubmed_raw_record_id: record.raw_record_id,
      pubmed_source_record_id: record.source_record_id,
      match_method: method,
      wos_raw_record_id: match.raw_record_id,
      wos_source_record_id: match.source_record_id,
      duplicate_group_id: match.duplicate_group_id,
    });
  } else {
    uniqueRows.push(record);
  }
}

function serializeRows(rows) {
  return `${header.join("\t")}\n${rows
    .map((row) => header.map((field) => clean(row[field])).join("\t"))
    .join("\n")}\n`;
}

fs.writeFileSync(normalizedPath, serializeRows(normalized));
fs.writeFileSync(uniquePath, serializeRows(uniqueRows));
fs.writeFileSync(allSourcesPath, serializeRows([...wos.rows, ...uniqueRows]));
const duplicateHeader = [
  "pubmed_raw_record_id",
  "pubmed_source_record_id",
  "match_method",
  "wos_raw_record_id",
  "wos_source_record_id",
  "duplicate_group_id",
];
fs.writeFileSync(
  duplicatePath,
  `${duplicateHeader.join("\t")}\n${duplicateRows
    .map((row) => duplicateHeader.map((field) => clean(row[field])).join("\t"))
    .join("\n")}\n`,
);

const metadataCoverage = {};
for (const field of [
  "source_record_id",
  "doi",
  "title",
  "authors",
  "publication_year",
  "journal_or_source",
  "abstract",
  "language",
  "document_type",
]) {
  const present = normalized.filter((row) => clean(row[field])).length;
  metadataCoverage[field] = {
    present,
    missing: normalized.length - present,
    proportion: present / normalized.length,
  };
}

const summary = {
  generated_at: new Date().toISOString(),
  database: "PubMed",
  query_id: "Q4P",
  evidence_strand: "E1",
  expected_record_count: expectedCount,
  parsed_record_count: normalized.length,
  unique_pmids: new Set(pmids).size,
  overlap_with_wos: duplicateRows.length,
  pubmed_unique_records: uniqueRows.length,
  all_source_unique_records: wos.rows.length + uniqueRows.length,
  match_methods: Object.fromEntries(
    [...new Set(duplicateRows.map((row) => row.match_method))].map((method) => [
      method,
      duplicateRows.filter((row) => row.match_method === method).length,
    ]),
  ),
  metadata_coverage: metadataCoverage,
  raw_files: {
    esearch: {
      relative_path: "raw/pubmed/Q4_2026-08-26_batch01/esearch.json",
      bytes: searchBytes.length,
      sha256: sha256(searchBytes),
    },
    medline: {
      relative_path: "raw/pubmed/Q4_2026-08-26_batch01/savedrecs.nbib",
      bytes: nbibBytes.length,
      sha256: sha256(nbibBytes),
      pmid_markers: medlineRecords.length,
    },
  },
  pubmed_query_translation: search.esearchresult.querytranslation,
  pubmed_warnings: search.esearchresult.warninglist,
  screening_status: "not_started",
};
fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
