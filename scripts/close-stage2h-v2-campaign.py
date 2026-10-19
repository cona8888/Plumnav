#!/usr/bin/env python3
"""Close the immutable campaign only after full downloaded-history re-audit."""
import argparse
import hashlib
import json
import platform
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import scipy

from lib.processing_output_manifest import verify_output_manifest
from lib.si_fine_scheduling_statistics import summarize


def read(path):
    return json.loads(path.read_text())


def sha(path):
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--audit", type=Path, required=True)
    parser.add_argument("--launch", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    root = args.evidence / "output"
    transport = verify_output_manifest(root, allow_empty_upload_markers=True)
    launch = read(args.launch)
    job = read(args.evidence / "provenance/describe-processing-job.json")
    assert job["ProcessingJobName"] == launch["jobName"]
    assert job["ProcessingJobStatus"] == "Completed"
    assert job.get("FailureReason") is None and job.get("ExitMessage") is None
    assert job["AppSpecification"]["ImageUri"] == launch["imageUri"]
    assert job["Environment"]["STAGE2H_ARCHIVE_SHA256"] == launch["archiveSha256"]
    assert job["Environment"]["STAGE2H_MODE"] == "campaign"
    cluster = job["ProcessingResources"]["ClusterConfig"]
    assert cluster["InstanceCount"] == launch["instanceCount"] == 1
    assert cluster["InstanceType"] == launch["instanceType"] == "ml.m5.xlarge"
    assert job["StoppingCondition"]["MaxRuntimeInSeconds"] == launch["maxRuntimeSeconds"]
    assert job["ProcessingOutputConfig"]["Outputs"][0]["S3Output"]["S3Uri"].rstrip("/") == launch["outputS3Uri"].rstrip("/")
    manifest = read(root / "manifest.json")
    deployment = read(root / "deployment.json")
    assert manifest["mode"] == "campaign" and manifest["caseCount"] == 288
    assert manifest["primaryCount"] == 192
    assert manifest["bundleSha256"] == launch["bundleSha256"]
    assert manifest["reportingFixture"]["sha256"] == launch["reportingFixtureSha256"]
    assert manifest["cases"] == deployment["plan"]["campaign"]["cases"]
    assert manifest["configs"] == deployment["plan"]["campaign"]["configs"]
    cloud = read(root / "analysis/analysis.json")
    local = read(args.audit / "analysis.json")
    for data in (cloud, local):
        assert data["schemaVersion"] == "stage2h-cloud-audit-v2" and data["mode"] == "campaign"
        for gate in ("accepted", "integrityPassed", "coupledResolutionPassed", "absentControlPassed", "absentBitIdentical"):
            assert data[gate] is True, gate
        assert data["manifestSha256"] == sha(root / "manifest.json")
        assert data["bundleSha256"] == launch["bundleSha256"]
        assert len(data["details"]) == len(data["runs"]) == 288
        assert len(data["triples"]) == 48 and all(t["passed"] for t in data["triples"])
        assert all(d["audit"]["passed"] and d["replay"]["passed"] for d in data["details"])
        assert sorted(d["index"] for d in data["details"]) == list(range(288))
        assert data["performance"] == summarize(data["runs"])
    assert cloud["counts"] == local["counts"]
    assert cloud["sourceCount"] == local["sourceCount"] == 141
    assert cloud["performance"] == local["performance"]
    assert cloud["runs"] == local["runs"]
    for c, l in zip(cloud["triples"], local["triples"]):
        assert c["indices"] == l["indices"] and c["gates"] == l["gates"]
    for key, expected in ((root / "analysis/complete.json", sha(root / "analysis/analysis.json")),
                          (root / "job-complete.json", sha(root / "analysis/analysis.json")),
                          (args.audit / "complete.json", sha(args.audit / "analysis.json"))):
        done = read(key)
        assert done["complete"] and done["accepted"] and done["analysisSha256"] == expected
    log = (root / "audit.log").read_text()
    assert "audited 288/288" in log
    assert not any(token in log for token in ("Traceback (most recent call last)", "AssertionError", "FATAL"))
    start = datetime.fromisoformat(job["ProcessingStartTime"])
    end = datetime.fromisoformat(job["ProcessingEndTime"])
    seconds = (end - start).total_seconds()
    result = dict(schemaVersion="stage2h-v2-campaign-closure-v1", accepted=True,
                  checkedAt=datetime.now(timezone.utc).isoformat(), job=launch["jobName"],
                  downloadedAndIndependentlyAudited=True, mode="campaign", caseCount=288,
                  primaryMissions=192, independentWorlds=16, witnessTriplets=48,
                  transport=transport, cloudAndLocalPerformanceIdentical=True,
                  counts=local["counts"], managedRuntimeSeconds=seconds,
                  estimatedComputeUSD=seconds / 3600 * float(launch["hourlyRateUSD"]),
                  costBasis="Recorded launch price; ancillary charges and billing rounding excluded",
                  localRuntime=dict(python=sys.version, executable=sys.executable,
                                    numpy=np.__version__, scipy=scipy.__version__, architecture=platform.machine()),
                  auditSeconds=local["elapsedSeconds"],
                  independentAuditSha256=sha(args.audit / "analysis.json"),
                  cloudAuditSha256=sha(root / "analysis/analysis.json"),
                  launchSha256=sha(args.launch), descriptionSha256=sha(args.evidence / "provenance/describe-processing-job.json"),
                  limitations="Numerical integrity and controlled exploratory scheduling comparison; not physical, hardware, urban-flow or buried-leak validation.")
    with args.output.open("x") as handle:
        json.dump(result, handle, indent=2, allow_nan=False)
        handle.write("\n")
    print(json.dumps({k:v for k,v in result.items() if k != "transport"}, indent=2))


if __name__ == "__main__":
    main()
