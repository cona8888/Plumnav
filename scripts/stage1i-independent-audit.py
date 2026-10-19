#!/usr/bin/env python3
"""Independent compact-recorder audit; intentionally does not import simulator code.

The audit processes one compressed block at a time so production outputs can be
verified in memory-constrained environments such as AWS CloudShell. Validation
semantics are unchanged from the original whole-dataset implementation.
"""

import argparse
import gzip
import hashlib
import json
import math
from pathlib import Path


parser = argparse.ArgumentParser()
parser.add_argument("--output", required=True)
parser.add_argument("--mode", choices=["smoke", "production"], required=True)
parser.add_argument("--shards", type=int, default=4)
args = parser.parse_args()
root = Path(args.output)

errors = []
record_count = 0
indices = set()
groups = {}


def add_error(message):
    errors.append(message)


def audit_record(record):
    global record_count

    record_count += 1
    spec = record["spec"]
    uncertainty = spec["uncertainty"]
    index = spec["index"]

    if index in indices:
        add_error(f"duplicate index {index}")
    else:
        indices.add(index)

    position_offsets = record["positionOffsetsMetres"]
    radius = uncertainty["positionRadiusMetres"]
    visits = record["visits"]
    actual_samples_by_visit = record["actualSamples"]

    if len(visits) != 17 or len(actual_samples_by_visit) != 17:
        add_error(f"{index}: visit count")
        return

    if any(math.hypot(offset["x"], offset["y"]) > radius + 1e-12 for offset in position_offsets):
        add_error(f"{index}: radius bound")

    if (
        uncertainty.get("positionErrorStructure") == "constant-bias"
        and any(offset != position_offsets[0] for offset in position_offsets)
    ):
        add_error(f"{index}: bias changed")

    for visit_index, (visit, actual_samples) in enumerate(zip(visits, actual_samples_by_visit)):
        samples = visit["samples"]
        if visit["closedAt"] is None or len(samples) < 2 or len(samples) != len(actual_samples):
            add_error(f"{index}: incomplete visit {visit_index}")
            continue

        for sample, actual in zip(samples, actual_samples):
            if (
                abs(sample["time"] - actual["time"]) > 1e-12
                or abs(sample["value"] - actual["measurementConcentration"]) > 1e-12
            ):
                add_error(f"{index}: recorder mismatch {visit_index}")

            source = (
                record["nominalTargets"][visit_index]
                if uncertainty["registration"] == "commanded"
                else actual["position"]
            )
            candidate = record["nominalTargets"][0]
            grid_spacing = 0.001
            expected_x = (source["x"] - candidate["x"]) / grid_spacing
            expected_y = (source["y"] - candidate["y"]) / grid_spacing
            if abs(sample["x"] - expected_x) > 1e-8 or abs(sample["y"] - expected_y) > 1e-8:
                add_error(f"{index}: registration mismatch {visit_index}")

    if spec["kind"] == "position":
        key = (
            spec["field"],
            spec["replicate"],
            uncertainty["positionRadiusMetres"],
            uncertainty.get("positionErrorStructure"),
        )
        registrations = groups.setdefault(key, {})
        registration = uncertainty["registration"]
        if registration in registrations:
            add_error(f"{key}: duplicate {registration} registration")
        else:
            registrations[registration] = position_offsets


for shard in range(args.shards):
    directory = root / f"worker-{shard}"
    complete = json.loads((directory / "complete.json").read_text())
    if not complete.get("complete") or complete.get("completed") != complete.get("expected"):
        add_error(f"worker-{shard} incomplete")

    for item in complete["inventory"]:
        block_bytes = (directory / item["file"]).read_bytes()
        if hashlib.sha256(block_bytes).hexdigest() != item["sha256"] or len(block_bytes) != item["bytes"]:
            add_error(f"bad block {shard}/{item['file']}")

        block = json.loads(gzip.decompress(block_bytes))
        for record in block["records"]:
            audit_record(record)


paired_groups_checked = 0
for key, registrations in groups.items():
    if set(registrations) == {"observed", "commanded"}:
        paired_groups_checked += 1
        if registrations["observed"] != registrations["commanded"]:
            add_error(f"{key}: unpaired physical offsets")

if record_count != len(indices):
    add_error("duplicate indices")

if args.mode == "production" and (record_count != 13211 or len(indices) != 13211):
    add_error(f"production record count: {record_count} records, {len(indices)} unique")

result = {
    "schemaVersion": "si-pose-registration-independent-audit-v1",
    "accepted": not errors,
    "mode": args.mode,
    "records": record_count,
    "uniqueRecords": len(indices),
    "pairedGroupsChecked": paired_groups_checked,
    "errors": errors[:100],
}
(root / "independent-audit.json").write_text(json.dumps(result, sort_keys=True, indent=2) + "\n")
print(json.dumps(result, sort_keys=True, indent=2))
raise SystemExit(0 if result["accepted"] else 1)
