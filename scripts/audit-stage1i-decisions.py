#!/usr/bin/env python3
"""Independent SVD least-squares recomputation of the frozen verifier decisions.

Consumes recorded measurements, never imports simulator/controller code and
never changes the saved results. This verifies the numerical implementation,
not the physical validity of the transport or sensing models.
"""
import argparse
from collections import Counter
import gzip
import hashlib
import json
import math
from pathlib import Path
import numpy as np


def recompute(visits):
    medians = np.array([sorted(s["value"] for s in v["samples"])[len(v["samples"])//2] for v in visits])
    xy = np.array([[sum(s[k] for s in v["samples"])/len(v["samples"]) for k in ("x", "y")] for v in visits])
    x, y = xy.T
    design = np.column_stack((np.ones(len(visits)), x, y, x*x/2, x*y, y*y/2))
    coefficients, _, rank, _ = np.linalg.lstsq(design, medians, rcond=None)
    if rank != 6:
        raise ValueError(f"Rank-deficient design: {rank}")
    rmse = float(np.sqrt(np.mean((design @ coefficients-medians)**2)))
    hessian = np.array([[coefficients[3], coefficients[4]], [coefficients[4], coefficients[5]]])
    eigen = float(np.linalg.eigvalsh(hessian)[-1])
    peak = -np.linalg.solve(hessian, coefficients[1:3]) if abs(np.linalg.det(hessian)) > 1e-12 else None
    margin = .003
    gates = {
        "telemetry": all(s["telemetryComplete"] for v in visits for s in v["samples"]),
        "clipped": any(s["clipped"] for v in visits for s in v["samples"]),
        "complete": len(visits) == 17 and all(v["closedAt"] is not None and len(v["samples"]) >= 2 for v in visits),
        "core": all(medians[i] >= .16 and sum(s["hit"] for s in visits[i]["samples"]) >= 2 for i in range(0, 17, 2)),
        "stable": bool(all(abs(medians[i]-medians[i+2]) <= max(margin, .05*min(medians[i],medians[i+2])) for i in range(0, 15, 2)))
    }
    reason = next((name for passed, name in [
        (gates["telemetry"], "missing-channel-telemetry"),
        (not gates["clipped"], "clipped-required-measurement"),
        (gates["complete"], "insufficient-samples"),
        (gates["core"], "insufficient-signal"),
        (gates["stable"], "temporal-inconsistency"),
        (rmse <= margin, "spatial-model-mismatch"),
        (eigen < -2*margin, "not-negative-definite"),
        (peak is not None and np.linalg.norm(peak) <= 1, "maximum-outside-probed-region")
    ] if not passed), "local-quadratic-supported")
    return {"reason": reason, "gates": gates, "coefficients": coefficients,
            "rmse": rmse, "eigenMax": eigen, "peak": peak, "medians": medians}


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--input", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    a = p.parse_args()
    failures, counts, diagnostic, seen = [], Counter(), [], set()
    max_error = {"coefficients": 0., "rmse": 0., "eigenMax": 0., "supportedPeakNormalized": 0.}
    for worker in sorted(a.input.glob("worker-*")):
        manifest = json.loads((worker / "manifest.json").read_text())
        complete = json.loads((worker / "complete.json").read_text())
        for item in complete["inventory"]:
            raw = (worker / item["file"]).read_bytes()
            if hashlib.sha256(raw).hexdigest() != item["sha256"] or len(raw) != item["bytes"]:
                raise ValueError(f"Checksum mismatch: {worker.name}/{item['file']}")
            for record in json.loads(gzip.decompress(raw))["records"]:
                index, old = record["spec"]["index"], record["result"]
                if index in seen:
                    raise ValueError(f"Duplicate index {index}")
                seen.add(index)
                new = recompute(record["visits"])
                counts[new["reason"]] += 1
                expected_status = "supported" if new["reason"] == "local-quadratic-supported" else "abstained"
                if new["reason"] != old["reason"] or expected_status != old["status"] or new["gates"] != old["gates"]:
                    failures.append({"index": index, "savedReason": old["reason"], "recomputedReason": new["reason"]})
                differences = {"coefficients": float(np.max(np.abs(new["coefficients"]-old["coefficients"]))),
                               "rmse": abs(new["rmse"]-old["rmse"]), "eigenMax": abs(new["eigenMax"]-old["eigenMax"])}
                if expected_status == "supported":
                    differences["supportedPeakNormalized"] = float(np.linalg.norm(new["peak"]-[old["peak"]["x"],old["peak"]["y"]]))
                for key, value in differences.items():
                    max_error[key] = max(max_error[key], value)
                    if value > 1e-9:
                        failures.append({"index": index, "quantity": key, "absoluteDifference": value})
                spec, u = record["spec"], record["spec"]["uncertainty"]
                if spec["field"] == "si-continuous" and u["registration"] == "observed" and new["reason"] == "temporal-inconsistency":
                    comparisons = []
                    for i in range(0, 15, 2):
                        delta = float(abs(new["medians"][i]-new["medians"][i+2]))
                        threshold = max(.003, .05*float(min(new["medians"][i],new["medians"][i+2])))
                        if delta > threshold:
                            positions = []
                            for j in (i,i+2):
                                samples = record["actualSamples"][j]
                                positions.append([sum(s["position"][k] for s in samples)/len(samples) for k in ("x","y")])
                            comparisons.append({"visitIndices": [i,i+2], "concentrationDifferenceC0": delta,
                                "allowedDifferenceC0": threshold,
                                "achievedPositionSeparationMetres": manifest["configs"][spec["field"]]["domainMeters"]*math.dist(*positions)})
                    diagnostic.append({"index": index, "replicate": spec["replicate"], "radiusMetres": u["positionRadiusMetres"],
                        "allOtherDecisionGatesPass": bool(new["gates"]["complete"] and new["gates"]["telemetry"] and not new["gates"]["clipped"] and new["gates"]["core"] and new["rmse"] <= .003 and new["eigenMax"] < -.006 and new["peak"] is not None and np.linalg.norm(new["peak"]) <= 1),
                        "failedCenterComparisons": comparisons})
    if seen != set(range(13211)):
        failures.append({"error": "case-set mismatch", "count": len(seen)})
    report = {"schemaVersion": "stage1i-independent-decision-audit-v1", "accepted": not failures,
              "records": len(seen), "method": "NumPy SVD least squares and symmetric Hessian eigensolver; no simulator imports",
              "numpyVersion": np.__version__, "absoluteComparisonTolerance": 1e-9,
              "scriptSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              "maximumAbsoluteDifferences": max_error, "reasonCounts": dict(sorted(counts.items())),
              "failures": failures, "exploratoryContinuousPlumeTemporalGateDiagnostics": diagnostic,
              "diagnosticCaution": "Post-hoc mechanism check only. Gate compares unequal achieved positions; rejection reason does not isolate temporal variation. No corrected gate was fitted or validated."}
    a.output.write_text(json.dumps(report, indent=2, sort_keys=True)+"\n")
    print(json.dumps({k: v for k,v in report.items() if k != "exploratoryContinuousPlumeTemporalGateDiagnostics"}, indent=2))
    raise SystemExit(0 if report["accepted"] else 1)


if __name__ == "__main__":
    main()
