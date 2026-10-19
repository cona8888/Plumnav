#!/usr/bin/env python3
"""Close the downloaded Stage 2h v2 cloud smoke after an independent Mac audit.

This helper is outside the sealed cloud bundle. It verifies transport,
deployment identity, independent audit agreement and campaign runtime planning;
it never launches AWS compute or edits the downloaded evidence.
"""
import argparse
import hashlib
import json
import math
from datetime import datetime, timezone
from pathlib import Path

from lib.processing_output_manifest import verify_output_manifest


ARCHIVE_SHA = "5f17d1505d287d1ab61f2a832f2f5783b3033a52ac2e8e5a1a54f5060655b5a3"
BUNDLE_SHA = "88c5cffbc5b1e48b95e3226a645cb60ef88011878b85e2e309647281b4dc1aab"
FIXTURE_SHA = "c97ffc0f79bc407a91250781dec2cf41788c5478fef47c6373a135e816721f02"
IMAGE = (
    "885854791233.dkr.ecr.us-east-1.amazonaws.com/"
    "sagemaker-distribution-prod@sha256:"
    "2ae2a90be54895e8ef66b4a26a913c57d1ee52f5429055afe652627ddbfa253a"
)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read(path):
    return json.loads(path.read_text())


def close(root, audit, description, output, allow_empty_upload_markers=False):
    root = Path(root).resolve()
    audit = Path(audit).resolve()
    description = Path(description).resolve()
    output = Path(output).resolve()
    transport = verify_output_manifest(
        root, allow_empty_upload_markers=allow_empty_upload_markers
    )
    job = read(description)
    manifest = read(root / "manifest.json")
    deployment = read(root / "deployment.json")

    assert job["ProcessingJobStatus"] == "Completed"
    assert job.get("FailureReason") is None and job.get("ExitMessage") is None
    assert job["AppSpecification"]["ImageUri"] == IMAGE
    assert job["Environment"]["STAGE2H_ARCHIVE_SHA256"] == ARCHIVE_SHA
    assert job["Environment"]["STAGE2H_MODE"] == "smoke"
    cluster = job["ProcessingResources"]["ClusterConfig"]
    assert cluster["InstanceCount"] == 1
    assert cluster["InstanceType"] == "ml.m5.xlarge"
    assert job["StoppingCondition"]["MaxRuntimeInSeconds"] == 3600

    fixture = manifest["reportingFixture"]
    assert fixture == deployment["reportingFixture"]
    assert fixture["version"] == "fixed-reporting-fixture-v1"
    assert fixture["sha256"] == FIXTURE_SHA
    assert manifest["bundleSha256"] == BUNDLE_SHA
    assert manifest["caseCount"] == 12 and manifest["mode"] == "smoke"
    assert manifest["cases"] == deployment["plan"]["smoke"]["cases"]
    assert manifest["configs"] == deployment["plan"]["smoke"]["configs"]
    assert len(deployment["frozenSources"]) == 141
    assert len(deployment["additions"]) == 22
    assert len(deployment["plan"]["campaign"]["cases"]) == 288

    cloud = read(root / "analysis/analysis.json")
    local = read(audit / "analysis.json")
    for data in (cloud, local):
        assert data["schemaVersion"] == "stage2h-cloud-audit-v2"
        assert data["reportingFixture"] == fixture
        assert data["accepted"]
        assert data["integrityPassed"]
        assert data["platformCompatibilityPassed"]
        assert data["absentControlPassed"]
        assert data["performance"] is None
        assert data["manifestSha256"] == sha(root / "manifest.json")
        assert data["bundleSha256"] == BUNDLE_SHA
        assert len(data["details"]) == 12

    assert cloud["counts"] == local["counts"]
    assert cloud["sourceCount"] == local["sourceCount"] == 141
    left = {detail["index"]: detail for detail in cloud["details"]}
    right = {detail["index"]: detail for detail in local["details"]}
    assert left.keys() == right.keys()
    for index in left:
        assert left[index]["audit"]["passed"]
        assert right[index]["audit"]["passed"]
        assert left[index]["replay"] == right[index]["replay"]
        assert (
            left[index]["platformCompatibility"]["gates"]
            == right[index]["platformCompatibility"]["gates"]
        )

    assert read(audit / "complete.json")["analysisSha256"] == sha(
        audit / "analysis.json"
    )
    assert read(root / "job-complete.json")["analysisSha256"] == sha(
        root / "analysis/analysis.json"
    )
    inventories = [
        item
        for worker in range(4)
        for item in read(root / f"worker-{worker}/complete.json")["inventory"]
    ]
    assert sorted(item["index"] for item in inventories) == sorted(
        spec["index"] for spec in manifest["cases"]
    )

    slowest = max(
        item["elapsedSeconds"] / item["summary"]["completedAt"]
        for item in inventories
    )
    simulation_projection = 72 * 1200 * slowest
    audit_projection = cloud["elapsedSeconds"] * 24
    projection = simulation_projection + audit_projection + 300
    guard = max(3600, math.ceil((projection * 1.5 + 120) / 1800) * 1800)
    assert guard <= 86400, ("Cloud forecast exceeds approved 24-hour cap", guard)

    result = {
        "schemaVersion": "stage2h-v2-cloud-smoke-closure-v1",
        "accepted": True,
        "downloadedAndIndependentlyAudited": True,
        "cloudValidated": True,
        "campaignLaunched": False,
        "smokeJob": job["ProcessingJobName"],
        "archiveSha256": ARCHIVE_SHA,
        "bundleSha256": BUNDLE_SHA,
        "reportingFixture": fixture,
        "imageUri": IMAGE,
        "independentAuditSha256": sha(audit / "analysis.json"),
        "downloadedOutputManifestSha256": sha(root / "SHA256SUMS"),
        "descriptionSha256": sha(description),
        "checkedFiles": transport["checkedFiles"],
        "transport": transport,
        "caseCount": 12,
        "checkedAt": datetime.now(timezone.utc).isoformat(),
        "productionMaxRuntimeSeconds": guard,
        "planning": {
            "slowestObservedCaseWallSecondsPerSimulatedSecond": slowest,
            "simulationProjectionSeconds": simulation_projection,
            "auditProjectionSeconds": audit_projection,
            "fixedAllowanceSeconds": 300,
            "projectionSeconds": projection,
            "headroom": 1.5,
            "allCasesTreatedAsFineGrid": True,
            "allMissionDurationsSeconds": 1200,
            "workers": 4,
            "limitation": (
                "A conservative throughput forecast, not a mathematical runtime "
                "bound. Production remains capped and partial results are "
                "diagnostic-only."
            ),
        },
    }
    with output.open("x") as handle:
        json.dump(result, handle, indent=2, allow_nan=False)
        handle.write("\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--audit", type=Path, required=True)
    parser.add_argument("--description", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--allow-empty-upload-markers", action="store_true")
    args = parser.parse_args()
    close(
        args.root,
        args.audit,
        args.description,
        args.output,
        args.allow_empty_upload_markers,
    )
