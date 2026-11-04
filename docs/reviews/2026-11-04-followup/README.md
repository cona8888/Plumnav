# Implementation verification evidence

This directory records the 4 November 2026 implementation checks for PlumeNav
0.22.0. Read the [implementation response](../../review-followup-2026-11-04.md)
for the findings, changes, numerical results and limits. The
[original audit](../2026-11-03-pstack/README.md) remains a separate immutable
record of commit `3507527250400d25081f3793191084c9c3356a56`.

## Run the checks

From the repository root, with locked dependencies installed:

```sh
pnpm install --frozen-lockfile
pnpm test --maxWorkers=2
pnpm test:review
pnpm test:commissioning
pnpm build
pnpm validate:grid
pnpm validate:data
pnpm --silent sensor:calibrate
pnpm --silent survey:validate benchmark-output/review-standard-new
pnpm --silent survey:validate --challenge benchmark-output/review-challenge-new
```

The mission destinations must not already exist. Use a new destination for
each repeat. `validate:data` reruns the separate 12-case simulated holdout
and compares its full output against the packaged reference. The focused
`test:review` selection is a convenient subset of the full source suite.
`validate:grid --output path/to/new-report.json` also saves its numerical
report; its standard output contains the same JSON.

`environment.json` records the actual runtime and dependency versions.
The run used Node 24.22.1 and installed pnpm 11.25.0; the package declaration
remains pnpm 11.9.0. It does not claim a second execution on that declared
package-manager version. `commands.json` records the executed integration
commands, output files, exit codes and local runtimes. Recorded container
timestamps are provenance, not an experimental clock or a performance comparison.

## Records

- **[Final source tests](source-tests-final.txt), [review regressions](review-tests-final.txt), [build](production-build-final.txt), and [grid checks](grid-validation-final.txt):** the final affected-gate records include
  the thin-wall observation and numerical representability corrections
  found during independent review. Earlier passing logs are retained as
  intermediate evidence and are not substituted for the final gates.
- **`packaged-data.txt`:** all 74 file checksums, four recorded-data panels,
  all ten EPFL commissioning choices and the simulated fitting holdout.
- **`grid-transport.json`:** the complete wall sweep, smooth-reference moment
  refinements, independent exterior flux, decay recurrence and clipping budgets.
- **`checkpoint-start-before-after.json`:** the reproduced audit failures
  and working-fix behaviour. The portable regression implementations are
  `src/sim/checkpointContract.test.ts` and `src/sim/physicalStart.test.ts`.
- **`grid-legacy-before.json` / `grid-legacy-after.json`:** the original six
  legacy numerical outputs. They compare byte for byte.
- **Independent-review records:** the grid review, point-observation/overflow
  reproductions, chart grouping before/after tests and mixed checkpoint/budget
  probe preserve the second-review evidence. Read any “before” record with
  its corresponding correction and final check.
- **`fitting-standard/` and `fitting-challenge/`:** fresh mission tables and
  the full versioned protocol/configuration records. The full readings,
  visits and decisions were compared byte for byte against the original
  audit outputs. `mission-replay-comparison.json` gives their hashes; the
  identical raw data are already retained in the original audit ZIP.
- **`preliminary/`:** expected failures of new regressions against the old
  implementation, first compatibility attempts, a transcribed test-value
  correction, and the concurrent pnpm setup failure. These are retained to
  explain the development trail, not counted as passing tests.

The initial grid test used a mistyped frozen scalar-mass value. It was corrected
to the saved pre-edit measurement; no solver behaviour was changed to fit it.
Two older tests used setups that the repaired contracts intentionally reject.
They were updated to request their intended deadline or expect a setup error.
Temporary missing-helper/type errors occurred while independent edits were
being integrated. The full integrated build and test gates resolve those
errors. A simultaneous preliminary pnpm command failed during automatic
dependency setup; final package commands ran sequentially.

One later full-source command returned zero but its console file lacked the
final totals. It was repeated with Vitest's JSON reporter. The retained
`source-tests-final.json` records **474 passed, zero failed or pending, across
41 test files**. The focused review command independently passes all 123
selected tests. `commands.json` identifies the repeated invocation explicitly.

The evidence concerns software verification and offline replay. It includes
no hardware mission, no paid compute run and no new measured-data result.

`tested-source.sha256` identifies the 961 source/script/configuration files
present for these final checks. Verify it from the repository root with
`sha256sum --check docs/reviews/2026-11-04-followup/tested-source.sha256`.
`SHA256SUMS` covers the evidence files in this directory; verify it from this
directory with `sha256sum --check SHA256SUMS`.
