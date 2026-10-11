// Shared test harness for the Excel import workflow: a fresh sandboxed application per call
// (no shared mutable state between tests) and a workbook fixture builder.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

let ExcelJS;
try {
  ExcelJS = require("exceljs");
} catch {
  ExcelJS = null;
}

const root = path.join(__dirname, "..", "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));

function loadApp() {
  const sandbox = { console, Math, Number, Intl, Object, Array, JSON, Date, Set, Map, Uint8Array, Promise };
  sandbox.PlanSetupValidation = require("../../validation.js");
  vm.createContext(sandbox);
  vm.runInContext(
    `${["data.js", "validation.js", "app.js", "workbook.js", "importValidation.js", "importPreview.js", "importService.js", "workbookImport.js"].map(read).join("\n")}
     var __wm = {
       handleWorkbookSelection, confirmWorkbookImport, cancelWorkbookImport, downloadImportValidationReport,
       buildPlanningWorkbookSchema, buildBlankPlanningWorkbook, cloneSampleProfile, replaceWorkingProfile,
       auditWorkbookForCalculatedOutputs,
       ImportService, IMPORT_FAILURE_CODES, IMPORT_USER_MESSAGES, importUserMessage, describeImportFailure,
       setImportLogger, setImportStatus, getImportStatus, logImportEvent,
       getPending: () => pendingWorkbookImport,
       getProfile: () => workingProfile,
       setProfile: (profile) => { workingProfile = profile; },
       stubRender: () => { renderFormFields = renderAssetFields = restoreAdvancedTaxSettingsState = bindFieldListeners =
         renderValidationMessages = () => {}; },
       setRenderMetrics: (fn) => { renderMetrics = fn; },
       swap: (name, fn) => {
         const originals = { calculate, buildTimelineRows, recommendations, buildImportPreview, buildImportCandidate, parsePlanningWorkbook };
         const previous = originals[name];
         if (name === "calculate") calculate = fn;
         if (name === "buildTimelineRows") buildTimelineRows = fn;
         if (name === "recommendations") recommendations = fn;
         if (name === "buildImportPreview") buildImportPreview = fn;
         if (name === "buildImportCandidate") buildImportCandidate = fn;
         if (name === "parsePlanningWorkbook") parsePlanningWorkbook = fn;
         return previous;
       },
       // Same data flow as renderMetrics (validate, calculate, timeline, recommendations) without the DOM.
       headlessRender: () => {
         currentValidationState = PlanSetupValidation.validatePlanSetup(workingProfile);
         if (!currentValidationState.isValid) return lastValidProjection;
         lastValidProjection = calculate(workingProfile);
         const resolved = resolveEffectiveProfile(workingProfile);
         currentTimelineProfile = resolved.effectiveProfile;
         currentSocialSecurityPlan = resolved.ssPlan;
         currentTimelineRows = buildTimelineRows(resolved.effectiveProfile);
         currentRecommendationItems = recommendations(lastValidProjection, workingProfile);
         return lastValidProjection;
       },
       live: () => ({ metrics: lastValidProjection, rows: currentTimelineRows, recs: currentRecommendationItems }),
       reportMarkup: () => planReportMarkup(),
       calculateFor: (profile) => {
         const copy = JSON.parse(JSON.stringify(profile));
         const metrics = calculate(copy);
         const resolved = resolveEffectiveProfile(copy);
         return { metrics, rows: buildTimelineRows(resolved.effectiveProfile), recs: recommendations(metrics, copy) };
       },
     };`,
    sandbox,
    { filename: "wealth-map-import-harness.js" },
  );
  const wm = sandbox.__wm;
  // Replace the DOM render with the headless equivalent, capture logs, and start from the sample plan.
  wm.stubRender();
  wm.setRenderMetrics(() => wm.headlessRender());
  const logs = [];
  wm.setImportLogger((entry) => logs.push(plain(entry)));
  wm.replaceWorkingProfile(wm.cloneSampleProfile());
  wm.logs = logs;
  return wm;
}

const sheetOf = (workbook, name) => workbook.getWorksheet(name);

function valueCell(wm, workbook, fieldId) {
  const entry = wm.buildPlanningWorkbookSchema().find((item) => item.fieldId === fieldId);
  const sheet = sheetOf(workbook, entry.worksheet);
  let row = 4;
  while (sheet.getCell(row, 6).value !== fieldId) row += 1;
  return sheet.getCell(row, 3);
}

function setValue(wm, workbook, fieldId, value) {
  valueCell(wm, workbook, fieldId).value = value;
}

function fillPlan(wm, workbook, profile = wm.cloneSampleProfile()) {
  wm.buildPlanningWorkbookSchema()
    .filter((entry) => entry.worksheet !== "Timeline Overrides")
    .forEach((entry) => {
      let value = entry.fieldId.split(".").reduce((node, key) => node[key], profile);
      if (entry.dataType === "select") value = entry.allowedValues.find((option) => option.value === value).label;
      setValue(wm, workbook, entry.fieldId, value);
    });
}

const OVERRIDE_COLUMNS = { returnPercent: 2, income: 3, expenses: 4, extraCashNeed: 5, extraWithdrawal: 6 };
const overrideRow = (age) => age + 8;
function setOverride(workbook, age, field, value) {
  sheetOf(workbook, "Timeline Overrides").getCell(overrideRow(age), OVERRIDE_COLUMNS[field]).value = value;
}

// A representative plan exercising the main input families, including per-age overrides.
// Sample plan: age 45, retire 65, life expectancy 95.
function goldenChanges() {
  return {
    values: {
      annualSalary: 140000,
      otherAnnualIncome: 6000,
      retirementAnnualSpendingGoal: 90000,
      "assets.cash": 41000,
      "assets.rothIra": 95000,
      expectedAnnualReturn: 0.06,
      inflationRate: 0.025,
    },
    overrides: [
      [50, "income", 5000],
      [66, "expenses", 70000],
      [70, "extraWithdrawal", 12000],
      [75, "returnPercent", 0.02],
    ],
  };
}

function buildGoldenWorkbook(wm) {
  const workbook = wm.buildBlankPlanningWorkbook(ExcelJS);
  fillPlan(wm, workbook);
  const { values, overrides } = goldenChanges();
  Object.entries(values).forEach(([fieldId, value]) => setValue(wm, workbook, fieldId, value));
  overrides.forEach(([age, field, value]) => setOverride(workbook, age, field, value));
  return workbook;
}

const toBuffer = async (workbook) => Buffer.from(await workbook.xlsx.writeBuffer());

function fileFromBuffer(buffer, name = "plan.xlsx") {
  return {
    name,
    size: buffer.length,
    arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length),
  };
}

const toFile = async (workbook, name) => fileFromBuffer(await toBuffer(workbook), name);

function recordingUi() {
  const log = { statuses: [], details: [], closed: 0, busy: [] };
  return {
    log,
    status: (text) => log.statuses.push(text),
    details: (result) => log.details.push(result),
    closeDialog: () => (log.closed += 1),
    busy: (flag) => log.busy.push(flag),
  };
}

function filledWorkbook(wm, mutate = () => {}) {
  const workbook = wm.buildBlankPlanningWorkbook(ExcelJS);
  fillPlan(wm, workbook);
  mutate(workbook);
  return workbook;
}

// Reusable workbook fixtures, built on demand so no binary files are kept in the repository.
// `expect` describes the outcome of the real selection flow.
const FIXTURES = {
  validComplete: { build: (wm) => buildGoldenWorkbook(wm), expect: { valid: true, overrides: 4 } },
  validWithoutOverrides: { build: (wm) => filledWorkbook(wm), expect: { valid: true, overrides: 0 } },
  validWithWarnings: {
    build: (wm) => filledWorkbook(wm, (workbook) => setValue(wm, workbook, "currentAnnualExpenses", 0)),
    expect: { valid: true, warnings: true },
  },
  missingWorksheet: {
    build: (wm) => {
      const workbook = wm.buildBlankPlanningWorkbook(ExcelJS);
      workbook.removeWorksheet(sheetOf(workbook, "Assets").id);
      return workbook;
    },
    expect: { code: "MISSING_WORKSHEET" },
  },
  renamedWorksheet: {
    build: (wm) => {
      const workbook = wm.buildBlankPlanningWorkbook(ExcelJS);
      sheetOf(workbook, "Assets").name = "Asset Balances";
      return workbook;
    },
    expect: { code: "MISSING_WORKSHEET" },
  },
  invalidNumeric: {
    build: (wm) => filledWorkbook(wm, (workbook) => setValue(wm, workbook, "assets.cash", "lots")),
    expect: { message: /must be a valid number/ },
  },
  malformedPercentage: {
    build: (wm) => filledWorkbook(wm, (workbook) => setValue(wm, workbook, "inflationRate", 140)),
    expect: { message: /cannot exceed 100%/ },
  },
  emptyRequiredCells: {
    build: (wm) => filledWorkbook(wm, (workbook) => setValue(wm, workbook, "targetRetirementAge", null)),
    expect: { message: /Target retirement age is required\./ },
  },
  duplicateOverrideYears: {
    build: (wm) =>
      filledWorkbook(wm, (workbook) => {
        setOverride(workbook, 50, "income", 1000);
        sheetOf(workbook, "Timeline Overrides").getCell(overrideRow(51), 1).value = 50;
        setOverride(workbook, 51, "income", 2000);
      }),
    expect: { message: /Multiple timeline overrides exist for age 50\./ },
  },
  overrideOutsideRange: {
    build: (wm) => filledWorkbook(wm, (workbook) => setOverride(workbook, 100, "expenses", 1000)),
    expect: { message: /outside the timeline range/ },
  },
  crossFieldInvalid: {
    build: (wm) => filledWorkbook(wm, (workbook) => setValue(wm, workbook, "targetRetirementAge", 40)),
    expect: { message: /must be greater than current age/ },
  },
  formulaCell: {
    build: (wm) =>
      filledWorkbook(wm, (workbook) => {
        valueCell(wm, workbook, "assets.cash").value = { formula: "1+1", result: 2 };
      }),
    expect: { code: "FORMULA_IN_IMPORTABLE_CELL" },
  },
  extraWorksheet: {
    build: (wm) => filledWorkbook(wm, (workbook) => (workbook.addWorksheet("Scratch").getCell("A1").value = "ignored")),
    expect: { valid: true, warnings: true },
  },
  emptyWorkbook: {
    build: () => {
      const workbook = new ExcelJS.Workbook();
      workbook.addWorksheet("Sheet1");
      return workbook;
    },
    expect: { valid: false },
  },
};

module.exports = {
  ExcelJS,
  FIXTURES,
  buildGoldenWorkbook,
  fileFromBuffer,
  fillPlan,
  filledWorkbook,
  goldenChanges,
  loadApp,
  plain,
  recordingUi,
  setOverride,
  setValue,
  sheetOf,
  toBuffer,
  toFile,
  valueCell,
};
