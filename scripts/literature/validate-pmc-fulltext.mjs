import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const reviewDir = path.join(projectRoot, "research/literature_review_2026");
const manifestPath = path.join(reviewDir, "provenance/pmc_fulltext_2026-08-26_manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const results = [];

for (const item of manifest.items) {
  const filePath = path.join(reviewDir, item.raw_relative_path);
  const source = fs.readFileSync(filePath);
  const text = source.toString("utf8");
  const actual = {
    byte_size: source.byteLength,
    sha256: crypto.createHash("sha256").update(source).digest("hex"),
  };
  if (actual.byte_size !== item.byte_size || actual.sha256 !== item.sha256) {
    throw new Error(`Integrity mismatch for ${item.pmcid}`);
  }
  if (!text.includes(`<article-id pub-id-type="pmcid">${item.pmcid}</article-id>`)) {
    throw new Error(`PMCID mismatch for ${item.pmcid}`);
  }
  if (item.doi && !text.includes(item.doi)) throw new Error(`DOI not found for ${item.pmcid}`);
  const hasBody = /<body(?:\s|>)/.test(text);
  if (item.content_scope.startsWith("full JATS") && !hasBody) {
    throw new Error(`Expected article body for ${item.pmcid}`);
  }
  if (item.content_scope.startsWith("front matter") && hasBody) {
    throw new Error(`Unexpected full body for metadata-only ${item.pmcid}`);
  }
  results.push({ pmcid: item.pmcid, ...actual, has_article_body: hasBody });
}

process.stdout.write(`${JSON.stringify({ validated_items: results.length, results }, null, 2)}\n`);
