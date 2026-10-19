#!/usr/bin/env python3
"""Verify downloaded archive parts, then safely import original S3 payloads."""
import argparse
import hashlib
import json
import shutil
import tarfile
from pathlib import Path
from lib.processing_output_manifest import verify_output_manifest


def digest(path):
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--archives", type=Path, required=True)
    p.add_argument("--index", type=Path, required=True)
    p.add_argument("--destination", type=Path, required=True)
    a = p.parse_args()
    index = json.loads(a.index.read_text())
    assert index["job"] == "plumenav-stage2h-v2-campaign-20260920-035115"
    assert index["objectCount"] == 597 and index["totalBytes"] == 5541421675
    found = []
    for item in index["archives"]:
        options = [f for f in a.archives.glob(Path(item["file"]).stem + "*.tar")
                   if f.stat().st_size == item["bytes"] and digest(f) == item["sha256"]]
        assert options, f"Missing or unverified archive: {item['file']}"
        found.append((item, sorted(options)[0]))
        print("verified", item["file"], flush=True)
    a.destination.mkdir(exist_ok=False, parents=True)
    extracted = set()
    for item, path in found:
        with tarfile.open(path) as archive:
            for entry in archive:
                name = Path(entry.name)
                assert entry.isfile() and not name.is_absolute() and ".." not in name.parts
                assert name.parts[0] in ("output", "provenance") and entry.name not in extracted
                extracted.add(entry.name)
                target = a.destination / name
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.extractfile(entry) as src, target.open("xb") as dst:
                    shutil.copyfileobj(src, dst)
        print("imported", item["file"], flush=True)
    output = a.destination / "output"
    files = [f for f in output.rglob("*") if f.is_file()]
    assert len(files) == index["objectCount"]
    assert sum(f.stat().st_size for f in files) == index["totalBytes"]
    checked = verify_output_manifest(output, allow_empty_upload_markers=True)
    shutil.copyfile(a.index, a.destination / "provenance/transfer-index.json")
    with (a.destination / "provenance/transfer-verification.json").open("x") as handle:
        json.dump(dict(verified=True, archives=index["archives"], transport=checked), handle, indent=2)
    print(json.dumps({k:v for k,v in checked.items() if k != "omittedEmptyUploadMarkers"}, indent=2))


if __name__ == "__main__":
    main()
