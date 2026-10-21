// Export hardening: failure registry, transactional population, isolation, units, selects, zero/blank
// semantics, Timeline handling and populated-export audit. Pure: no DOM, no downloads, and no plan
// values in assertion messages or logs.
const test = require("node:test");
const assert = require("node:assert/strict");
const fixtures = require("./helpers/exportFixtures");
const { app, needsExcel, ExcelJS, plain, roundTripProfile } = require("./helpers/roundTripHarness");

const schema = plain(app.buildPlanningWorkbookSchema());
const index = plain(app.buildWorkbookFieldLocationIndex());
const SECRET = 918273645;
const cellOf = (workbook, fieldId) => {
  const location = index[fieldId];
  return workbook.getWorksheet(location.worksheet).getCell(location.row, location.column);
};
const isStandard = (entry) => entry.worksheet !== app.WORKBOOK_SHEETS.timeline;

test("failure registry is frozen, complete and mapped to fixed safe messages", () => {
  assert.ok(Object.isFrozen(app.EXPORT_FAILURE_CODES));
  assert.ok(Object.isFrozen(app.EXPORT_USER_MESSAGES));
  const codes = Object.keys(app.EXPORT_FAILURE_CODES);
  assert.deepEqual(plain(codes), plain(Object.values(app.EXPORT_FAILURE_CODES)));
  codes.forEach((code) => {
    const message = app.exportUserMessage(code);
    assert.equal(typeof message, "string");
    assert.ok(message.length > 10, code);
    assert.ok(!/\d{3,}|undefined|null|Error:/.test(message), code);
    const error = app.createSafeExportError(code);
    assert.equal(error.code, code);
    assert.equal(error.message, message);
  });
  const generic = app.exportUserMessage("UNKNOWN_EXPORT_FAILURE");
  [undefined, null, "", "NOPE", {}, "__proto__", "toString"].forEach((code) => {
    assert.equal(app.exportUserMessage(code), generic);
  });
  assert.equal(app.createSafeExportError("NOPE").code, "UNKNOWN_EXPORT_FAILURE");
});

test("failure logging carries only approved metadata and never breaks export", () => {
  const entries = [];
  app.setPlanExportLogger((entry) => entries.push(plain(entry)));
  const raw = new TypeError(`salary ${SECRET}`);
  raw.code = "SECRET_CODE";
  app.logExportFailure(raw);
  app.logExportFailure(app.createSafeExportError("WORKBOOK_SERIALIZATION_FAILED"));
  app.logExportFailure(undefined);
  assert.deepEqual(entries[1], {
    event: "currentPlanExportFailed", stage: "serialization", code: "WORKBOOK_SERIALIZATION_FAILED", errorType: "Error",
  });
  assert.equal(entries[0].code, "UNKNOWN_EXPORT_FAILURE");
  entries.forEach((entry) => assert.deepEqual(Object.keys(entry).sort(), ["code", "errorType", "event", "stage"]));
  assert.ok(!JSON.stringify(entries).includes(String(SECRET)));
  app.setPlanExportLogger(() => { throw new Error("logger down"); });
  assert.doesNotThrow(() => app.logExportFailure(raw));
  app.setPlanExportLogger(() => {});
});

test("export model neither mutates nor aliases the source profile", () => {
  const profile = fixtures.timelineOverrideProfile();
  const before = JSON.stringify(profile);
  const model = app.buildPlanExportModel(profile);
  assert.equal(JSON.stringify(profile), before);
  ["profile", "assumptions", "incomeAndExpenses", "assets"].forEach((section) => {
    Object.keys(model[section]).forEach((fieldId) => { model[section][fieldId] = SECRET; });
  });
  assert.ok(model.timelineOverrides.length > 0);
  model.timelineOverrides.forEach((record) => { record.value = SECRET; });
  model.timelineOverrides.push({ age: 99, field: "income", value: SECRET });
  assert.equal(JSON.stringify(profile), before);
  assert.ok(!JSON.stringify(profile.timelineOverrides).includes(String(SECRET)));
});

test("every workbook build is a fresh, isolated instance with its own population metadata", needsExcel, () => {
  const model = app.buildPlanExportModel(fixtures.timelineOverrideProfile());
  const first = app.buildExportWorkbook(model);
  const second = app.buildExportWorkbook(model);
  assert.notEqual(first, second);
  assert.notEqual(app.getWorkbookPopulationResult(first), app.getWorkbookPopulationResult(second));
  assert.notEqual(app.getWorkbookTimelinePopulationResult(first), app.getWorkbookTimelinePopulationResult(second));
  const original = cellOf(second, "currentAge").value;
  cellOf(first, "currentAge").value = SECRET;
  assert.equal(cellOf(second, "currentAge").value, original);
  assert.equal(cellOf(app.buildExportWorkbook(model), "currentAge").value, original);

  const bad = plain(model);
  bad.profile.bogus = SECRET;
  assert.throws(() => app.buildExportWorkbook(bad), (error) => error.code === "STANDARD_POPULATION_FAILED");
  const later = app.buildExportWorkbook(model);
  assert.equal(cellOf(later, "currentAge").value, original);
  assert.doesNotThrow(() => app.validateWorkbookPopulationResult(later));
});

test("standard population is all-or-nothing", needsExcel, () => {
  const target = app.buildExportWorkbook(app.buildPlanExportModel(fixtures.sampleProfile()));
  Object.keys(index).forEach((id) => { cellOf(target, id).value = null; });
  const model = plain(app.buildPlanExportModel(fixtures.sampleProfile()));
  model.profile.currentAge = 45.5; // not an integer: one bad field
  const result = app.populateWorkbookInputs(target, model, index, schema);
  assert.ok(result.errors.length > 0);
  assert.deepEqual(plain(result.populatedFieldIds), []);
  assert.deepEqual(plain(result.blankFieldIds), []);
  Object.keys(index).forEach((id) => assert.equal(cellOf(target, id).value, null, id));
});

test("Timeline population is all-or-nothing and rejects malformed records without values", needsExcel, () => {
  const model = plain(app.buildPlanExportModel(fixtures.sampleProfile()));
  const map = app.buildWorkbookTimelineOverrideMap();
  const sheetOf = (workbook) => workbook.getWorksheet("Timeline Overrides");
  const good = { age: 60, field: "income", value: 1000 };
  const cases = {
    DUPLICATE_TIMELINE_OVERRIDE: [good, { ...good }],
    INVALID_TIMELINE_AGE: [{ ...good, age: 60.5 }],
    TIMELINE_AGE_OUT_OF_RANGE: [{ ...good, age: 150 }],
    UNSUPPORTED_TIMELINE_FIELD: [{ ...good, field: "readinessScore" }],
    INVALID_TIMELINE_VALUE: [{ ...good, value: Number.NaN }],
    TIMELINE_VALUE_BELOW_MINIMUM: [{ age: 61, field: "returnPercent", value: -SECRET }],
  };
  Object.entries(cases).forEach(([code, extra]) => {
    const workbook = app.buildExportWorkbook(model);
    const result = app.populateWorkbookTimelineOverrides(workbook, { timelineOverrides: [{ age: 50, field: "expenses", value: 7 }, ...extra] });
    assert.ok(result.errors.some((error) => error.code === code), code);
    assert.deepEqual(plain(result.populated), [], code);
    assert.ok(!JSON.stringify(result.errors).includes(String(SECRET)), code);
    const sheet = sheetOf(workbook);
    for (let row = map.firstAgeRow; row <= sheet.rowCount; row += 1) {
      for (const column of map.columnsByFieldId.values()) assert.equal(sheet.getCell(row, column).value, null, `${code} r${row} c${column}`);
    }
  });
});

test("Timeline export is deterministic, integer-aged, supported-only and unit-correct", needsExcel, async () => {
  const profile = fixtures.sampleProfile();
  profile.timelineOverrides = {
    75: { extraWithdrawal: 10, returnPercent: 4 },
    50: { returnPercent: -12.5, expenses: 20 },
    60: {},
    "55.5": { returnPercent: 3 },
    70: { returnPercent: 5, bogusField: 9 },
  };
  const model = app.buildPlanExportModel(profile);
  const records = plain(model.timelineOverrides);
  const order = plain(app.TIMELINE_OVERRIDE_FIELDS).map((entry) => entry.field);
  const sorted = [...records].sort((a, b) => a.age - b.age || order.indexOf(a.field) - order.indexOf(b.field));
  assert.deepEqual(records, sorted);
  assert.ok(records.every((r) => Number.isInteger(r.age) && order.includes(r.field) && Number.isFinite(r.value)));
  assert.ok(!records.some((r) => r.age === 60 || r.age === 55.5 || r.field === "bogusField"));

  const workbook = app.buildExportWorkbook(model);
  const map = app.buildWorkbookTimelineOverrideMap();
  const row = app.workbookTimelineRowNumber(50);
  assert.ok(Math.abs(workbook.getWorksheet("Timeline Overrides").getCell(row, map.returnPercentColumn).value - -0.125) < 1e-9);
  const result = await roundTripProfile(profile);
  assert.equal(result.comparison.success, true);
  assert.equal(result.candidate.profile.timelineOverrides[50].returnPercent, -12.5);
});

test("standard percentages stay decimals and whole numbers stay integers across the round trip", needsExcel, async () => {
  const profile = fixtures.withValues(fixtures.sampleProfile(), { expectedAnnualReturn: 0.05, inflationRate: 0.025 });
  const result = await roundTripProfile(profile);
  assert.equal(result.comparison.success, true);
  assert.ok(Math.abs(cellOf(result.workbook, "expectedAnnualReturn").value - 0.05) < app.ROUND_TRIP_TOLERANCE);
  assert.ok(Math.abs(result.candidate.profile.expectedAnnualReturn - 0.05) < app.ROUND_TRIP_TOLERANCE);
  schema.filter((entry) => isStandard(entry) && ["currency", "number", "percent"].includes(entry.dataType)).forEach((entry) => {
    const value = cellOf(result.workbook, entry.fieldId).value;
    assert.ok(value === null || (typeof value === "number" && Number.isFinite(value)), entry.fieldId);
  });
  schema.filter((entry) => isStandard(entry) && entry.dataType === "integer").forEach((entry) => {
    const value = cellOf(result.workbook, entry.fieldId).value;
    assert.ok(value === null || Number.isInteger(value), entry.fieldId);
  });
});

test("select fields export labels, reject unsupported internal values, and import labels back", needsExcel, async () => {
  const selects = schema.filter((entry) => isStandard(entry) && entry.dataType === "select");
  assert.ok(selects.length > 0);
  for (const entry of selects) {
    assert.ok(entry.allowedValues.length > 0, entry.fieldId);
    entry.allowedValues.forEach((option) => {
      const model = plain(app.buildPlanExportModel(fixtures.sampleProfile()));
      const section = Object.keys(model).find((key) => model[key] && typeof model[key] === "object" && entry.fieldId in model[key]);
      model[section][entry.fieldId] = option.value;
      assert.equal(cellOf(app.buildExportWorkbook(model), entry.fieldId).value, option.label, entry.fieldId);
    });
    const bad = plain(app.buildPlanExportModel(fixtures.sampleProfile()));
    const badSection = Object.keys(bad).find((key) => bad[key] && typeof bad[key] === "object" && entry.fieldId in bad[key]);
    bad[badSection][entry.fieldId] = "__unsupported__";
    assert.throws(() => app.buildExportWorkbook(bad), (error) => error.code === "STANDARD_POPULATION_FAILED", entry.fieldId);

    const tampered = await roundTripProfile(fixtures.sampleProfile(), {
      mutateWorkbook: (workbook) => { cellOf(workbook, entry.fieldId).value = "Not A Supported Label"; },
    });
    assert.equal(tampered.comparison.success, false, entry.fieldId);
    assert.ok(tampered.comparison.validationErrors.length > 0, entry.fieldId);
  }
});

test("zero, blank and optional values keep their semantics", needsExcel, async () => {
  const zero = await roundTripProfile(fixtures.zeroValueProfile());
  assert.equal(zero.comparison.success, true);
  const named = fixtures.withValues(fixtures.sampleProfile(), { name: "" });
  const result = await roundTripProfile(named);
  assert.equal(result.comparison.success, true);
  assert.equal(result.candidate.profile.name, "");
  assert.ok(result.candidate.profile !== named);
  const serialized = JSON.stringify(plain(result.exportModel)) + JSON.stringify(plain(result.candidate.profile));
  assert.ok(!/"(null|undefined)"/.test(serialized));
  result.workbook.worksheets.forEach((sheet) =>
    sheet.eachRow((row) => row.eachCell((cell) => assert.ok(cell.value !== "null" && cell.value !== "undefined"))));
  // A required blank blocks export before any workbook exists.
  const missing = plain(app.buildPlanExportModel(fixtures.sampleProfile()));
  missing.profile.currentAge = null;
  assert.equal(app.validateCurrentPlanForExport(missing).isValid, false);
});

test("export model and workbook schema stay consistent with the supported-input inventory", () => {
  const inventory = plain(app.buildSupportedInputInventory());
  const layout = plain(app.planExportFieldLayout());
  const placed = Object.values(layout).flat();
  assert.equal(new Set(placed).size, placed.length, "a field appears in two export sections");
  const standard = inventory.filter((item) => item.worksheet !== app.WORKBOOK_SHEETS.timeline).map((item) => item.fieldId);
  assert.deepEqual([...placed].sort(), [...standard].sort());
  const destinations = standard.map((id) => {
    const location = index[id];
    assert.ok(location, `no location: ${id}`);
    assert.equal(location.worksheet, inventory.find((item) => item.fieldId === id).worksheet, id);
    return `${location.worksheet}:${location.row}:${location.column}`;
  });
  assert.equal(new Set(destinations).size, destinations.length, "shared destination");
  assert.deepEqual(Object.keys(index).filter((id) => !standard.includes(id)), []);
  const map = app.buildWorkbookTimelineOverrideMap();
  const columns = [...map.columnsByFieldId.entries()];
  assert.deepEqual(
    columns.map(([id]) => id).sort(),
    inventory.filter((item) => item.worksheet === app.WORKBOOK_SHEETS.timeline).map((item) => item.fieldId).sort(),
  );
  assert.equal(new Set(columns.map(([, column]) => column)).size, columns.length);
  [...standard, ...columns.map(([id]) => id)].forEach((id) => assert.equal(app.workbookFieldIdIsProhibited(id), false, id));
});

test("populated-export audit allows only recognized input values and keeps every output check", needsExcel, () => {
  const workbooks = {
    sample: fixtures.sampleProfile(),
    custom: fixtures.allInputsProfile(),
    overrides: fixtures.allOverrideTypesProfile(),
  };
  Object.entries(workbooks).forEach(([name, profile]) => {
    const workbook = app.buildExportWorkbook(app.buildPlanExportModel(profile));
    const strict = plain(app.auditWorkbookForCalculatedOutputs(workbook));
    assert.equal(strict.result, "FAIL", `${name}: blank-template mode must reject populated values`);
    const audit = plain(app.auditWorkbookForCalculatedOutputs(workbook, { populatedExport: true }));
    assert.equal(audit.result, "PASS", name);
  });
  const tamper = (mutate) => {
    const workbook = app.buildExportWorkbook(app.buildPlanExportModel(fixtures.sampleProfile()));
    mutate(workbook);
    return plain(app.auditWorkbookForCalculatedOutputs(workbook, { populatedExport: true }));
  };
  assert.equal(tamper((wb) => { cellOf(wb, "currentAge").value = { formula: "1+1", result: 2 }; }).counts.formulaCells, 1);
  assert.equal(tamper((wb) => { wb.getWorksheet("Timeline Overrides").getCell(60, 9).value = 5; }).result, "FAIL");
  assert.equal(tamper((wb) => { wb.getWorksheet("Assets").state = "hidden"; }).counts.hiddenOutputFields, 1);
  assert.equal(tamper((wb) => { wb.getWorksheet("Plan Setup").getCell(index.currentAge.row, 6).value = "readinessScore"; }).result, "FAIL");
});

test("filename ignores the profile entirely", () => {
  const profile = fixtures.sampleProfile();
  profile.name = "Jane Secret";
  const date = new Date(2026, 9, 21);
  assert.equal(app.currentPlanWorkbookFilename(profile, date), "WealthMap_Current_Plan_2026-10-21.xlsx");
  assert.equal(app.currentPlanWorkbookFilename(undefined, date), "WealthMap_Current_Plan_2026-10-21.xlsx");
});

test("exporting never mutates the profile and failed exports leave later exports possible", needsExcel, async () => {
  const profile = fixtures.timelineOverrideProfile();
  const before = JSON.stringify(profile);
  await roundTripProfile(profile);
  assert.equal(JSON.stringify(profile), before);
  const bad = plain(app.buildPlanExportModel(profile));
  bad.assets["assets.cash"] = "not a number";
  assert.throws(() => app.buildExportWorkbook(bad));
  assert.equal(JSON.stringify(profile), before);
  assert.equal((await roundTripProfile(profile)).comparison.success, true);
  assert.ok(ExcelJS);
});
