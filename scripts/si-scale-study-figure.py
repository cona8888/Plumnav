"""Descriptive paired development observations; no confidence intervals."""
import json
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

ROOT = Path(__file__).resolve().parents[1]
rows = json.loads((ROOT / 'research/evidence/si_scale_study_2026-09-14_v2/summary.json').read_text())['rows']
out = ROOT / 'research/results/si_scale_implementation_2026-09-14'
out.mkdir(parents=True, exist_ok=True)
plt.rcParams.update({'font.family': 'DejaVu Sans', 'font.size': 9, 'axes.spines.top': False,
                     'axes.spines.right': False, 'svg.fonttype': 'none', 'pdf.fonttype': 42})
fig, axes = plt.subplots(1, 2, figsize=(9.2, 3.7), layout='constrained')
colors = ['#2166ac', '#1b7837', '#762a83', '#b35806']
ids = ['reference', 'speed-0.03', 'dwell-24', 'speed-0.01']
labels = ['v = 0.10 m/s\ndwell = 12 s', 'v = 0.03 m/s', 'dwell = 24 s', 'v = 0.01 m/s']
for name, label, color in zip(ids, labels, colors):
    subset = [r for r in rows if r['id'] == name]
    x = subset[0]['completedAt']
    ys = [r['retainedInstantaneousMismatchRmse'] * 1e3 for r in subset]
    axes[0].plot([x, x], ys, color=color, lw=1)
    axes[0].scatter([x, x], ys, c=color, s=29, zorder=3)
    axes[0].annotate(label, (x, max(ys)), xytext=(0, 7), textcoords='offset points', ha='center', fontsize=8)
axes[0].set(xlabel='Observed nine-visit completion time (s)', ylabel=r'Retained mismatch RMSE ($10^{-3} C_0$)',
            xlim=(119, 303), ylim=(.4, 1.17), title='a  Continuous release: time and mismatch')
axes[0].grid(axis='y', color='#dddddd', lw=.5)
ids = ['reference', 'pulse-20-0', 'pulse-20-5', 'pulse-40-0', 'pulse-40-5']
labels = ['Continuous', '20 s\nphase 0 s', '20 s\nphase 5 s', '40 s\nphase 0 s', '40 s\nphase 5 s']
for i, name in enumerate(ids):
    ys = [r['retainedInstantaneousMismatchRmse'] for r in rows if r['id'] == name]
    axes[1].scatter([i - .045, i + .045], ys, c='#2166ac' if i == 0 else '#b35806', s=29, zorder=3)
axes[1].set(yscale='log', ylabel=r'Retained mismatch RMSE ($C_0$)', ylim=(.0004, .3),
            title='b  Equal mean emission; prescribed pulses')
axes[1].set_xticks(range(5), labels)
axes[1].grid(axis='y', which='major', color='#dddddd', lw=.5)
fig.suptitle('Prescribed local inspection with fixed hardware', fontsize=12)
for ext in ['png', 'svg', 'pdf']:
    fig.savefig(out / f'scale_study.{ext}', dpi=220, metadata={'Creator': 'PlumeNav SI development analysis'} if ext == 'pdf' else None)
print(out)
