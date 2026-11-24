# Contributing to PlumeNav

## Start here

Read the [project hub](docs/survey-planning/README.md),
[research plan](docs/survey-planning/research-plan.md),
[validation plan](docs/survey-planning/validation-plan.md) and
[repository scope](REPOSITORY_SCOPE.md) before changing research behaviour.

The current `main` branch contains an imported TypeScript/Vite application and
scientific scripts. [PR #1](https://github.com/cona8888/Plumnav/pull/1) contains
later commissioning work and remains a separate open change set. Record the
branch and commit used for each experiment; do not treat an unmerged PR as the
default-branch baseline.

## Collaboration status

| Person | GitHub identity | Status on 24 November 2026 |
| --- | --- | --- |
| Project owner | [cona8888](https://github.com/cona8888) | Existing repository owner. |
| Natanael | Awaiting a verified username or profile URL | Owner has requested an invitation; no invitation or accepted membership is recorded yet. |

The intended invitation is for ordinary joint-development access. Verify the
recipient before granting access, then record whether the invitation is pending
or accepted. Agree responsibilities after onboarding; the roadmap issues are
currently unassigned.

## Development workflow

1. Select a roadmap issue and describe the proposed change and observable outcome.
2. Create a focused branch from the agreed baseline.
3. Follow the [README setup instructions](README.md#run-locally) and the package
   manager version recorded in `package.json`. Keep the same Node/V8 runtime for
   comparisons that rely on deterministic replay.
4. Run checks appropriate to the change. Document missing historical archives
   explicitly; some research commands require material excluded from this clone.
5. Open a pull request describing the research question, changed behaviour,
   evidence and remaining limitations. Keep documentation-only changes distinct
   from modifications to scientific code or recorded results.

For documentation edits, verify links, quantities, proposal length and status
statements. They do not establish numerical or physical validation of a model.

## Research records

For a new experiment, record the code commit, runtime/dependency versions,
configuration, independent seeds, geometry and data provenance, sensor settings,
units, train/validation/test partition and raw-output hashes. Compare methods on
paired scenarios and equal mission budgets. Freeze decisions before evaluating
held-out cases. Preserve negative results, false alarms, abstentions and failures.

Use data licensed for the intended modelling and redistribution. Publish source
references and permitted fixtures; keep credentials, restricted infrastructure
coordinates and unlicensed third-party material out of the repository. Preserve
the original source-snapshot manifest as historical provenance.

## Cloud work

The [Google Cloud budget](docs/funding/google-cloud-research-credits.md) is an
application planning estimate, not a running deployment or an approved award.
Profile a small local workload and satisfy the relevant numerical and calibration
requirements before scaling. Record actual job hours, storage, downloads and
costs against the proposed allowance. Keep the saved calculator link and any
award record current when those become available.
