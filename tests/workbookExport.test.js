const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

let ExcelJS;
try {
  ExcelJS = require("exceljs");
} catch {
  ExcelJS = null;
}
const needsExcel = { skip: !ExcelJS };
const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

function load() {
  const sandbox = { console: { ...console, info() {} }, Math, Number, Intl, Object, Array, JSON, Date, Set, Map, WeakMap, Uint8Array, ExcelJS };
  sandbox.PlanSetupValidation = require("../validation.js");
  vm.createContext(sandbox);
  vm.runInContext(
    `${["data.js", "validation.js", "app.js", "workbook.js", "importValidation.js", "importPreview.js", "importService.js", "workbookImport.js", "planExport.js"].map(read).join("\n")}
     var __we = { buildExportWorkbook, buildBlankPlanningWorkbook, buildPlanExportModel, cloneSampleProfile,
       buildWorkbookFieldLocationIndex, buildPlanningWorkbookSchema, populateWorkbookInputs, collectStandardExportFields,
       toWorkbookExportValue, getWorkbookPopulationResult, createPlanningWorkbook, buildImportCandidate, importEffectiveValue,
       buildSupportedInputInventory, setPlanExportLogger, buildWorkbookTimelineOverrideMap,
       populateWorkbookTimelineOverrides, getWorkbookTimelinePopulationResult };`,
    sandbox,
    { filename: "workbook-export.js" },
  );
  return sandbox.__we;
}

const we = load();
const index = we.buildWorkbookFieldLocationIndex();
const cellOf = (workbook, fieldId) => {
  const location = index[fieldId];
  return workbook.getWorksheet(location.worksheet).getCell(location.row, location.column);
};
const model = () => JSON.parse(JSON.stringify(we.buildPlanExportModel(we.cloneSampleProfile())));

test("text, numeric, and nested fields populate their Value cells", needsExcel, () => {
  const m = model();
  m.profile.name = "Jane's Plan";
  const wb = we.buildExportWorkbook(m);
  assert.equal(cellOf(wb, "name").value, "Jane's Plan");
  const flat = { ...m.profile, ...m.assumptions, ...m.incomeAndExpenses, ...m.assets };
  assert.equal(cellOf(wb, "state").value, flat.state);
  assert.equal(cellOf(wb, "currentAge").value, 45);
  assert.equal(cellOf(wb, "annualSalary").value, m.incomeAndExpenses.annualSalary);
  assert.equal(cellOf(wb, "assets.cash").value, 20000);
  ["contributionRates.fourOhOneK", "employerMatch.rate", "employerMatch.salaryCap",
    "iraContributions.traditionalIraAnnual", "savingsAllocation.brokerage", "assets.fourOhOneK"].forEach((id) => {
    assert.equal(cellOf(wb, id).value, flat[id], id);
  });
  const result = we.getWorkbookPopulationResult(wb);
  assert.equal(result.errors.length, 0);
  assert.equal(result.populatedFieldIds.length + result.blankFieldIds.length, Object.keys(index).length);
});

test("percentages stay decimal and keep their format; zero stays zero", needsExcel, () => {
  const m = model();
  m.assumptions.expectedAnnualReturn = 0.05;
  m.assumptions.inflationRate = 0;
  const wb = we.buildExportWorkbook(m);
  assert.equal(cellOf(wb, "expectedAnnualReturn").value, 0.05);
  assert.equal(cellOf(wb, "inflationRate").value, 0);
  assert.equal(cellOf(wb, "expectedAnnualReturn").numFmt, "0.00%");
});

test("select values become labels that the importer maps back", needsExcel, () => {
  const m = model();
  const wb = we.buildExportWorkbook(m);
  const schema = we.buildPlanningWorkbookSchema();
  const selects = schema.filter((e) => e.dataType === "select" && m.profile[e.fieldId] !== undefined || m.assumptions[e.fieldId] !== undefined && e.dataType === "select");
  assert.ok(selects.length > 0);
  selects.forEach((entry) => {
    const internal = (m.profile[entry.fieldId] ?? m.assumptions[entry.fieldId]);
    const cell = cellOf(wb, entry.fieldId);
    assert.equal(cell.value, entry.allowedValues.find((o) => o.value === internal).label);
    assert.equal(we.importEffectiveValue(entry, cell.value, {}), internal);
  });
});

test("null and undefined are blank, zero is numeric zero", needsExcel, () => {
  const m = model();
  m.incomeAndExpenses.otherAnnualIncome = null;
  m.assets["assets.cash"] = 0;
  delete m.assets["assets.brokerage"];
  m.assumptions.niitThreshold = undefined;
  const wb = we.buildExportWorkbook(m);
  assert.equal(cellOf(wb, "otherAnnualIncome").value, null);
  assert.equal(cellOf(wb, "niitThreshold").value, null);
  assert.equal(cellOf(wb, "assets.cash").value, 0);
  assert.equal(cellOf(wb, "assets.brokerage").value, null);
});

test("standard export without overrides leaves Timeline cells blank and does not mutate the model", needsExcel, () => {
  const m = model();
  const before = JSON.stringify(m);
  const wb = we.buildExportWorkbook(m);
  const sheet = wb.getWorksheet("Timeline Overrides");
  for (let row = 8; row <= sheet.rowCount; row += 1) {
    for (let col = 2; col <= 7; col += 1) assert.equal(sheet.getCell(row, col).value, null);
  }
  assert.equal(JSON.stringify(m), before);
});

test("prohibited, unknown, timeline, duplicate and invalid fields are rejected without values", needsExcel, () => {
  const wb = we.buildBlankPlanningWorkbook(ExcelJS);
  const secret = 987654321;
  const result = we.populateWorkbookInputs(wb, {
    profile: { readinessScore: secret, bogus: secret, "timelineOverrides.income": secret, currentAge: 45.5 },
    assumptions: { expectedAnnualReturn: {}, projectionBasis: "nope", inflationRate: Infinity },
    incomeAndExpenses: { annualSalary: secret },
    assets: { "assets.cash": secret, annualSalary: secret },
  }, index, we.buildPlanningWorkbookSchema());
  const codes = Object.fromEntries(result.errors.map((e) => [e.fieldId, e.code]));
  assert.equal(codes.readinessScore, "PROHIBITED_EXPORT_FIELD");
  assert.equal(codes.bogus, "UNKNOWN_EXPORT_FIELD");
  assert.equal(codes["timelineOverrides.income"], "TIMELINE_FIELD_IN_STANDARD_EXPORT");
  assert.equal(codes.currentAge, "INVALID_EXPORT_VALUE");
  assert.equal(codes.expectedAnnualReturn, "INVALID_EXPORT_VALUE");
  assert.equal(codes.projectionBasis, "UNRESOLVED_SELECT_VALUE");
  assert.equal(codes.inflationRate, "INVALID_EXPORT_VALUE");
  assert.equal(codes.annualSalary, "DUPLICATE_EXPORT_FIELD");
  assert.equal(cellOf(wb, "annualSalary").value, null);
  // Transactional population: one error means no cell is written.
  assert.equal(cellOf(wb, "assets.cash").value, null);
  assert.equal(result.populatedFieldIds.length, 0);
  assert.ok(!JSON.stringify(result.errors).includes(String(secret)));
  assert.throws(() => we.buildExportWorkbook({ ...model(), profile: { bogus: secret } }), (e) => !e.message.includes(String(secret)));
});

test("populated cells keep format, validation and fill", needsExcel, () => {
  const blank = we.buildBlankPlanningWorkbook(ExcelJS);
  const wb = we.buildExportWorkbook(model());
  ["currentAge", "expectedAnnualReturn", "annualSalary", "filingStatus", "assets.cash"].forEach((id) => {
    const a = cellOf(blank, id);
    const b = cellOf(wb, id);
    assert.equal(b.numFmt, a.numFmt);
    assert.deepEqual(b.dataValidation, a.dataValidation);
    assert.deepEqual(b.fill, a.fill);
    assert.deepEqual(b.border, a.border);
  });
});

test("blank workbook has blank Value cells and the export is importable", needsExcel, () => {
  const blank = we.buildBlankPlanningWorkbook(ExcelJS);
  Object.keys(index).forEach((id) => assert.equal(cellOf(blank, id).value, null, id));
  const m = model();
  const wb = we.buildExportWorkbook(m);
  const candidate = we.buildImportCandidate(wb);
  const flat = { ...m.profile, ...m.assumptions, ...m.incomeAndExpenses, ...m.assets };
  const inventory = we.buildSupportedInputInventory();
  inventory.filter((i) => !i.fieldId.startsWith("timelineOverrides.") && flat[i.fieldId] !== null).forEach((item) => {
    assert.equal(we.importEffectiveValue(item, candidate.values[item.fieldId], {}), flat[item.fieldId], item.fieldId);
  });
});

// ---- Timeline override population ----
const tmap = we.buildWorkbookTimelineOverrideMap();
const tcell = (wb, age, field) => {
  const sheet = wb.getWorksheet("Timeline Overrides");
  let row;
  for (let r = tmap.firstAgeRow; r <= sheet.rowCount; r += 1) if (sheet.getCell(r, tmap.ageColumn).value === age) row = r;
  return sheet.getCell(row, tmap.columnsByFieldId.get(`timelineOverrides.${field}`));
};
const withOverrides = (records) => ({ ...model(), timelineOverrides: records });
const timelineSnapshot = (wb) => {
  const sheet = wb.getWorksheet("Timeline Overrides");
  const out = [];
  sheet.eachRow((row, n) => { if (n >= tmap.firstAgeRow) row.eachCell((c, col) => { if (col > 1) out.push([n, col, c.value]); }); });
  return out;
};

test("each Timeline field lands in its own column and age row, with unit conversion", needsExcel, () => {
  const wb = we.buildExportWorkbook(withOverrides([
    { age: 70, field: "extraWithdrawal", value: 30000.5 },
    { age: 48, field: "returnPercent", value: 4.25 },
    { age: 48, field: "income", value: 195000 },
    { age: 48, field: "extraCashNeed", value: 0 },
    { age: 67, field: "expenses", value: 125000 },
    { age: 50, field: "returnPercent", value: 0 },
    { age: 51, field: "returnPercent", value: -100 },
    { age: 52, field: "returnPercent", value: -10 },
  ]));
  assert.equal(tcell(wb, 48, "returnPercent").value, 0.0425);
  assert.equal(tcell(wb, 48, "income").value, 195000);
  assert.equal(tcell(wb, 48, "extraCashNeed").value, 0);
  assert.equal(tcell(wb, 67, "expenses").value, 125000);
  assert.equal(tcell(wb, 70, "extraWithdrawal").value, 30000.5);
  assert.equal(tcell(wb, 50, "returnPercent").value, 0);
  assert.equal(tcell(wb, 51, "returnPercent").value, -1);
  assert.equal(tcell(wb, 52, "returnPercent").value, -0.1);
  assert.equal(tcell(wb, 48, "returnPercent").numFmt, "0.00%");
  assert.equal(tcell(wb, 48, "income").numFmt, '"$"#,##0.00');
  assert.equal(timelineSnapshot(wb).filter(([, , v]) => v !== null).length, 8);
  const sheet = wb.getWorksheet("Timeline Overrides");
  for (let r = tmap.firstAgeRow; r <= sheet.rowCount; r += 1) assert.equal(sheet.getCell(r, 7).value, null);
  assert.equal(we.getWorkbookTimelinePopulationResult(wb).populated.length, 8);
});

test("Timeline writes keep style, validation, fill, border and alignment", needsExcel, () => {
  const blank = we.buildBlankPlanningWorkbook(ExcelJS);
  const wb = we.buildExportWorkbook(withOverrides([{ age: 50, field: "returnPercent", value: 5 }, { age: 50, field: "income", value: 1 }]));
  ["returnPercent", "income"].forEach((f) => {
    const a = tcell(blank, 50, f);
    const b = tcell(wb, 50, f);
    assert.equal(b.numFmt, a.numFmt);
    assert.deepEqual(b.dataValidation, a.dataValidation);
    assert.deepEqual(b.fill, a.fill);
    assert.deepEqual(b.border, a.border);
    assert.deepEqual(b.alignment, a.alignment);
  });
});

test("invalid Timeline records are rejected atomically without leaking values", needsExcel, () => {
  const secret = 31337;
  const good = { age: 60, field: "income", value: secret };
  const bad = [
    [{ age: 49.5, field: "income", value: secret }, "INVALID_TIMELINE_AGE"],
    [{ age: NaN, field: "income", value: secret }, "INVALID_TIMELINE_AGE"],
    [{ age: Infinity, field: "income", value: secret }, "INVALID_TIMELINE_AGE"],
    [{ age: -1, field: "income", value: secret }, "TIMELINE_AGE_OUT_OF_RANGE"],
    [{ age: 121, field: "income", value: secret }, "TIMELINE_AGE_OUT_OF_RANGE"],
    [{ age: 50, field: "portfolioValue", value: secret }, "UNSUPPORTED_TIMELINE_FIELD"],
    [{ age: 50, field: "returnPercent", value: -101 }, "TIMELINE_VALUE_BELOW_MINIMUM"],
    [{ age: 50, field: "income", value: -1 }, "TIMELINE_VALUE_BELOW_MINIMUM"],
    [{ age: 50, field: "expenses", value: -1 }, "TIMELINE_VALUE_BELOW_MINIMUM"],
    [{ age: 50, field: "extraCashNeed", value: -1 }, "TIMELINE_VALUE_BELOW_MINIMUM"],
    [{ age: 50, field: "extraWithdrawal", value: -1 }, "TIMELINE_VALUE_BELOW_MINIMUM"],
    ...["5", true, {}, [], NaN, Infinity, ""].map((value) => [{ age: 50, field: "expenses", value }, "INVALID_TIMELINE_VALUE"]),
    [{ age: 60, field: "income", value: 5 }, "DUPLICATE_TIMELINE_OVERRIDE"],
    [null, "INVALID_TIMELINE_RECORD"],
  ];
  bad.forEach(([record, code]) => {
    const wb = we.buildBlankPlanningWorkbook(ExcelJS);
    const before = JSON.stringify(timelineSnapshot(wb));
    const result = we.populateWorkbookTimelineOverrides(wb, { timelineOverrides: [good, record] }, tmap, we.buildPlanningWorkbookSchema());
    assert.ok(result.errors.some((e) => e.code === code), `${code} for ${JSON.stringify(record)}`);
    assert.equal(JSON.stringify(timelineSnapshot(wb)), before, "atomic");
    assert.equal(result.populated.length, 0);
    assert.ok(!JSON.stringify(result.errors).includes(String(secret)));
    assert.equal(wb.getWorksheet("Timeline Overrides").columnCount, 7);
  });
  assert.throws(() => we.buildExportWorkbook(withOverrides([good, { age: 60, field: "income", value: secret }])), (e) => !e.message.includes(String(secret)));
});

test("blank and null Timeline values are skipped, never zero", needsExcel, () => {
  const wb = we.buildBlankPlanningWorkbook(ExcelJS);
  const result = we.populateWorkbookTimelineOverrides(wb, { timelineOverrides: [{ age: 50, field: "income", value: null }, { age: 51, field: "income", value: undefined }] }, tmap, we.buildPlanningWorkbookSchema());
  assert.equal(result.errors.length, 0);
  assert.equal(result.skipped.length, 2);
  assert.equal(tcell(wb, 50, "income").value, null);
});

test("Timeline export imports back to the same internal values and leaves standard fields alone", needsExcel, () => {
  const records = [
    { age: 48, field: "returnPercent", value: 5 },
    { age: 48, field: "income", value: 195000 },
    { age: 70, field: "extraWithdrawal", value: 30000.5 },
  ];
  const m = withOverrides(records);
  const withT = we.buildExportWorkbook(m);
  const withoutT = we.buildExportWorkbook({ ...m, timelineOverrides: [] });
  Object.keys(index).forEach((id) => assert.equal(cellOf(withT, id).value, cellOf(withoutT, id).value, id));
  const candidate = we.buildImportCandidate(withT);
  const importedRow = (age) => candidate.overrideRows.find((r) => r.age === age).values;
  assert.equal(importedRow(48).returnPercent * 100, 5);
  assert.equal(importedRow(48).income, 195000);
  assert.equal(importedRow(70).extraWithdrawal, 30000.5);
  const blank = we.buildBlankPlanningWorkbook(ExcelJS);
  assert.equal(timelineSnapshot(blank).filter(([, , v]) => v !== null).length, 0);
});
