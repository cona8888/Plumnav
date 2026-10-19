#!/usr/bin/env python3
"""Read the completed campaign into bounded CloudShell transfer archives.

Only STS/Describe/Get/List AWS calls; no remote object or job writes. Archives
are disposable transfer containers, not replacements for the original evidence.
"""
import hashlib
import io
import json
import tempfile
import tarfile
from datetime import datetime, timezone
from pathlib import Path

import boto3

JOB = "plumenav-stage2h-v2-campaign-20260920-035115"
BUCKET = "sagemaker-us-east-1-380061838272"
PREFIX = f"plumenav/stage2h/20260918-v2-5f17d1505d28/jobs/{JOB}/output/"


def main():
    session = boto3.Session(region_name="us-east-1")
    assert session.client("sts").get_caller_identity()["Account"] == "380061838272"
    description = session.client("sagemaker").describe_processing_job(ProcessingJobName=JOB)
    assert description["ProcessingJobStatus"] == "Completed"
    s3 = session.client("s3")
    objects = sorted(
        [x for p in s3.get_paginator("list_objects_v2").paginate(Bucket=BUCKET, Prefix=PREFIX)
         for x in p.get("Contents", [])], key=lambda x: x["Key"])
    metadata = [x for x in objects if not x["Key"].endswith(".json.gz")]
    raw = [x for x in objects if x["Key"].endswith(".json.gz")]
    assert len(raw) == 288
    groups = [metadata]
    current, size = [], 0
    for item in raw:
        if current and size + item["Size"] > 750_000_000:
            groups.append(current)
            current, size = [], 0
        current.append(item)
        size += item["Size"]
    if current:
        groups.append(current)
    dest = Path(tempfile.mkdtemp(prefix="plumenav-campaign-transfer-", dir="/tmp"))
    print(f"TRANSFER_DIRECTORY {dest}", flush=True)
    index = dict(job=JOB, bucket=BUCKET, prefix=PREFIX,
                 createdAt=datetime.now(timezone.utc).isoformat(),
                 objectCount=len(objects), totalBytes=sum(x["Size"] for x in objects), archives=[])
    for number, group in enumerate(groups):
        path = dest / f"plumenav-stage2h-campaign-part-{number:02}.tar"
        with tarfile.open(path, "w") as archive:
            if number == 0:
                data = json.dumps(description, default=str, indent=2).encode()
                entry = tarfile.TarInfo("provenance/describe-processing-job.json")
                entry.size = len(data)
                archive.addfile(entry, io.BytesIO(data))
                logs = session.client("logs").get_log_events(
                    logGroupName="/aws/sagemaker/ProcessingJobs",
                    logStreamName=f"{JOB}/algo-1-1789944068", startFromHead=True)
                data = json.dumps(logs, default=str, indent=2).encode()
                entry = tarfile.TarInfo("provenance/cloudwatch-events.json")
                entry.size = len(data)
                archive.addfile(entry, io.BytesIO(data))
                data = json.dumps(objects, default=str, indent=2).encode()
                entry = tarfile.TarInfo("provenance/s3-inventory.json")
                entry.size = len(data)
                archive.addfile(entry, io.BytesIO(data))
            for item in group:
                name = item["Key"][len(PREFIX):]
                assert name and not name.startswith("/") and ".." not in Path(name).parts
                response = s3.get_object(Bucket=BUCKET, Key=item["Key"])
                assert response["ContentLength"] == item["Size"]
                assert response["ETag"] == item["ETag"]
                entry = tarfile.TarInfo("output/" + name)
                entry.size = item["Size"]
                with response["Body"] as stream:
                    archive.addfile(entry, stream)
        with path.open("rb") as handle:
            digest = hashlib.file_digest(handle, "sha256").hexdigest()
        row = dict(file=path.name, bytes=path.stat().st_size, sha256=digest, objects=len(group))
        index["archives"].append(row)
        print(json.dumps(row), flush=True)
    with (dest / "transfer-index.json").open("x") as handle:
        json.dump(index, handle, indent=2)
        handle.write("\n")
    print(f"TRANSFER_READY {dest}/transfer-index.json", flush=True)


if __name__ == "__main__":
    main()
