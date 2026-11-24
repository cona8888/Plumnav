# Survey planning research plan

**Status:** proposed 12-month track, recorded 24 November 2026. Start date remains
unconfirmed. SP1–SP4 are separate from the historical M-series milestones.

## Baseline and evidence boundary

The baseline is the TypeScript/Vite source snapshot at
`452d285e3ca6c8cfd6209bfbfe035e7ce0496fe7`, with the existing 2D simulator and
robotic controllers. The [README](../../README.md) describes historical research,
but the [repository scope](../../REPOSITORY_SCOPE.md) deliberately excludes its
`research/` evidence and archives. Importing the source did not run or validate it.
[PR #1](https://github.com/cona8888/Plumnav/pull/1) contains later validation work
and is open work, not merged baseline evidence for this plan.

The live demo uses normalized transport and concentration settings. Displaying a
map in metres does not establish physical calibration. Existing method scores
are not calibrated detection probabilities.

## Research question and proposed workflow

Can site geometry, environmental conditions, sensor characteristics and uncertain
emissions predict whether a robotic survey will detect gas within a fixed mission
budget, and which routes provide useful evidence for source localisation?

1. Define a geometry input contract: coordinate reference system, physical units,
   resolution, obstacle footprints, traversable regions and uncertainty. Use
   independently licensed geospatial data or original surveys. Google Maps will
   display sites and routes; its [Map Tiles policy](https://developers.google.com/maps/documentation/tile/policies)
   restricts extracting geometry and other non-visualisation analysis.
2. Specify wind, environmental variability, sensor detection limits and response,
   and uncertain source locations and emission rates. Pipe alignments inform
   priors for possible point leaks; distributed emissions require a separate
   source model. Include plausible sources away from mapped infrastructure.
3. Generate dispersion and survey ensembles after the
   [validation gates](validation-plan.md). Train fast surrogate predictions using
   development data and test their calibration on untouched scenarios.
4. Screen candidate surveys before a new detailed simulation or deployment.
   Recommend routes and survey conditions using detection probability, time and
   localisation performance as distinct objectives.

Feasibility is conditional on the stated priors, transport model and instrument.
Weak emissions and unfavourable winds can reduce detectability; a low predicted
probability does not establish absence of gas. The 2D approximation requires
independent transport assessment.

## Milestones and deliverables

| ID | Relative period | Deliverable |
| --- | --- | --- |
| SP1 | Months 1–3 | Reproduced baseline, geometry/infrastructure contracts, sensor and numerical gates, systematic coverage reference |
| SP2 | Months 4–6 | Versioned ensembles and surrogate predictions with uncertainty; bounded cloud pilot after local gates |
| SP3 | Months 7–9 | Route optimisation, held-out comparisons and planning prototype |
| SP4 | Months 10–12 | Controlled experimental comparison, limitations report and reproducible research outputs |

The [Google Cloud application and budget](../funding/google-cloud-research-credits.md)
record a manually estimated US$4,923.99 workload. Funding, a saved calculator
estimate and cloud execution are not confirmed. Benchmark runtime locally before
budgeting cloud job counts.
Use the [contribution guide](../../CONTRIBUTING.md) for collaboration.
