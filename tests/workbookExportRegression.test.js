// Export regression safety net: supported input -> export model -> workbook -> population -> round trip.
// Pure and deterministic: no DOM, no downloads, and no plan values in assertion messages or logs.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");
const fixtures = require("./helpers/exportFixtures");

let ExcelJS;
try {
  ExcelJS = require("exceljs");
} catch {
  ExcelJS = null;
}
const needsExcel = { skip: !ExcelJS };
const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));

function load() {
  const sandbox = { console: { ...console, info() {} }, Math, Number, Intl, Object, Array, JSON, Date, Set, Map, WeakMap, Uint8Array, ExcelJS };
  sandbox.PlanSetupValidation = require("../validation.js");
  vm.createContext(sandbox);
  const files = ["data.js", "validation.js", "app.js", "workbook.js", "importValidation.js", "importPreview.js", "importService.js", "workbookImport.js", "planExport.js", "roundTripValidation.js"];
  vm.runInContext(
    `${files.map(read).join("\n")}
     var __x = { buildPlanExportModel, buildExportWorkbook, validateCurrentPlanForExport, buildSupportedInputInventory,
       buildWorkbookFieldLocationIndex, validateWorkbookPopulationResult, getWorkbookPopulationResult,
       getWorkbookTimelinePopulationResult, currentPlanWorkbookFilename, exportValidationIssueMessage,
       auditWorkbookForCalculatedOutputs, validateExportImportRoundTrip, WORKBOOK_PROHIBITED_FIELDS, WORKBOOK_SHEETS,
       PLAN_EXPORT_REQUIRED_SECTIONS };`,
    sandbox,
    { filename: "export-regression.js" },
  );
  return sandbox.__x;
}

const x = load();
const sections = x.PLAN_EXPORT_REQUIRED_SECTIONS;
const exportModelOf = (profile) => plain(x.buildPlanExportModel(profile));
const standardIds = (model) => sections.flatMap((section) => Object.keys(model[section]));
const sectionOf = (model, fieldId) => sections.find((section) => fieldId in model[section]);
const codesOf = (validation) => validation.errors.map((error) => error.code);

test("sample plan exports to a valid model and workbook", needsExcel, () => {
  const profile = fixtures.sampleProfile();
  const exportModel = x.buildPlanExportModel(profile);
  const workbook = x.buildExportWorkbook(exportModel);
  assert.ok(exportModel);
  assert.ok(workbook && typeof workbook.getWorksheet === "function");
  const validation = x.validateCurrentPlanForExport(exportModel);
  assert.equal(validation.isValid, true, JSON.stringify(validation.errors));
});

test("every supported non-timeline input appears in the export model", () => {
  const model = exportModelOf(fixtures.sampleProfile());
  const exported = new Set(standardIds(model));
  const missing = x
    .buildSupportedInputInventory()
    .filter((item) => item.worksheet !== x.WORKBOOK_SHEETS.timeline)
    .map((item) => item.fieldId)
    .filter((fieldId) => !exported.has(fieldId));
  assert.deepEqual(plain(missing), []);
});

test("no calculated output is ever exported", () => {
  const model = exportModelOf(fixtures.timelineOverrideProfile());
  const prohibited = new Set(Object.values(x.WORKBOOK_PROHIBITED_FIELDS).flat());
  [
    "readinessScore", "status", "projectedAssets", "requiredAssets", "fundingGap", "safeSpending", "recommendations",
    "expectedRetirementAge", "projectedRmd", "projectedNiit", "projectedIrmaa", "projectedSocialSecurityTax",
  ].forEach((id) => prohibited.add(id));
  const leaked = [...standardIds(model), ...Object.keys(model), ...model.timelineOverrides.map((r) => r.field)].filter(
    (id) => prohibited.has(id) || prohibited.has(id.split(".").pop()),
  );
  assert.deepEqual(plain(leaked), []);
  assert.deepEqual(plain(Object.keys(model)).sort(), ["modelVersion", ...sections, "timelineOverrides"].sort());
});

test("workbook population reports no standard or timeline errors", needsExcel, () => {
  const workbook = x.buildExportWorkbook(x.buildPlanExportModel(fixtures.timelineOverrideProfile()));
  assert.doesNotThrow(() => x.validateWorkbookPopulationResult(workbook));
  assert.equal(x.getWorkbookPopulationResult(workbook).errors.length, 0);
  assert.equal(x.getWorkbookTimelinePopulationResult(workbook).errors.length, 0);
});

test("timeline overrides export as age/field/value records", () => {
  const model = exportModelOf(fixtures.timelineOverrideProfile());
  assert.equal(model.timelineOverrides.length, 3);
  assert.deepEqual(model.timelineOverrides, [
    { age: 50, field: "returnPercent", value: 10 },
    { age: 60, field: "expenses", value: 120000 },
    { age: 75, field: "extraWithdrawal", value: 25000 },
  ]);
});

test("timeline overrides populate the Timeline Overrides worksheet", needsExcel, () => {
  const workbook = x.buildExportWorkbook(x.buildPlanExportModel(fixtures.timelineOverrideProfile()));
  const result = x.getWorkbookTimelinePopulationResult(workbook);
  assert.equal(result.errors.length, 0);
  assert.deepEqual(plain(result.populated).map((entry) => entry.age).sort((a, b) => a - b), [50, 60, 75]);
  const sheet = workbook.getWorksheet(x.WORKBOOK_SHEETS.timeline);
  assert.ok(sheet);
  const filled = [];
  sheet.eachRow((row) => {
    const age = row.getCell(1).value;
    if ([50, 60, 75].includes(age) && row.values.slice(2).some((v) => typeof v === "number")) filled.push(age);
  });
  assert.deepEqual(filled.sort((a, b) => a - b), [50, 60, 75]);
});

test("invalid export models are rejected with value-free codes", () => {
  const base = exportModelOf(fixtures.sampleProfile());

  const missing = plain(base);
  missing[sectionOf(missing, "currentAge")].currentAge = null;
  const missingResult = x.validateCurrentPlanForExport(missing);
  assert.equal(missingResult.isValid, false);
  assert.ok(codesOf(missingResult).includes("missingRequired"));

  const percent = plain(base);
  percent[sectionOf(percent, "expectedAnnualReturn")].expectedAnnualReturn = 3;
  assert.ok(codesOf(x.validateCurrentPlanForExport(percent)).includes("percentOutOfRange"));

  const selection = plain(base);
  selection[sectionOf(selection, "filingStatus")].filingStatus = "Invalid";
  assert.ok(codesOf(x.validateCurrentPlanForExport(selection)).includes("invalidSelection"));
});

test("workbook locations align one-to-one with the supported inputs", () => {
  const index = x.buildWorkbookFieldLocationIndex();
  const expected = x
    .buildSupportedInputInventory()
    .filter((item) => item.worksheet !== x.WORKBOOK_SHEETS.timeline)
    .map((item) => item.fieldId);
  const located = Object.keys(index);
  assert.deepEqual(plain(expected.filter((id) => !(id in index))), [], "inputs without a workbook location");
  assert.deepEqual(plain(located.filter((id) => !expected.includes(id))), [], "orphaned workbook locations");
  assert.equal(new Set(expected).size, expected.length, "duplicate supported inputs");
  const cells = Object.values(index).map((l) => `${l.worksheet}:${l.row}:${l.column}`);
  assert.equal(new Set(cells).size, cells.length, "two inputs share one workbook cell");
});

for (const name of ["sampleProfile", "highIncomeProfile", "retiredProfile", "highAssetProfile", "timelineOverrideProfile"]) {
  test(`round trip succeeds for ${name}`, needsExcel, () => {
    const result = plain(x.validateExportImportRoundTrip(fixtures[name]()));
    assert.deepEqual(result.validationErrors, [], JSON.stringify(result.validationErrors));
    assert.deepEqual(result.differences, []);
    assert.equal(result.success, true);
  });
}

test("filename is date-only and independent of the plan", () => {
  const date = new Date(2026, 0, 5);
  const names = ["sampleProfile", "highAssetProfile", "retiredProfile"].map((n) => x.currentPlanWorkbookFilename(fixtures[n](), date));
  names.forEach((name) => assert.equal(name, "WealthMap_Current_Plan_2026-01-05.xlsx"));
  assert.match(x.currentPlanWorkbookFilename(fixtures.sampleProfile()), /^WealthMap_Current_Plan_\d{4}-\d{2}-\d{2}\.xlsx$/);
});

test("validation messages are user-safe and value-free", () => {
  const profile = fixtures.sampleProfile();
  const model = exportModelOf(profile);
  model[sectionOf(model, "currentAge")].currentAge = null;
  model[sectionOf(model, "expectedAnnualReturn")].expectedAnnualReturn = 3;
  model[sectionOf(model, "filingStatus")].filingStatus = "Invalid";
  const errors = x.validateCurrentPlanForExport(model).errors;
  assert.ok(errors.length >= 3);
  const secrets = [profile.name, String(profile.annualSalary), String(profile.assets.fourOhOneK), "Invalid"];
  errors.forEach((issue) => {
    const message = x.exportValidationIssueMessage(issue);
    assert.equal(typeof message, "string");
    assert.ok(message.length > 0);
    secrets.forEach((secret) => assert.ok(!message.includes(secret)));
    assert.ok(!JSON.stringify(issue).includes(profile.name));
  });
});

test("exported workbook passes the calculated-output audit", needsExcel, () => {
  const workbook = x.buildExportWorkbook(x.buildPlanExportModel(fixtures.timelineOverrideProfile()));
  const audit = plain(x.auditWorkbookForCalculatedOutputs(workbook));
  // A populated workbook legitimately holds the plan's own input values, so activePlanValues and
  // sampleProfileValues (which flag values in a blank template) are expected to be non-zero here.
  ["formulaCells", "calculatedFields", "projectionFields", "readinessFields", "recommendationFields", "hiddenOutputFields"].forEach(
    (key) => assert.equal(audit.counts[key], 0, key),
  );
});
