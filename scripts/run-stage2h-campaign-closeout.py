#!/usr/bin/env python3
"""Wait for scoped downloads, import, independently audit, and report campaign."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time

PROJECT = Path(__file__).resolve().parents[1]
DOWNLOADS = Path("/Users/w.cha@bham.ac.uk/Downloads/Phase12_Profile5_GateA")
EVIDENCE = PROJECT / "research/evidence/si_stage2h_v2_campaign_download_2026-09-21"
AUDIT = PROJECT / "research/results/si_stage2h_v2_campaign_audit_2026-09-21"
CLOSURE = PROJECT / "research/results/si_stage2h_v2_campaign_closure_2026-09-21.json"
REPORT = PROJECT / "research/analysis/si_stage2h_v2_campaign_2026-09-21"


def run(command, log=None):
    print("STEP", command[1], flush=True)
    if log is None:
        subprocess.run(command, cwd=PROJECT, check=True)
        return
    with log.open("x") as handle:
        child = subprocess.Popen(command, cwd=PROJECT, stdout=subprocess.PIPE,
                                 stderr=subprocess.STDOUT, text=True, bufsize=1)
        for line in child.stdout:
            handle.write(line)
            handle.flush()
            print(line, end="", flush=True)
        assert child.wait() == 0, f"Failed: {command[1]}"


def main():
    index = DOWNLOADS / "transfer-index.json"
    rows = json.loads(index.read_text())["archives"]
    start = time.monotonic()
    while True:
        missing = [r["file"] for r in rows if not any(
            f.stat().st_size == r["bytes"]
            for f in DOWNLOADS.glob(Path(r["file"]).stem + "*.tar"))]
        if not missing:
            break
        print("Waiting for", ", ".join(missing), flush=True)
        if time.monotonic() - start > 1200:
            raise TimeoutError("Required downloads did not complete within 20 minutes")
        time.sleep(30)
    run([sys.executable, "scripts/import-stage2h-campaign.py", "--archives", str(DOWNLOADS),
         "--index", str(index), "--destination", str(EVIDENCE)])
    run([sys.executable, "aws/build/stage2h-20260918-v2/aws/stage2h_v2/analyze.py",
         "--root", str(EVIDENCE / "output"), "--output", str(AUDIT),
         "--bundle", str(PROJECT / "aws/build/stage2h-20260918-v2")],
        PROJECT / "research/results/si_stage2h_v2_campaign_audit_2026-09-21.log")
    run([sys.executable, "scripts/close-stage2h-v2-campaign.py", "--evidence", str(EVIDENCE),
         "--audit", str(AUDIT), "--launch", "research/results/si_stage2h_v2_campaign_launch_2026-09-20.json",
         "--output", str(CLOSURE)])
    REPORT.mkdir(exist_ok=False, parents=True)
    run([sys.executable, "scripts/diagnose-stage2h-target-offset.py", "--audit", str(AUDIT / "analysis.json"),
         "--closure", str(CLOSURE), "--manifest", str(EVIDENCE / "output/manifest.json"),
         "--output", str(REPORT / "target-offset-diagnostic.json")])
    run([sys.executable, "scripts/report-stage2h-campaign.py", "--audit", str(AUDIT / "analysis.json"),
         "--closure", str(CLOSURE), "--output", str(REPORT), "--refresh-generated"],
        PROJECT / "research/results/si_stage2h_v2_campaign_report_2026-09-21.log")
    print("CLOSEOUT_COMPLETE", str(REPORT / "report.md"), flush=True)


if __name__ == "__main__":
    os.environ["OPENBLAS_NUM_THREADS"] = "1"
    os.environ["OMP_NUM_THREADS"] = "1"
    os.environ.setdefault("MPLCONFIGDIR", "/private/tmp/plumenav-stage2h-mpl")
    main()
