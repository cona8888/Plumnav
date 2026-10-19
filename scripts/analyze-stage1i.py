#!/usr/bin/env python3
"""Frozen Stage 1i endpoints; stream verified production blocks without rerunning missions.

No field pooling, threshold tuning, or noise injection. Exact McNemar tests use
the binomial distribution of discordant pairs; Holm families contain six radii.
"""
import argparse
from collections import Counter, defaultdict
import gzip
import hashlib
import json
import math
from pathlib import Path
from statistics import median

MANIFEST_SHA = "b49f4828c2b162ab8a93a340bb0c785fb0ca9333a2f29c0f24a357cb8d477e69"
FIELDS = ["peak", "offset-peak", "ridge", "saddle", "plateau", "uniform", "blank",
          "clipped-peak", "si-continuous", "si-narrow", "si-pulse"]
POSITIVES = ["peak", "offset-peak", "si-continuous"]
RADII = [.005, .010, .015, .020, .030, .050]
STRUCTURES = ["independent", "constant-bias"]
ARMS = ["observed", "commanded"]


def wilson(k, n):
    if not 0 <= k <= n or n <= 0:
        raise ValueError("Invalid binomial counts")
    z = 1.959963984540054
    p, d = k / n, 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return {"count": k, "n": n, "proportion": p, "wilson95": [max(0, c-h), min(1, c+h)]}


def mcnemar_exact(b, c):
    n = b + c
    return min(1.0, 2 * sum(math.comb(n, j) for j in range(min(b, c) + 1)) / 2**n) if n else 1.0


def holm(values):
    result, previous = [None] * len(values), 0.0
    for rank, i in enumerate(sorted(range(len(values)), key=lambda i: values[i])):
        previous = max(previous, min(1.0, (len(values) - rank) * values[i]))
        result[i] = previous
    return result


def describe(values):
    values = sorted(x for x in values if x is not None and math.isfinite(x))
    if not values:
        return {"n": 0, "min": None, "median": None, "max": None}
    return {"n": len(values), "min": values[0], "median": median(values), "max": values[-1]}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def load_runs(root):
    # Production acceptance reports are necessary, not sufficient: recheck all
    # source block hashes and exact design membership in the current download.
    for name in ["verification.json", "independent-audit.json"]:
        report = json.loads((root / name).read_text())
        if report.get("accepted") is not True or report.get("mode") != "production":
            raise ValueError(f"Missing production acceptance: {name}")
    runs, provenance = {}, []
    expected = []
    for field in FIELDS:
        expected.append((field, "baseline", None, 0, "independent", "observed", 710001))
    for rep in range(50):
        for radius in RADII:
            for structure in STRUCTURES:
                for field in FIELDS:
                    for arm in ARMS:
                        expected.append((field, "position", rep, radius, structure, arm, 710001 + rep))
    for shard in range(4):
        worker = root / f"worker-{shard}"
        manifest = json.loads((worker / "manifest.json").read_text())
        complete = json.loads((worker / "complete.json").read_text())
        assert manifest["manifestSha256"] == MANIFEST_SHA
        assert complete["manifestSha256"] == MANIFEST_SHA
        assert manifest["mode"] == complete["mode"] == "production"
        assert complete["complete"] and complete["completed"] == complete["expected"]
        assert manifest["shardIndex"] == complete["shardIndex"] == shard
        assert manifest["shardCount"] == complete["shardCount"] == 4
        assigned = [i for i in range(13211) if i % 4 == shard]
        assert manifest["assignedCaseIndices"] == assigned
        assert complete["completed"] == len(assigned)
        assert {p.name for p in worker.glob("block-*.json.gz")} == {i["file"] for i in complete["inventory"]}
        for item in complete["inventory"]:
            path = worker / item["file"]
            assert path.parent == worker
            data = path.read_bytes()
            assert sha(data) == item["sha256"] and len(data) == item["bytes"]
            provenance.append({"file": str(path.relative_to(root)), "sha256": sha(data), "bytes": len(data)})
            block = json.loads(gzip.decompress(data))
            assert block["schemaVersion"] == "si-pose-registration-block-v1"
            assert [r["spec"]["index"] for r in block["records"]] == item["caseIndices"]
            for run in block["records"]:
                spec, summary, result = run["spec"], run["summary"], run["result"]
                i, u = spec["index"], spec["uncertainty"]
                assert i not in runs and i % 4 == shard and 0 <= i < 13211
                assert (spec["field"], spec["kind"], spec["replicate"], u["positionRadiusMetres"],
                        u["positionErrorStructure"], u["registration"], u["perturbationSeed"]) == expected[i]
                assert u["headingBoundRadians"] == 0
                assert result["status"] in ["supported", "abstained"]
                assert summary["status"] == result["status"] and summary["reason"] == result["reason"]
                assert not summary["nativeDeclaration"]
                assert len(run["visits"]) == 17 and all(v["closedAt"] is not None and len(v["samples"]) >= 2 for v in run["visits"])
                # Stronger paired check than offset equality: the retained
                # measurements, physical poses, headings, and times also match.
                physical = {k: run[k] for k in ["positionOffsetsMetres", "actualTargets", "actualSamples"]}
                signature = sha(json.dumps(physical, sort_keys=True, separators=(",", ":")).encode())
                runs[i] = {"spec": spec, "summary": summary, "result": result, "physicalSha256": signature}
    assert set(runs) == set(range(13211))
    return runs, provenance


def analyze(runs):
    baselines = {r["spec"]["field"]: r for r in runs.values() if r["spec"]["kind"] == "baseline"}
    assert all((baselines[f]["result"]["status"] == "supported") == (f in POSITIVES) for f in FIELDS)
    groups = defaultdict(dict)
    for run in runs.values():
        s, u = run["spec"], run["spec"]["uncertainty"]
        if s["kind"] == "position":
            key = (s["field"], u["positionRadiusMetres"], u["positionErrorStructure"], s["replicate"])
            assert u["registration"] not in groups[key]
            groups[key][u["registration"]] = run
    assert len(groups) == 6600
    for pair in groups.values():
        assert set(pair) == set(ARMS)
        assert pair["observed"]["physicalSha256"] == pair["commanded"]["physicalSha256"]
    strata = []
    for field in FIELDS:
        baseline = baselines[field]
        for structure in STRUCTURES:
            family = []
            for radius in RADII:
                pairs = [groups[field, radius, structure, rep] for rep in range(50)]
                row = {"field": field, "structure": structure, "radiusMetres": radius,
                       "radiusOverReferenceWidth": radius / .15, "radiusOverInspectionOffset": radius / .1,
                       "baselineStatus": baseline["result"]["status"], "baselineReason": baseline["result"]["reason"], "arms": {}}
                for arm in ARMS:
                    records = [p[arm] for p in pairs]
                    supported = [r for r in records if r["result"]["status"] == "supported"]
                    displacements = []
                    if field in POSITIVES:
                        b = baseline["result"]["peak"]
                        displacements = [.1 * math.hypot(r["result"]["peak"]["x"] - b["x"], r["result"]["peak"]["y"] - b["y"]) for r in supported]
                    row["arms"][arm] = {
                        "support": wilson(len(supported), 50),
                        "lossOfBaselineSupport": wilson(50-len(supported), 50) if field in POSITIVES else None,
                        "falseSupport": wilson(len(supported), 50) if field not in POSITIVES else None,
                        "reasons": dict(sorted(Counter(r["result"]["reason"] for r in records).items())),
                        "peakDisplacementFromBaselineMetresAmongSupported": describe(displacements),
                        **{key: describe([r["summary"][key] for r in records]) for key in ["completedAt", "pathLengthMeters", "maximumTargetOffsetMetres", "rmsTargetOffsetMetres", "retainedSamples", "clippedRetained"]}}
                counts = Counter((p["observed"]["result"]["status"] == "supported", p["commanded"]["result"]["status"] == "supported") for p in pairs)
                b, c = counts[True, False], counts[False, True]
                row["paired"] = {"n": 50, "bothSupported": counts[True, True], "neitherSupported": counts[False, False],
                    "observedOnly": b, "commandedOnly": c, "supportRiskDifference": (b-c)/50,
                    "mcnemarExactTwoSidedP": mcnemar_exact(b, c),
                    "reasonTransitionsObservedToCommanded": dict(sorted(Counter(p["observed"]["result"]["reason"] + " -> " + p["commanded"]["result"]["reason"] for p in pairs).items()))}
                family.append(row)
            adjusted = holm([r["paired"]["mcnemarExactTwoSidedP"] for r in family])
            for row, p in zip(family, adjusted):
                row["paired"]["holmWithinFieldStructureP"] = p
            strata.extend(family)
    return baselines, strata


def render_report(data):
    lines = ["# Stage 1i: frozen pose-registration replication results", "", "Analysis date: 2026-09-16. Post-candidate local-maximum verification, not autonomous GSL performance.", "",
             "## Integrity and inference", "", "All 13,211 case indices and 6,600 paired physical measurement histories were checked. Every compressed block matches its SHA-256 inventory. No v1 interrupted output is included.", "",
             "Each stratum has 50 paired perturbation seeds. Intervals are two-sided 95% Wilson intervals. Paired tests are exact two-sided McNemar tests, Holm-adjusted across six radii within each field/error-structure family (22 separate families, not experiment-wide correction). Zero observed false support is not proof of zero population risk. Baselines are deterministic fixtures (one per field), not replicated population estimates.", "",
             "## Unperturbed fixtures", "", "| Field | Status | Reason |", "|---|---|---|"]
    for f in FIELDS:
        r = data["baselines"][f]["result"]
        lines.append(f"| {f} | {r['status']} | {r['reason']} |")
    for f in FIELDS:
        lines += ["", f"## {f}", "", "Support count/50 [Wilson 95% interval]; Δ is observed minus commanded in percentage points. Discordance O/C means observed-only / commanded-only support.", "", "| Error structure | Radius (mm) | Observed | Commanded | Δ (pp) | O/C | Holm p |", "|---|---:|---|---|---:|---|---:|"]
        for r in [s for s in data["strata"] if s["field"] == f]:
            cells = []
            for arm in ARMS:
                s = r["arms"][arm]["support"]
                lo, hi = s["wilson95"]
                cells.append(f"{s['count']}/50 [{lo*100:.1f}, {hi*100:.1f}%]")
            p = r["paired"]
            lines.append(f"| {r['structure']} | {r['radiusMetres']*1000:g} | {' | '.join(cells)} | {p['supportRiskDifference']*100:+.0f} | {p['observedOnly']}/{p['commandedOnly']} | {p['holmWithinFieldStructureP']:.3g} |")
    lines += ["", "## Interpretation boundaries", "", "- `observed` uses exact retained simulator pose; it is an ideal registration arm, not noisy odometry or a validated navigation system.", "- Support concerns a locally fitted concentration maximum. It does not declare a buried leak location, and abstention does not mean absence of gas.", "- Zero physical readout noise, one world seed, prescribed candidates and the frozen sensing/inspection contract limit generalization.", "- Constant translation and visit-to-visit jitter are separate mechanisms. Do not pool their results.", "- Peak displacements in the JSON are conditional on continued support and relative to each unperturbed fitted peak. They are not end-to-end source-localization errors.", "- Detailed reasons, paired transitions, time/path, realized offsets, clipping and conditional peak displacement are in analysis.json. No thresholds or frozen campaign parameters were changed.", ""]
    return "\n".join(lines)


def make_plot(data, output):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    fig, axes = plt.subplots(2, 3, figsize=(11.5, 6.5), sharex=True, sharey=True)
    for ri, structure in enumerate(STRUCTURES):
        for ci, field in enumerate(POSITIVES):
            ax = axes[ri, ci]
            rows = [s for s in data["strata"] if s["field"] == field and s["structure"] == structure]
            for arm, color, marker, delta in [("observed", "#007C83", "o", -.0006), ("commanded", "#C46132", "s", .0006)]:
                y = [r["arms"][arm]["support"]["proportion"]*100 for r in rows]
                lo = [max(0, yy - r["arms"][arm]["support"]["wilson95"][0]*100) for yy, r in zip(y, rows)]
                hi = [max(0, r["arms"][arm]["support"]["wilson95"][1]*100 - yy) for yy, r in zip(y, rows)]
                ax.errorbar([(r["radiusMetres"]+delta)/.15 for r in rows], y, yerr=[lo,hi], marker=marker, color=color, label=arm, capsize=2, lw=1.4, ms=4)
            ax.set_title(field)
            ax.set_ylim(-5, 105)
            ax.grid(axis="y", alpha=.2)
            ax.spines[["top", "right"]].set_visible(False)
            if ci == 0:
                ax.set_ylabel(f"{structure}\nConditional support (%)")
            if ri == 1:
                ax.set_xlabel("Position-error radius / 0.15 m reference width")
    handles, labels = axes[0,0].get_legend_handles_labels()
    fig.legend(handles, ["Actual-pose registration (ideal)", "Commanded-coordinate registration"], loc="lower center", ncol=2, frameon=False, bbox_to_anchor=(.5, .025))
    fig.suptitle("Effect of position error and coordinate registration on local verification", fontsize=14)
    fig.text(.5, .005, "50 paired seeds per point; Wilson 95% intervals. Prescribed local verification only; not leak-localization success.", ha="center", fontsize=9)
    fig.tight_layout(rect=(0,.10,1,.95))
    fig.savefig(output / "positive-support.png", dpi=180)
    fig.savefig(output / "positive-support.svg")
    plt.close(fig)


def main():
    if not __debug__:
        raise RuntimeError("Integrity assertions must be enabled; do not run Python with -O")
    p = argparse.ArgumentParser()
    p.add_argument("--input", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--plot", action="store_true")
    a = p.parse_args()
    runs, inventory = load_runs(a.input)
    baselines, strata = analyze(runs)
    data = {"schemaVersion": "stage1i-analysis-v1", "manifestSha256": MANIFEST_SHA,
            "analysisScriptSha256": sha(Path(__file__).read_bytes()), "records": len(runs), "physicalPairsChecked": 6600,
            "methods": {"proportions": "two-sided 95% Wilson", "pairedTest": "exact two-sided McNemar", "multiplicity": "Holm, six radii per field/error structure; 22 families", "peakDisplacement": "relative to unperturbed fitted peak, among supported positives only; inspection offset 0.1 m"},
            "sourceInventory": inventory, "baselines": baselines, "strata": strata}
    a.output.mkdir(parents=True, exist_ok=True)
    (a.output / "analysis.json").write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")
    (a.output / "results.md").write_text(render_report(data))
    (a.output / "run-summaries.json").write_text(json.dumps([runs[i] for i in sorted(runs)], sort_keys=True, separators=(",", ":")) + "\n")
    if a.plot:
        make_plot(data, a.output)
    print(json.dumps({"records": len(runs), "strata": len(strata), "physicalPairsChecked": 6600, "output": str(a.output)}))


if __name__ == "__main__":
    main()
