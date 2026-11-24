# Google Cloud research credits: proposal and budget

Prepared: **24 November 2026**. Project: **Robotic Gas Source Localisation and Survey Planning Using Geospatial Data**.

## Status and scope

This is application preparation for the proposed survey-planning extension. A project start date, application submission, credit award and cloud deployment have **not been confirmed**. The proposed duration is 12 months from an agreed start date. The [research plan](../survey-planning/research-plan.md) and [validation plan](../survey-planning/validation-plan.md) define the work and its scientific gates.

The budget below is a **manual gross list-price estimate**, not a saved calculator result or an actual bill. The shared Google Cloud Pricing Calculator link and the calculator start page returned “Site Unavailable” during preparation. **No updated calculator estimate or share link was saved.** Enter the recorded quantities in the live calculator, check its regional and free-tier assumptions, and save its share link before completing that application field.

The repository's historical [source-snapshot scope](../../REPOSITORY_SCOPE.md) remains the provenance record for the imported application. This funding document reports no new scientific validation. Local numerical, observation-model and calibration gates must pass before broad cloud execution; the allocation is proposed capacity rather than a measured runtime requirement.

## Application proposal — 228 words

Robotic gas surveys can fail when emissions are too weak to detect under prevailing wind conditions. I will extend my existing 2D gas diffusion model and robotic simulator to predict survey feasibility and plan efficient routes for gas source localisation.

The framework will process appropriately licensed high-resolution geospatial data into site geometry and combine it with weather, sensor detection thresholds, and uncertain source locations and emission rates. Waste-pipe alignments will inform probabilistic source-location assumptions. Surrogate models trained on dispersion simulations will rapidly estimate detection probabilities, screening candidate surveys before detailed simulation or deployment.

GCP Compute Engine and Batch will run parallel simulations and model training; Cloud Storage will manage datasets; Cloud Run will host the planning prototype. Google Maps Platform will visualise sites and routes, with costs outside this credit request.

Months 1–3: integrate geometry and infrastructure data and establish baseline surveys.
Months 4–6: generate simulation ensembles and develop predictions with uncertainty estimates.
Months 7–9: implement route optimisation and test unseen scenarios.
Months 10–12: validate against controlled robotic experiments and deliver the prototype and research findings.

Outcomes will include feasibility maps, recommended survey routes and conditions, and a reproducible workflow. Evaluation will measure detection probability, localisation error and survey duration against systematic coverage routes.

Future GCP use will support 3D modelling, additional sites and coordinated surveys by multiple robots, enabling broader research into infrastructure inspection and environmental monitoring.

## Cost estimate and calculator inputs

**Proposed credit request: US$4,924.** Calculated annual total: **US$4,923.99**, within the US$5,000 ceiling. The numerical inputs and unrounded arithmetic are recorded in [google-cloud-budget.json](google-cloud-budget.json).

Assumptions: USD; **Iowa (`us-central1`)**; 12 months; on-demand CPU workers; Linux without paid OS licences; no GPU requirement assumed. Services and container images are colocated in the same region. The published Iowa rates were verifiable during preparation; selecting London requires a new regional calculation. Prices were checked on 24 November 2026. Taxes and free-tier deductions are not included.

| Service | Monthly usage allowance | Monthly USD | Annual USD |
|---|---|---:|---:|
| Compute Engine | Four `e2-standard-8` workers, 8 vCPUs/32 GiB each, **340 hours per worker**; 1,360 VM-hours at $0.26804568/hour | 364.54 | 4,374.51 |
| Standard Persistent Disk | Four 50 GiB boot disks; 200 GiB retained for the whole month at $0.04/GiB-month | 8.00 | 96.00 |
| Standard Cloud Storage and operations | 500 GiB at $0.02/GiB-month; 100,000 Class A operations at $0.005/1,000 and 1,000,000 Class B operations at $0.0004/1,000 | 10.90 | 130.80 |
| Internet data transfer | 100 GiB covering research downloads and the small interface, at $0.12/GiB | 12.00 | 144.00 |
| Ephemeral external IPv4 | One address per running worker; 1,360 address-hours at $0.005/hour | 6.80 | 81.60 |
| Cloud Run | 100,000 requests, 2 seconds/request, 1 vCPU, 0.5 GiB RAM; request-based billing, concurrency 1, minimum instances 0 | 5.09 | 61.08 |
| Artifact Registry | 5 GiB at approximately $0.10/GiB-month | 0.50 | 6.00 |
| Cloud Logging | 5 GiB at $0.50/GiB, with standard retention; gross amount before the free allowance | 2.50 | 30.00 |
| Batch scheduling | Underlying resources counted above; no separate scheduler charge | 0.00 | 0.00 |
| **Total** | | **410.33** | **4,923.99** |

Unrounded totals are **$410.3321248/month** and **$4,923.9854976/year**. Annual amounts use unrounded rates; rounding displayed monthly values first produces a small difference. The calculated headroom is approximately **$76.01**; the rounded $4,924 request leaves $76 against the ceiling.

Cloud Run's gross calculation is 200,000 vCPU-seconds × $0.000024 + 100,000 GiB-seconds × $0.0000025 + 0.1 million requests × $0.40 = **$5.09/month**. Available free allowances can reduce Cloud Run, storage, registry, disk or logging charges; the live calculator may therefore show a lower total. Five GiB of ordinary project logs would normally fall within Cloud Logging's free allowance. Do not describe the gross forecast as a free-tier-adjusted bill.

The worker allocation totals **16,320 VM-hours / 130,560 vCPU-hours per year**. Profile the existing simulator before fixing ensemble sizes, training runs or cloud job schedules. Boot disks are costed for provisioned lifetime, even when workers are stopped. Container builds use existing computing resources; this estimate adds no Cloud Build usage. The 100 GiB transfer allowance covers relevant Internet transfers in aggregate. It assumes no cross-region pipeline, Cloud NAT, load balancer, Kubernetes cluster, extended log retention or optional artifact scanning. Keep numerical outputs in Cloud Storage rather than logging full fields. Actual costs depend on the final configuration and usage.

## Maps and geometry inputs

[Google Cloud research credits exclude Google Maps Platform products](https://support.google.com/google-cloud-higher-ed/answer/10723679?hl=en), so map display costs need separate provision. [Map Tiles policies](https://developers.google.com/maps/documentation/tile/policies) restrict geodata extraction and non-visualisation use. Use independently licensed geospatial data or owned survey data for modelling, and document provenance and permitted uses. The proposal does not assume permission to extract simulation geometry from Google Maps tiles.

## Official references

- [Research credit application and 250-word proposal field](https://edu.google.com/programs/credits/research/).
- [Compute Engine general-purpose VM pricing](https://cloud.google.com/products/compute/pricing/general-purpose).
- [Disk pricing](https://cloud.google.com/compute/disks-image-pricing).
- [Cloud Storage storage, operations and transfer pricing](https://cloud.google.com/storage/pricing).
- [VPC and external IP pricing](https://cloud.google.com/vpc/pricing).
- [Cloud Run pricing](https://cloud.google.com/run/pricing).
- [Artifact Registry pricing](https://cloud.google.com/artifact-registry/pricing).
- [Cloud Logging and Observability pricing](https://cloud.google.com/products/observability/pricing).
- [Batch pricing](https://cloud.google.com/batch/pricing).

## Application checkpoints

- [x] Draft the proposal within the 250-word limit.
- [x] Record a reproducible manual estimate below US$5,000.
- [ ] Confirm the project start date and intended cloud region.
- [ ] Profile the simulator and refine workload allowances after local validation gates.
- [ ] Save the live calculator estimate and its share link.
- [ ] Complete and submit the application; record the outcome.
- [ ] If awarded, record credit expiry and monitor actual usage against the allocation.
