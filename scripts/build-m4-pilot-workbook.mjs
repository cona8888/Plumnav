import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const COLORS = {
  navy: '#0B1F33',
  teal: '#0F766E',
  blue: '#2563EB',
  gold: '#D97706',
  red: '#B91C1C',
  ink: '#172033',
  slate: '#475569',
  line: '#CBD5E1',
  pale: '#F1F5F9',
  mint: '#DFF4EE',
  amber: '#FFF4D6',
  white: '#FFFFFF',
}

const parseCsv = (text) => {
  const lines = text.trimEnd().split(/\r?\n/)
  const header = lines.shift().split(',')
  return lines.filter(Boolean).map((line) => {
    const values = line.split(',')
    return Object.fromEntries(header.map((name, index) => [name, values[index] ?? '']))
  })
}

const number = (value) => value === '' || value === undefined ? null : Number(value)

const columnLetter = (oneBasedColumn) => {
  let value = oneBasedColumn
  let label = ''
  while (value > 0) {
    value -= 1
    label = String.fromCharCode(65 + (value % 26)) + label
    value = Math.floor(value / 26)
  }
  return label
}

const titleBand = (sheet, range, text) => {
  sheet.getRange(range).merge()
  const cell = sheet.getRange(range.split(':')[0])
  cell.values = [[text]]
  sheet.getRange(range).format = {
    fill: COLORS.navy,
    font: { bold: true, color: COLORS.white, fontSize: 18 },
    verticalAlignment: 'center',
  }
  sheet.getRange(range).format.rowHeight = 28
}

const sectionHeader = (range) => {
  range.format = {
    fill: COLORS.teal,
    font: { bold: true, color: COLORS.white },
    wrapText: true,
    verticalAlignment: 'center',
    borders: { preset: 'all', style: 'thin', color: COLORS.line },
  }
}

const dataBody = (range) => {
  range.format = {
    font: { color: COLORS.ink },
    borders: { preset: 'all', style: 'thin', color: COLORS.line },
    verticalAlignment: 'center',
  }
}

const sourceNote = (sheet, range, text, fill = COLORS.pale) => {
  sheet.getRange(range).merge()
  sheet.getRange(range.split(':')[0]).values = [[text]]
  sheet.getRange(range).format = {
    fill,
    font: { color: COLORS.slate, italic: true },
    wrapText: true,
    verticalAlignment: 'center',
    borders: { preset: 'outside', style: 'thin', color: COLORS.line },
  }
}

const addTable = (sheet, range, name) => {
  const table = sheet.tables.add(range, true, name)
  table.style = 'TableStyleMedium2'
  table.showBandedRows = true
  return table
}

export async function buildM4PilotWorkbook({ Workbook, SpreadsheetFile }, options) {
  const { analysisDirectory, primaryRawCsv, outputDirectory } = options
  const analysis = JSON.parse(await readFile(join(analysisDirectory, 'analysis.json'), 'utf8'))
  const armRows = parseCsv(await readFile(join(analysisDirectory, 'arm-summaries.csv'), 'utf8'))
  const contrastRows = parseCsv(await readFile(join(analysisDirectory, 'primary-comparisons.csv'), 'utf8'))
  const conditionRows = parseCsv(await readFile(join(analysisDirectory, 'stratum-summaries.csv'), 'utf8'))
  const pairedRows = parseCsv(await readFile(join(analysisDirectory, 'paired-units.csv'), 'utf8'))
  const rawText = await readFile(primaryRawCsv, 'utf8')
  const rawMatrix = rawText.trimEnd().split(/\r?\n/).map((line) => line.split(',').map((value) => {
    if (value === '') return null
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : value
  }))
  const rawEndColumn = columnLetter(rawMatrix[0].length)

  const workbook = Workbook.create()
  const readme = workbook.worksheets.add('Read Me')
  const dashboard = workbook.worksheets.add('Dashboard')
  const arms = workbook.worksheets.add('Arm Summary')
  const contrasts = workbook.worksheets.add('Primary Contrasts')
  const conditions = workbook.worksheets.add('Condition Summary')
  const paired = workbook.worksheets.add('Paired Worlds')
  const sizing = workbook.worksheets.add('Campaign Sizing')
  const raw = workbook.worksheets.add('Raw Data')
  raw.getRangeByIndexes(0, 0, rawMatrix.length, rawMatrix[0].length).values = rawMatrix

  // Read Me
  readme.showGridLines = false
  titleBand(readme, 'A1:H2', 'PlumeNav M4 — audited development-pilot analysis')
  readme.getRange('A4:B12').values = [
    ['Evidence class', 'Retrospective descriptive development pilot'],
    ['Independent unit', 'One complete paired world'],
    ['Stored structure', '16 paired worlds × 5 arms = 80 rows'],
    ['Primary endpoint', 'Correct terminal declaration by 180 s'],
    ['Candidate', 'Quad Active'],
    ['Primary family', 'Candidate versus four frozen references; one global Holm family'],
    ['Normalized success tolerance', '0.01 of domain = 1 m in a 100 m domain'],
    ['Scientific repeat', 'Exact outside mean_compute_ms and p95_compute_ms'],
    ['Workbook role', 'Readable mirror of hash-locked analyzer outputs; not a new inferential analysis'],
  ]
  readme.getRange('A4:A12').format = { fill: COLORS.pale, font: { bold: true, color: COLORS.navy } }
  readme.getRange('A4:B12').format.borders = { preset: 'all', style: 'thin', color: COLORS.line }
  readme.getRange('A14:H14').merge()
  readme.getRange('A14').values = [['Frozen provenance']]
  sectionHeader(readme.getRange('A14:H14'))
  readme.getRange('A15:B21').values = [
    ['Analysis-spec SHA-256', analysis.analysisSpec.sha256],
    ['Scientific-results SHA-256', analysis.input.primaryArchive.scientificResultsSha256],
    ['Primary raw-results SHA-256', analysis.input.primaryArchive.rawResultsSha256],
    ['Repeat raw-results SHA-256', analysis.input.reproductionArchive.rawResultsSha256],
    ['Manifest file SHA-256', analysis.input.primaryArchive.manifestFileSha256],
    ['Implementation SHA-256', analysis.input.primaryArchive.implementationSha256],
    ['Runtime fingerprint', analysis.input.primaryArchive.runtimeFingerprint],
  ]
  readme.getRange('A15:A21').format = { fill: COLORS.pale, font: { bold: true, color: COLORS.navy } }
  readme.getRange('A15:B21').format.borders = { preset: 'all', style: 'thin', color: COLORS.line }
  sourceNote(readme, 'A23:H26', `Claim boundary: ${analysis.claimBoundary}`, COLORS.amber)
  sourceNote(readme, 'A28:H31', 'Critical interpretation: 80 rows are storage records, not 80 independent experiments. The inferential denominator is 16 paired worlds. Scenario-orientation cells contain only two worlds and are descriptive only.')
  readme.getRange('A1:H31').format.wrapText = true
  readme.getRange('A1:A31').format.columnWidth = 27
  readme.getRange('B1:B31').format.columnWidth = 74
  readme.getRange('C1:H31').format.columnWidth = 12

  // Arm Summary — immutable analyzer output in a concise table.
  arms.showGridLines = false
  titleBand(arms, 'A1:U2', 'Overall arm summaries — 16 paired worlds per arm')
  sourceNote(arms, 'A4:U4', 'Imported from the deterministic M4 analyzer. Wilson intervals and descriptive continuous summaries use paired-world denominators; no arm ranking is inferential.')
  const armHeaders = ['Arm', 'Paired worlds', 'Proximity successes', 'Proximity rate', 'Prox CI low', 'Prox CI high', 'Correct declarations', 'Correct rate', 'Correct CI low', 'Correct CI high', 'Wrong', 'Abstention', 'Deadline', 'Mean error', 'Error SD', 'Median error', 'Mean penalized time (s)', 'Median contacts', 'Median sniff cycles', 'Mean air-pulse energy', 'Mean suction proxy']
  arms.getRange('A5:U5').values = [armHeaders]
  arms.getRange('A6:U10').values = armRows.map((row) => [
    row.arm, number(row.paired_worlds), number(row.proximity_successes), number(row.proximity_rate),
    number(row.proximity_wilson_low), number(row.proximity_wilson_high), number(row.correct_declarations),
    number(row.correct_declaration_rate), number(row.correct_declaration_wilson_low),
    number(row.correct_declaration_wilson_high), number(row.wrong_declarations), number(row.abstentions),
    number(row.deadline_nondeclarations), number(row.normalized_error_mean), number(row.normalized_error_sd),
    number(row.normalized_error_median), number(row.mean_penalized_decision_time_s),
    number(row.contact_episodes_median), number(row.quad_sniff_cycles_median),
    number(row.air_pulse_energy_mean), number(row.quad_suction_energy_proxy_mean),
  ])
  sectionHeader(arms.getRange('A5:U5'))
  dataBody(arms.getRange('A6:U10'))
  arms.getRange('D6:F10').format.numberFormat = '0.0%'
  arms.getRange('H6:J10').format.numberFormat = '0.0%'
  arms.getRange('N6:P10').format.numberFormat = '0.0000'
  arms.getRange('Q6:U10').format.numberFormat = '0.00'
  addTable(arms, 'A5:U10', 'M4ArmSummaryTable')
  arms.freezePanes.freezeRows(5)
  arms.getRange('A1:A10').format.columnWidth = 29
  arms.getRange('B1:M10').format.columnWidth = 15
  arms.getRange('N1:U10').format.columnWidth = 18
  arms.getRange('A1:U10').format.wrapText = true

  // Dashboard with formula-backed links to the evidence table.
  dashboard.showGridLines = false
  titleBand(dashboard, 'A1:P2', 'M4 development-pilot dashboard')
  dashboard.getRange('A4:B9').values = [
    ['Independent paired worlds', null],
    ['Stored rows', null],
    ['Arms per world', null],
    ['Primary checkpoint (s)', null],
    ['Scientific repeat', 'PASS'],
    ['Evidence status', 'DESCRIPTIVE ONLY'],
  ]
  dashboard.getRange('B4').formulas = [["='Arm Summary'!B6"]]
  dashboard.getRange('B5').formulas = [['=B4*5']]
  dashboard.getRange('B6').formulas = [['=5']]
  dashboard.getRange('B7').formulas = [['=180']]
  dashboard.getRange('A4:A9').format = { fill: COLORS.pale, font: { bold: true, color: COLORS.navy } }
  dashboard.getRange('B4:B7').format = { fill: COLORS.mint, font: { bold: true, color: COLORS.teal } }
  dashboard.getRange('B8').format = { fill: COLORS.mint, font: { bold: true, color: COLORS.teal } }
  dashboard.getRange('B9').format = { fill: COLORS.amber, font: { bold: true, color: COLORS.red } }
  dashboard.getRange('A4:B9').format.borders = { preset: 'all', style: 'thin', color: COLORS.line }
  dashboard.getRange('A12:G12').values = [['Arm', 'Proximity rate', 'Correct rate', 'Mean error', 'Correct', 'Wrong', 'Penalized time (s)']]
  sectionHeader(dashboard.getRange('A12:G12'))
  for (let row = 13; row <= 17; row += 1) {
    const source = row - 7
    dashboard.getRange(`A${row}:G${row}`).formulas = [[
      `='Arm Summary'!A${source}`,
      `='Arm Summary'!D${source}`,
      `='Arm Summary'!H${source}`,
      `='Arm Summary'!N${source}`,
      `='Arm Summary'!G${source}`,
      `='Arm Summary'!K${source}`,
      `='Arm Summary'!Q${source}`,
    ]]
  }
  dataBody(dashboard.getRange('A13:G17'))
  dashboard.getRange('B13:C17').format.numberFormat = '0.0%'
  dashboard.getRange('D13:D17').format.numberFormat = '0.0000'
  dashboard.getRange('G13:G17').format.numberFormat = '0.00'
  const chart = dashboard.charts.add('bar', dashboard.getRange('A12:C17'))
  chart.title = 'Development-pilot event rates (descriptive)'
  chart.titleTextStyle.fontSize = 12
  chart.hasLegend = true
  chart.xAxis = { axisType: 'textAxis', textStyle: { fontSize: 9 } }
  chart.yAxis = { numberFormatCode: '0%', min: 0, max: 1 }
  chart.setPosition('I4', 'P18')
  sourceNote(dashboard, 'A20:P23', 'Decision gate: Quad Active reached the proximity threshold in 2/16 worlds but made 0 correct terminal declarations. Repair or recalibrate the declaration layer before increasing sample size. Zero-discordance tests are uninformative, not evidence of equivalence.', COLORS.amber)
  sourceNote(dashboard, 'A25:P28', 'Next compute decision: use the Mac for a fresh 128-world development screen after algorithm/control repairs. AWS is not justified for the present pilot; it becomes useful mainly for ≥800 comparable worlds or verified higher-fidelity solvers.')
  dashboard.getRange('A1:A28').format.columnWidth = 27
  dashboard.getRange('B1:G28').format.columnWidth = 16
  dashboard.getRange('H1:H28').format.columnWidth = 3
  dashboard.getRange('I1:P28').format.columnWidth = 13

  // Frozen primary contrasts.
  contrasts.showGridLines = false
  titleBand(contrasts, 'A1:P2', 'Frozen primary family — Quad Active minus reference')
  sourceNote(contrasts, 'A4:P4', 'Correct terminal declaration by 180 s is primary. Four exact McNemar tests form one global Holm family. Paired bootstrap intervals resample complete worlds with seed 1295278156.')
  const contrastHeaders = ['Reference', 'Pairs', 'Δ correct risk', 'CI low', 'CI high', 'Reference-only', 'Candidate-only', 'Exact p', 'Holm p', 'Δ proximity', 'Prox CI low', 'Prox CI high', 'Δ mean error', 'Error CI low', 'Error CI high', 'Δ penalized time (s)']
  contrasts.getRange('A5:P5').values = [contrastHeaders]
  contrasts.getRange('A6:P9').values = contrastRows.map((row) => [
    row.reference_arm, number(row.paired_worlds), number(row.correct_risk_difference),
    number(row.correct_risk_difference_low), number(row.correct_risk_difference_high),
    number(row.reference_only), number(row.candidate_only), number(row.mcnemar_exact_p),
    number(row.holm_adjusted_p), number(row.proximity_risk_difference),
    number(row.proximity_risk_difference_low), number(row.proximity_risk_difference_high),
    number(row.error_mean_difference), number(row.error_mean_difference_low),
    number(row.error_mean_difference_high), number(row.penalized_time_mean_difference_s),
  ])
  sectionHeader(contrasts.getRange('A5:P5'))
  dataBody(contrasts.getRange('A6:P9'))
  contrasts.getRange('C6:E9').format.numberFormat = '0.0%'
  contrasts.getRange('H6:L9').format.numberFormat = '0.0000'
  contrasts.getRange('M6:P9').format.numberFormat = '0.0000'
  addTable(contrasts, 'A5:P9', 'M4PrimaryContrastTable')
  sourceNote(contrasts, 'A12:P15', 'Interpretation: all estimates are development observations. The empirical bootstrap is degenerate at zero when both arms have no primary events; that reflects the pilot sample and must not be read as a precise equivalence interval. Exact discordance information is the limiting quantity.')
  contrasts.freezePanes.freezeRows(5)
  contrasts.getRange('A1:A15').format.columnWidth = 29
  contrasts.getRange('B1:P15').format.columnWidth = 15

  // Descriptive condition table.
  conditions.showGridLines = false
  titleBand(conditions, 'A1:P2', 'Condition summaries — descriptive effect-modification checks')
  sourceNote(conditions, 'A4:P4', 'Open/obstructed strata contain 8 paired worlds per arm; each scenario-orientation stratum contains only 2. These rows are not separate superiority tests.')
  const conditionHeaders = ['Stratum type', 'Stratum', 'Scenario', 'Orientation', 'Arm', 'Worlds', 'Prox rate', 'Correct rate', 'Wrong', 'Deadline', 'Mean error', 'Median error', 'Path mean', 'Contact median', 'Sniff median', 'Penalized time (s)']
  conditions.getRange('A5:P5').values = [conditionHeaders]
  conditions.getRange(`A6:P${5 + conditionRows.length}`).values = conditionRows.map((row) => [
    row.stratum_type, row.stratum, row.scenario, row.orientation, row.arm, number(row.paired_worlds),
    number(row.proximity_rate), number(row.correct_declaration_rate), number(row.wrong_declarations),
    number(row.deadline_nondeclarations), number(row.normalized_error_mean),
    number(row.normalized_error_median), number(row.path_normalized_mean),
    number(row.contact_episodes_median), number(row.quad_sniff_cycles_median),
    number(row.mean_penalized_decision_time_s),
  ])
  sectionHeader(conditions.getRange('A5:P5'))
  dataBody(conditions.getRange(`A6:P${5 + conditionRows.length}`))
  conditions.getRange(`G6:H${5 + conditionRows.length}`).format.numberFormat = '0.0%'
  conditions.getRange(`K6:M${5 + conditionRows.length}`).format.numberFormat = '0.0000'
  addTable(conditions, `A5:P${5 + conditionRows.length}`, 'M4ConditionSummaryTable')
  conditions.freezePanes.freezeRows(5)
  conditions.getRange('A1:E55').format.columnWidth = 20
  conditions.getRange('F1:P55').format.columnWidth = 15

  // Long paired-world outcome ledger.
  paired.showGridLines = false
  titleBand(paired, 'A1:J2', 'Paired-world outcome ledger — 16 worlds × 5 arms')
  sourceNote(paired, 'A4:J4', 'Every five-row block is one independent world. Algorithm rows within a block are paired observations, not independent replicates.')
  const pairedHeaders = ['Pairing key', 'Scenario', 'Orientation', 'Replicate', 'Arm', 'Terminal outcome', 'Correct declaration', 'Proximity success', 'Normalized error', 'Penalized decision time (s)']
  paired.getRange('A5:J5').values = [pairedHeaders]
  paired.getRange(`A6:J${5 + pairedRows.length}`).values = pairedRows.map((row) => [
    row.pairing_key, row.scenario, row.orientation, number(row.replicate), row.arm,
    row.terminal_outcome, number(row.correct_declaration), number(row.proximity_success),
    number(row.normalized_error), number(row.penalized_decision_time_s),
  ])
  sectionHeader(paired.getRange('A5:J5'))
  dataBody(paired.getRange(`A6:J${5 + pairedRows.length}`))
  paired.getRange(`I6:I${5 + pairedRows.length}`).format.numberFormat = '0.0000'
  paired.getRange(`J6:J${5 + pairedRows.length}`).format.numberFormat = '0.00'
  addTable(paired, `A5:J${5 + pairedRows.length}`, 'M4PairedWorldTable')
  paired.freezePanes.freezeRows(5)
  paired.getRange('A1:A85').format.columnWidth = 34
  paired.getRange('B1:E85').format.columnWidth = 18
  paired.getRange('E1:E85').format.columnWidth = 29
  paired.getRange('F1:F85').format.columnWidth = 34
  paired.getRange('G1:J85').format.columnWidth = 18

  // Campaign sizing and compute decision. Formula cells are green; assumptions are amber.
  sizing.showGridLines = false
  titleBand(sizing, 'A1:H2', 'Campaign sizing — sensitivity ranges and measured Mac projection')
  sourceNote(sizing, 'A4:H5', 'These are planning sensitivities, not final power results. Exact paired multi-arm simulation and a frozen test design are required before confirmatory execution.')
  sizing.getRange('A7:G7').values = [['Risk improvement Δ', 'Discordance low', 'Discordance high', '80% n low', '80% n high', '90% n low', '90% n high']]
  sizing.getRange('A8:G10').values = [[0.10,0.25,0.50,252,513,325,662],[0.15,0.25,0.50,106,223,137,287],[0.20,0.25,0.50,55,121,71,156]]
  sectionHeader(sizing.getRange('A7:G7')); dataBody(sizing.getRange('A8:G10'))
  sizing.getRange('A8:C10').format.numberFormat = '0%'
  sizing.getRange('A13:D13').values = [['Meaningful error reduction', 'Pilot paired SD', '80% n', '90% n']]
  sizing.getRange('A14:D16').values = [[0.02,0.1282,391,510],[0.03,0.1282,174,227],[0.05,0.1282,63,82]]
  sectionHeader(sizing.getRange('A13:D13')); dataBody(sizing.getRange('A14:D16'))
  sizing.getRange('A14:B16').format.numberFormat = '0.0000'
  sizing.getRange('A19:F19').values = [['Paired worlds', 'Measured sec/world', 'Allowance', 'Ideal hours', 'Hours with allowance', 'Decision']]
  const workload = [[128,63.85,0.30,null,null,'Next Mac development screen'],[200,63.85,0.30,null,null,'Mac'],[384,63.85,0.30,null,null,'Overnight Mac validation pilot'],[400,63.85,0.30,null,null,'Mac'],[768,63.85,0.30,null,null,'Mac if schedule permits / AWS candidate'],[800,63.85,0.30,null,null,'AWS begins to reduce wall time'],[1600,63.85,0.30,null,null,'AWS likely justified'],[2400,63.85,0.30,null,null,'AWS likely justified']]
  sizing.getRange('A20:F27').values = workload
  for (let row = 20; row <= 27; row += 1) {
    sizing.getRange(`D${row}`).formulas = [[`=A${row}*B${row}/3600`]]
    sizing.getRange(`E${row}`).formulas = [[`=D${row}*(1+C${row})`]]
  }
  sectionHeader(sizing.getRange('A19:F19')); dataBody(sizing.getRange('A20:F27'))
  sizing.getRange('B20:C27').format = { fill: COLORS.amber, font: { color: COLORS.ink } }
  sizing.getRange('C20:C27').format.numberFormat = '0%'
  sizing.getRange('D20:E27').format = { fill: COLORS.mint, font: { bold: true, color: COLORS.teal }, numberFormat: '0.00' }
  sourceNote(sizing, 'A30:H33', 'Recommended sequence: repair Quad declaration logic → add genuine passive four-channel control → complete target-absent safety design → run 128 fresh development worlds on the Mac → if event generation and variance stabilize, run 384 validation worlds overnight → size and seal the test campaign → perform a small Mac–AWS portability set before cloud production.', COLORS.amber)
  sizing.getRange('A1:A33').format.columnWidth = 25
  sizing.getRange('B1:E33').format.columnWidth = 18
  sizing.getRange('F1:H33').format.columnWidth = 30

  // Full frozen raw export for audit, kept visually simple because it has 114 columns.
  raw.freezePanes.freezeRows(1)
  raw.freezePanes.freezeColumns(5)
  raw.getRange(`A1:${rawEndColumn}1`).format = { fill: COLORS.navy, font: { bold: true, color: COLORS.white }, wrapText: true }
  raw.getRange(`A1:${rawEndColumn}${rawMatrix.length}`).format.borders = { preset: 'all', style: 'thin', color: '#E2E8F0' }
  raw.getRange(`A1:${rawEndColumn}${rawMatrix.length}`).format.columnWidth = 15
  raw.getRange('A1:E81').format.columnWidth = 25

  await mkdir(outputDirectory, { recursive: true })
  const previewDirectory = join(outputDirectory, 'previews')
  await mkdir(previewDirectory, { recursive: true })
  const previews = [
    { sheetName: 'Read Me' },
    { sheetName: 'Dashboard' },
    { sheetName: 'Arm Summary' },
    { sheetName: 'Primary Contrasts' },
    { sheetName: 'Condition Summary', range: 'A1:P20' },
    { sheetName: 'Paired Worlds', range: 'A1:J20' },
    { sheetName: 'Campaign Sizing' },
    { sheetName: 'Raw Data', range: 'A1:N12' },
  ]
  for (const previewSpec of previews) {
    const preview = await workbook.render({ ...previewSpec, autoCrop: 'all', scale: 1, format: 'png' })
    await writeFile(join(previewDirectory, `${previewSpec.sheetName.replaceAll(' ', '_')}.png`), new Uint8Array(await preview.arrayBuffer()))
  }
  const inspection = await workbook.inspect({ kind: 'workbook,sheet,table,drawing', maxChars: 12000, tableMaxRows: 8, tableMaxCols: 8, tableMaxCellChars: 80 })
  await writeFile(join(outputDirectory, 'workbook-inspection.ndjson'), inspection.ndjson ?? JSON.stringify(inspection, null, 2))
  const formulaInspection = await workbook.inspect({ kind: 'formula', sheetId: 'Dashboard', range: 'A1:P28', maxChars: 8000, options: { maxResults: 100 } })
  await writeFile(join(outputDirectory, 'formula-inspection.ndjson'), formulaInspection.ndjson ?? JSON.stringify(formulaInspection, null, 2))
  const output = await SpreadsheetFile.exportXlsx(workbook)
  const workbookPath = join(outputDirectory, 'PlumeNav_M4_Pilot_Analysis.xlsx')
  await output.save(workbookPath)
  return { workbookPath, previewDirectory }
}
