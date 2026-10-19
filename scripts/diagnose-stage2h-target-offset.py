#!/usr/bin/env python3
"""Post-hoc evaluator-only release/maximum distinction; no policy modification."""
import argparse
import hashlib
import json
import math
from pathlib import Path

import numpy as np
from scipy.optimize import minimize_scalar
from lib.si_head_motion_audit import physical_values


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--audit", type=Path, required=True)
    p.add_argument("--closure", type=Path, required=True)
    p.add_argument("--manifest", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    a = p.parse_args()
    body = a.audit.read_bytes()
    closure = json.loads(a.closure.read_text())
    assert closure["accepted"] and hashlib.sha256(body).hexdigest() == closure["independentAuditSha256"]
    data = json.loads(body)
    manifest_body = a.manifest.read_bytes()
    assert hashlib.sha256(manifest_body).hexdigest() == data["manifestSha256"]
    manifest = json.loads(manifest_body)
    configs = {s["index"]: c for s, c in zip(manifest["cases"], manifest["configs"])}
    rows = []
    for r in data["runs"]:
        if r["spec"]["caseRole"] != "primary" or r["spec"]["field"] != "si-continuous":
            continue
        reports = [e for e in r["summary"]["errors"] if e["poseRadiusMetres"] == 0 and e["reportedPoint"] is not None]
        if not reports:
            continue
        assert len(reports) == 1
        c = configs[r["spec"]["index"]]
        source = np.array([c["sourcePositionOverride"][k] for k in ("x", "y")])
        theta = math.radians(c["windDirectionDegrees"])
        direction = np.array([math.sin(theta), -math.cos(theta)])
        L = c["domainMeters"]
        t = r["summary"]["completedAt"]
        def concentration(offset):
            point = source + np.asarray(offset)[..., None] * direction / L
            return physical_values(point, t, c, r["spec"])
        grid = np.linspace(-.5, 2, 501)
        values = concentration(grid)
        k = int(np.argmax(values))
        assert 0 < k < len(grid) - 1
        optimum = minimize_scalar(lambda x: -float(concentration(x)),
                                  bounds=(grid[k-1], grid[k+1]), method="bounded",
                                  options={"xatol": 1e-11})
        assert optimum.success
        peak = source + optimum.x * direction / L
        point = np.array([reports[0]["reportedPoint"][k] for k in ("x", "y")])
        error = float(np.linalg.norm(point - source) * L)
        assert abs(error - reports[0]["sourceErrorMetres"]) < 1e-12
        rows.append(dict(index=r["spec"]["index"], world=r["spec"]["worldIndex"],
                         method=r["spec"]["method"], policy=r["spec"]["policy"],
                         endTimeSeconds=t, fittedPointReleaseErrorMetres=error,
                         pointwiseMaximumReleaseOffsetMetres=float(optimum.x),
                         fittedPointToPointwiseMaximumMetres=float(np.linalg.norm(point - peak) * L),
                         withinOnePercentDomainOfRelease=bool(error <= .01 * L)))
    groups = []
    for policy in ("reference", "encounter-gated"):
        subset = [r for r in rows if r["policy"] == policy]
        assert subset
        groups.append(dict(method="quad-sniff-refine", policy=policy, supportedReports=len(subset),
                           medianReleaseErrorMetres=float(np.median([r["fittedPointReleaseErrorMetres"] for r in subset])),
                           releaseErrorRangeMetres=[min(r["fittedPointReleaseErrorMetres"] for r in subset), max(r["fittedPointReleaseErrorMetres"] for r in subset)],
                           medianPointwisePeakErrorMetres=float(np.median([r["fittedPointToPointwiseMaximumMetres"] for r in subset])),
                           withinOnePercentDomainOfRelease=sum(r["withinOnePercentDomainOfRelease"] for r in subset)))
    result = dict(schemaVersion="stage2h-target-offset-diagnostic-v1", retrospective=True,
                  auditSha256=closure["independentAuditSha256"], groups=groups, rows=rows,
                  interpretation="The original endpoint remains supported local maximum, not release localization. The 1%-domain check is a retrospective diagnostic, not a changed success criterion. Pointwise maxima use evaluator-only true field parameters at mission end; no oracle correction is supplied to any policy. A four-inlet, time-filtered local fit need not equal this instantaneous pointwise maximum. This is within-model diagnosis, not external physical validation.")
    with a.output.open("x") as f:
        json.dump(result, f, indent=2, allow_nan=False)
        f.write("\n")
    print(json.dumps(groups, indent=2))


if __name__ == "__main__":
    main()
