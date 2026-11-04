"""Plot fixed-track methane replays. Run beside the supplied CSV, from any cwd.

To rebuild the CSV first, use: python plot.py matrix-replay.json blackpool-replay.json
The JSON files are stdout from methane-field-matrix.ts and blackpool-field-replay.ts.
"""
import argparse
import csv
import json
from math import ceil, isfinite
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.ticker import MultipleLocator

ROOT = Path(__file__).resolve().parent
CSV = ROOT / "survey-distances.csv"
STYLES = {
    "MATRIX": ("#0C6D74", "o", "MATRIX, Switzerland"),
    "UAV1": ("#CE7440", "s", "Blackpool, UAV1"),
    "UAV2": ("#405D94", "^", "Blackpool, UAV2"),
}


def build_csv(matrix_path, blackpool_path):
    matrix = json.loads(matrix_path.read_text(encoding="utf-8"))
    blackpool = json.loads(blackpool_path.read_text(encoding="utf-8"))
    rows = [
        ("MATRIX", r["flight"], r["validReadings"], r["closestTrackMetres"],
         r["sourceErrorMetres"], matrix["doi"])
        for r in matrix["results"]
    ]
    for r in blackpool["results"]:
        group = {"T1": "UAV1", "T2": "UAV2"}[r["survey"].split(".")[0]]
        rows.append((group, r["survey"], r["samples"], r["closestSampleM"],
                     r["peakErrorM"], blackpool["study"]))
    with CSV.open("w", newline="", encoding="utf-8") as stream:
        writer = csv.writer(stream, lineterminator="\n")
        writer.writerow(("series", "flight_id", "samples", "nearest_sample_m",
                         "peak_error_m", "dataset_doi"))
        writer.writerows(rows)


def plot():
    with CSV.open(newline="", encoding="utf-8") as stream:
        records = list(csv.DictReader(stream))
    if len({(r["series"], r["flight_id"]) for r in records}) != len(records):
        raise ValueError("Duplicate flight ID in series")
    if set(r["series"] for r in records) != set(STYLES):
        raise ValueError("Expected the MATRIX, UAV1 and UAV2 survey series")
    plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 10,
                         "svg.fonttype": "none", "svg.hashsalt": "plumnav-field-surveys",
                         "pdf.fonttype": 42, "axes.axisbelow": True})
    fig, ax = plt.subplots(figsize=(5.8, 5.55))
    fig.subplots_adjust(left=0.16, right=0.94, bottom=0.14, top=0.92)
    for group, (color, marker, label) in STYLES.items():
        points = [r for r in records if r["series"] == group]
        x = [float(r["nearest_sample_m"]) for r in points]
        y = [float(r["peak_error_m"]) for r in points]
        if not all(isfinite(a) and isfinite(b) and 0 <= a <= b + 1e-9 for a, b in zip(x, y)):
            raise ValueError("Invalid on-track peak distance")
        ax.scatter(x, y, marker=marker, s=49, color=color, edgecolor="white",
                   linewidth=0.8, alpha=0.92, zorder=3, label=f"{label}  (n = {len(points)})")
    limit = 20 * ceil(max(float(r["peak_error_m"]) for r in records) / 20)
    ax.plot([0, limit], [0, limit], linestyle=(0, (4, 3)), color="#667580",
            linewidth=1.2, label="1:1 reference", zorder=1)
    ax.set(xlim=(0, limit + 2), ylim=(0, limit + 2), aspect="equal",
           xlabel="Closest horizontal approach to release (m)",
           ylabel="Horizontal error of peak-reading position (m)")
    ax.set_title("Methane surveys with known release positions", loc="left",
                 fontsize=12.2, fontweight="semibold", pad=11)
    ax.xaxis.set_major_locator(MultipleLocator(20))
    ax.yaxis.set_major_locator(MultipleLocator(20))
    ax.grid(color="#E4E9EC", lw=0.7)
    ax.spines[["top", "right"]].set_visible(False)
    ax.spines[["left", "bottom"]].set_color("#5C6B73")
    ax.tick_params(direction="out", length=3, color="#687680", pad=4)
    ax.legend(loc="upper left", frameon=False, fontsize=8.7,
              borderpad=0.5, labelspacing=0.65)
    svg = ROOT / "survey-distances.svg"
    fig.savefig(svg, metadata={"Date": None})
    svg.write_text("\n".join(line.rstrip() for line in svg.read_text(encoding="utf-8").splitlines()) + "\n", encoding="utf-8")
    fig.savefig(ROOT / "survey-distances.pdf", metadata={"CreationDate": None, "ModDate": None})
    plt.close(fig)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("replays", nargs="*", type=Path, metavar="JSON")
    args = parser.parse_args()
    if len(args.replays) == 2:
        build_csv(*args.replays)
    elif args.replays:
        parser.error("Supply both MATRIX and Blackpool replay JSON files, or neither")
    plot()
