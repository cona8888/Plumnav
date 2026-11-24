# Robotic gas survey planning: project hub

Updated 24 November 2026. This is the planning record for extending PlumeNav from
its existing gas-source simulator to prediction of survey feasibility and route
selection using site geometry, environmental conditions and sensor limits.

## Current status

| Item | Status |
| --- | --- |
| Existing simulator | Application and scripts imported on `main`; historical scope is recorded in [REPOSITORY_SCOPE.md](../../REPOSITORY_SCOPE.md). |
| Later commissioning work | [PR #1](https://github.com/cona8888/Plumnav/pull/1) is open; it is not merged by this planning update. |
| New survey-planning extension | Research plan, validation plan and four work packages prepared; implementation is pending. |
| Google Cloud application | Draft proposal and manual budget prepared; submission and award unconfirmed. |
| Annual budget | US$4,923.99 estimated; US$4,924 proposed credit request; US$5,000 ceiling. |
| Calculator share link | An updated, saved estimate remains outstanding. |
| Natanael's access | Invitation requested by the owner; GitHub identity and invitation remain unverified. |
| Native GitHub Wiki / Projects board | Publication and board setup remain pending; prepared wiki sources and live roadmap issues are linked below. |

## Read the plan

- [Research question, workflow and milestones](research-plan.md)
- [Validation and experiments](validation-plan.md)
- [Google Cloud proposal, budget and references](../funding/google-cloud-research-credits.md)
- [Machine-readable budget inputs](../funding/google-cloud-budget.json)
- [Contribution and onboarding guide](../../CONTRIBUTING.md)
- [Prepared wiki home](../../wiki/Home.md)

## Roadmap and live work items

Months are relative to the eventual project start. No calendar start date has
been confirmed. The `SP` prefix separates this track from the historical `M`
research milestones in the simulator.

| Work package | Period | Live issue | Completion evidence |
| --- | --- | --- | --- |
| SP1: Geometry, source priors and baseline surveys | Months 1–3 | [#2](https://github.com/cona8888/Plumnav/issues/2) | Licensed geometry contract and fixture, audited baseline, sensor and numerical readiness record. |
| SP2: Ensembles and feasibility prediction | Months 4–6 | [#3](https://github.com/cona8888/Plumnav/issues/3) | Versioned scenario dataset, evaluated surrogate probabilities and measured cloud costs. |
| SP3: Route optimisation | Months 7–9 | [#4](https://github.com/cona8888/Plumnav/issues/4) | Planning prototype and frozen comparisons on unseen scenarios. |
| SP4: Controlled validation and reporting | Months 10–12 | [#5](https://github.com/cona8888/Plumnav/issues/5) | Controlled-measurement comparison, reproducible package and research findings. |

Dependency order: SP1 → SP2 → SP3 → SP4. Experimental design and data-licence
checks can begin earlier; large simulation campaigns depend on local numerical
and sensor-calibration readiness. Every issue starts with implementation pending.

For a future GitHub Projects board, use the four linked issues as the initial
items and the states **Backlog, Ready, In progress, Validation, Done**. Move an
item to Done only when its stated evidence is linked. The issue checklists are
the current tracking record; a native board has not yet been created or verified.

## Next concrete steps

1. Verify Natanael's GitHub account and complete the repository invitation.
2. Audit the selected baseline and resolve which commissioning work from PR #1
   should be integrated through its existing review process.
3. Obtain a permitted site geometry fixture and define the observation contract.
4. Profile a small reproducible workload and save a current Google Cloud
   calculator estimate before submitting the credit request.

Future development must preserve the separation between detecting gas, identifying
a concentration peak, recommending reinspection and attributing a physical source.
Low predicted detectability does not demonstrate that a site is gas-free.
