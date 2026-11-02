"""Rebuild the offline methane replay inputs from the publishers' versioned ZIPs."""
import argparse
import csv
import gzip
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import sys
import zipfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("dataset", choices=["blackpool", "matrix"])
parser.add_argument("archive", type=Path)
parser.add_argument("output", type=Path, help="destination directory for observation files")
args = parser.parse_args()

hashes = {
    "blackpool": "4f1053c692a4210092238bba855ff2236ae6357bb7dada86ea1bce16c986b603",
    "matrix": "0877ded553b69db936e9bb4de0a61c3ff01fe0945ada1b0349331fa044c9a047",
}
with args.archive.open("rb") as handle:
    archive_hash = hashlib.file_digest(handle, "sha256").hexdigest()
if archive_hash != hashes[args.dataset]:
    raise ValueError("Unexpected publisher archive")

def save(relative_path, content):
    destination = args.output / (relative_path + ".gz")
    destination.parent.mkdir(parents=True, exist_ok=True)
    # Fixed timestamp, no machine-dependent filename. Hashes used by the runners
    # cover the decompressed bytes and therefore work across gzip implementations.
    with destination.open("wb") as raw, gzip.GzipFile(filename="", fileobj=raw, mode="wb", mtime=0) as compressed:
        compressed.write(content)

if args.dataset == "blackpool":
    decoder = Path(__file__).with_name("read-blackpool-surveys.py")
    buf = subprocess.check_output([sys.executable, decoder, args.archive])
    for record in buf.splitlines():
        survey = json.loads(record)["survey"]
        save(survey + ".json", record + b"\n")
else:
    with zipfile.ZipFile(args.archive) as archive:
        names = sorted(n for n in archive.namelist() if
                       re.fullmatch(r"MATRIX_Dataset/\d{3}_\d{2}/EMP_[^/]+_CH4_v2\.csv", n))
        if len(names) != 18:
            raise ValueError("Expected exactly 18 QCLAS methane files")
        for name in names:
            save(name.removeprefix("MATRIX_Dataset/"), archive.read(name))
        fields = ["year_month_day_hour_minute_second", "uu", "vv"]
        for day in ["20200313", "20200314"]:
            name = f"MATRIX_Meteo/agg_{day}.csv"
            buf = io.StringIO(newline="")
            writer = csv.DictWriter(buf, fields, extrasaction="ignore", lineterminator="\n")
            writer.writeheader()
            with archive.open("MATRIX_Dataset/" + name) as raw:
                # Preserve every timestamp and the original component strings, including missing values.
                writer.writerows(csv.DictReader(io.TextIOWrapper(raw, encoding="utf-8", newline="")))
            save(name, buf.getvalue().encode("utf-8"))
