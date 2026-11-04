# Pstack audit — original evidence

This directory preserves the engineering review of commit
`3507527250400d25081f3793191084c9c3356a56`, dated 3 November 2026. Its findings
describe that exact snapshot. The report and evidence have not been revised to
make them describe the subsequent fixes.

- [Read the review](review.md).
- [Download the original report PDF](Plumnav_Pstack_Review_2026-11-03.pdf).
- [Download the complete evidence archive](Plumnav_Pstack_Evidence_2026-11-03.zip).
- [Review the implementation response](../../review-followup-2026-11-04.md).

The ZIP contains 80 files: independent review notes and executable probes,
command logs (including failed attempts), raw simulated mission outputs,
environment and acceptance records, and the mission figure with its CSV and
plotting script. It excludes the repository checkout and installed dependencies.
The reproduction section in the report explains how to obtain the reviewed
commit and place it next to the probes. The original report is also included in
the ZIP so that it remains a self-contained evidence bundle.

`SHA256SUMS` records the three original deliverables in this directory. From
this directory, run `sha256sum --check SHA256SUMS` to verify them. The ZIP also
contains its original internal manifest. Current tests and transport results
are recorded separately in the implementation response.
