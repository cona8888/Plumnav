#!/usr/bin/env python3
"""Produce descriptive figures and tables only from accepted campaign evidence."""
import argparse
import collections
import hashlib
import json
from pathlib import Path
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

LABELS = {("coverage", "reference"): "Coverage",
          ("surge-cast", "reference"): "Surge–cast",
          ("quad-sniff-refine", "reference"): "Periodic quad",
          ("quad-sniff-refine", "encounter-gated"): "Encounter-gated quad"}
FIELDS = {"si-continuous": "Continuous", "si-pulse": "Pulsed", "blank": "Absent"}


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--audit", type=Path, required=True)
    p.add_argument("--closure", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--refresh-generated", action="store_true", help="Rebuild this script's named report/figure products only")
    a = p.parse_args()
    closure = json.loads(a.closure.read_text())
    body = a.audit.read_bytes()
    assert closure["accepted"] and closure["independentAuditSha256"] == hashlib.sha256(body).hexdigest()
    data = json.loads(body)
    assert data["accepted"] and data["performance"] is not None
    a.output.mkdir(exist_ok=a.refresh_generated, parents=True)
    perf = data["performance"]
    primary = [r for r in data["runs"] if r["spec"]["caseRole"] == "primary"]
    rows = []
    diagnostics = []
    for arm in perf["arms"]:
        label = LABELS[arm["method"], arm["policy"]]
        group = [r for r in primary if r["spec"]["field"] == arm["field"]
                 and r["spec"]["method"] == arm["method"] and r["spec"]["policy"] == arm["policy"]]
        binary = arm["binary"]
        cont = arm["continuous"]
        errors = [r["summary"]["nominationSourceErrorMetres"] for r in group
                  if r["summary"]["nominationSourceErrorMetres"] is not None]
        ages = [r["summary"]["nominationAt"] - r["nomination"]["observationTime"]
                for r in group if r["nomination"] is not None]
        fitted_errors = [e["sourceErrorMetres"] for r in group for e in r["summary"]["errors"]
                         if e["poseRadiusMetres"] == 0 and e["sourceErrorMetres"] is not None]
        reasons = collections.Counter(str(d["reason"]) for r in group for d in r["decisions"] if d["radius"] == 0)
        row = dict(field=arm["field"], algorithm=label, n=16,
                   encounters=binary["encounter"]["successes"],
                   encounterWilson95=binary["encounter"]["wilson95"],
                   nominations=binary["nomination"]["successes"],
                   inspections=binary["inspectionCompleted"]["successes"],
                   supportExact=binary["supportedExact"]["successes"],
                   supportJitter=binary["supportedJitter"]["successes"],
                   restrictedEncounterSeconds=cont["restrictedEncounterSeconds"]["mean"],
                   distanceToEncounterOrSearchEnd=cont["distanceAtEncounterOrSearchEnd"]["mean"],
                   scanHeldSeconds=cont["scanHeldSeconds"]["mean"],
                   nominationErrorMedianMetres=float(np.median(errors)) if errors else None,
                   nominationErrorCount=len(errors),
                   supportedReleaseErrorMedianMetres=float(np.median(fitted_errors)) if fitted_errors else None,
                   supportedReleaseErrorRangeMetres=[min(fitted_errors), max(fitted_errors)] if fitted_errors else None,
                   supportedWithinPointOneMetres=sum(e <= .1 for e in fitted_errors),
                   nominationObservationAgeMedianSeconds=float(np.median(ages)) if ages else None,
                   nominationObservationAgeRangeSeconds=[min(ages), max(ages)] if ages else None,
                   totalMissionSeconds=cont["completedAt"]["mean"],
                   totalAirLitres=cont["airLitres"]["mean"],
                   acquisitionDistanceMetres=cont["acquisitionDistanceMetres"]["mean"])
        rows.append(row)
        diagnostics.append(dict(field=arm["field"], algorithm=label,
                                stages=dict(collections.Counter(r["summary"]["stage"] for r in group)),
                                exactVerificationReasons=dict(reasons)))
    result = dict(auditSha256=closure["independentAuditSha256"], rows=rows,
                  pairedContrasts=perf["pairedContrasts"], diagnostics=diagnostics,
                  note="Descriptive exploratory comparison, 16 paired worlds. Supported local maxima are not physical source confirmations. Nomination error is conditional on a nominee.")
    (a.output / "summary.json").write_text(json.dumps(result, indent=2, allow_nan=False) + "\n")
    text = ["# Stage 2h campaign: independently accepted results", "",
            "All 288 raw histories and all 48 coupled-resolution comparisons pass the independent Mac audit. "
            "Performance uses only the 192 fine-resolution primary missions across 16 paired worlds. "
            "Mesh and reporting repeats are not independent samples.", "",
            "The frozen reference uses a 10 m domain, 0.1 m/s robot speed, 0.02 m/s constant wind, "
            "0.001 m²/s effective diffusivity, 5 cm sensing height and 10 cm opposing-inlet separation. "
            "Each channel has continuous 0.25 L/min flow through a 1 m long, 2 mm bore tube; "
            "rise/recovery time constants are 0.91024/2 s, averaging and readout intervals are both 1 s. "
            "These are declared numerical design assumptions, not a validated commercial sensor package.", "",
            "| Field | Method | Encounters /16 | Nominees /16 | Inspections /16 | Supported exact / jitter | Restricted encounter time (s) | Scan hold (s) |",
            "|---|---|---:|---:|---:|---:|---:|---:|"]
    for r in rows:
        text.append(f"| {FIELDS[r['field']]} | {r['algorithm']} | {r['encounters']} | {r['nominations']} | {r['inspections']} | {r['supportExact']} / {r['supportJitter']} | {r['restrictedEncounterSeconds']:.1f} | {r['scanHeldSeconds']:.1f} |")
    text += ["", "## What this means", "",
             "Encounter-gating improves acquisition over periodic quad in this controlled panel, while surge–cast "
             "reaches gas sooner on average. The gated quad's continuous-release local-maximum support is promising, "
             "but every pulsed inspection abstains. These outcomes favor replication and timing-envelope analysis "
             "over another broad algorithm redesign.", "",
             "A supported maximum is not a release-location success. As a retrospective check against the author's "
             "earlier 1%-domain target (0.10 m here), the supported exact-coordinate reports give:", "",
             "| Field | Method | Supported reports | Median release error (m) | Range (m) | Supported and within 0.10 m /16 |",
             "|---|---|---:|---:|---|---:|"]
    for r in rows:
        if r["supportExact"]:
            lo, hi = r["supportedReleaseErrorRangeMetres"]
            text.append(f"| {FIELDS[r['field']]} | {r['algorithm']} | {r['supportExact']} | {r['supportedReleaseErrorMedianMetres']:.4f} | {lo:.4f}–{hi:.4f} | {r['supportedWithinPointOneMetres']} |")
    text += ["", "This diagnostic does not change the frozen maximum-support endpoint. No oracle bias correction "
             "is applied and no tolerance is enlarged. The separate [target-offset diagnostic](target-offset-diagnostic.json) "
             "compares fitted points with an evaluator-only pointwise maximum of the same forward model; "
             "it does not constitute external validation."]
    text += ["", "## Prespecified paired scheduling contrasts", "",
             "Differences are encounter-gated minus periodic quad; intervals are the frozen 10,000-resample paired-world percentile 95% intervals. "
             "A negative time difference is faster. No formal superiority test was specified.", "",
             "| Field | Encounter proportion difference [95% interval] | Restricted time difference (s) [95% interval] | Scan hold difference (s) [95% interval] |",
             "|---|---:|---:|---:|"]
    for c in perf["pairedContrasts"]:
        cols = []
        for key in ("encounter", "restrictedEncounterSeconds", "scanHeldSeconds"):
            st = c["metrics"][key]
            lo, hi = st["bootstrapPercentile95"]
            scale = 100 if key == "encounter" else 1
            suffix = " pp" if key == "encounter" else ""
            cols.append(f"{st['mean']*scale:.1f}{suffix} [{lo*scale:.1f}, {hi*scale:.1f}]")
        text.append(f"| {FIELDS[c['field']]} | " + " | ".join(cols) + " |")
    text += ["", "## Failure accounting", "",
             "The following exact-coordinate reasons are counted once per completed primary inspection; "
             "the jittered result is a paired reporting sensitivity, not another experiment.", ""]
    for d in diagnostics:
        text.append(f"- {FIELDS[d['field']]} / {d['algorithm']}: stages {json.dumps(d['stages'])}; verifier reasons {json.dumps(d['exactVerificationReasons'])}.")
    text += ["", "## Retrospective nomination and resource diagnostics", "",
             "Nomination error is relative to the atmospheric release coordinate, not the field maximum or a buried defect. "
             "Error and observation age are conditional on nomination and must not be used as all-mission performance rankings. "
             "Observation age alone does not demonstrate staleness-induced failure.", "",
             "| Field | Method | Nominee count | Median release-coordinate error (m) | Median observation age (s) | Mean acquisition distance (m) | Mean full mission (s) | Mean sampled air (L) |",
             "|---|---|---:|---:|---:|---:|---:|---:|"]
    for r in rows:
        error = "—" if r["nominationErrorMedianMetres"] is None else f"{r['nominationErrorMedianMetres']:.3f}"
        age = "—" if r["nominationObservationAgeMedianSeconds"] is None else f"{r['nominationObservationAgeMedianSeconds']:.1f}"
        text.append(f"| {FIELDS[r['field']]} | {r['algorithm']} | {r['nominationErrorCount']} | {error} | {age} | {r['acquisitionDistanceMetres']:.2f} | {r['totalMissionSeconds']:.1f} | {r['totalAirLitres']:.2f} |")
    text += ["", "## Interpretation limits", "",
             "The tested field is a flat neutral halfspace with prescribed constant wind and ideal odometry. "
             "Hardware timing and geometry are explicit numerical assumptions, not calibration. "
             "No urban-flow, active suction reach, soil–air coupling or buried-defect validation follows. "
             "Non-detection remains unresolved; the blank control does not prove absence in field surveys.", "",
             "The comparator implementations share nomination and verification and are therefore acquisition integrations, "
             "not complete canonical literature methods. The 16-world intervals can be broad, and zero observed events "
             "do not establish zero population risk.", ""]
    (a.output / "report.md").write_text("\n".join(text))
    plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 10, "axes.spines.top": False,
                         "axes.spines.right": False, "svg.fonttype": "none", "pdf.fonttype": 42})
    fig, axes = plt.subplots(3, 2, figsize=(11, 9.5), layout="constrained")
    colors = ["#757575", "#2166ac", "#b35806", "#1b7837"]
    for col, field in enumerate(("si-continuous", "si-pulse")):
        selected = [x for x in perf["arms"] if x["field"] == field]
        for i, arm in enumerate(selected):
            rate = arm["binary"]["encounter"]
            v = rate["proportion"] * 100
            lo, hi = np.array(rate["wilson95"]) * 100
            axes[0, col].errorbar(i, v, yerr=[[v-lo], [hi-v]], fmt="o", color=colors[i], capsize=4, markersize=7)
            st = arm["continuous"]["restrictedEncounterSeconds"]
            lo, hi = st["bootstrapPercentile95"]
            axes[1, col].errorbar(i, st["mean"], yerr=[[max(0, st["mean"]-lo)], [max(0, hi-st["mean"])]],
                                  fmt="o", color=colors[i], capsize=4, markersize=7)
            rate = arm["binary"]["supportedExact"]
            v = rate["proportion"] * 100
            lo, hi = np.array(rate["wilson95"]) * 100
            axes[2, col].errorbar(i, v, yerr=[[v-lo], [hi-v]], fmt="o", color=colors[i], capsize=4, markersize=7)
        axes[0, col].set_title(FIELDS[field] + " source")
        for ax in axes[:, col]:
            ax.set_xticks(range(4), ["Coverage", "Surge–cast", "Periodic\nquad", "Encounter-gated\nquad"])
            ax.grid(axis="y", color="#dddddd", linewidth=.6)
            ax.set_axisbelow(True)
            ax.set_xlim(-.4, 3.4)
        axes[0, col].set_ylim(0, 105)
        axes[1, col].set_ylim(0, 630)
        axes[2, col].set_ylim(0, 105)
    axes[0, 0].set_ylabel("Eligible encounter (%)\nWilson 95% interval")
    axes[1, 0].set_ylabel("Restricted encounter time (s)\nPaired-world bootstrap 95% interval")
    axes[2, 0].set_ylabel("Local-maximum support (%)\nWilson 95% interval")
    fig.suptitle("Acquisition and local verification in 16 paired worlds", fontsize=14)
    for ext in ("png", "svg", "pdf"):
        fig.savefig(a.output / f"acquisition_comparison.{ext}", dpi=200)
    plt.close(fig)
    print(json.dumps(dict(rows=len(rows), auditSha256=result["auditSha256"], report=str(a.output / "report.md"))))


if __name__ == "__main__":
    main()
