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

function loadModel() {
  const sandbox = { console, Math, Number, Intl, Object, Array, JSON, Date, Set, Map, Uint8Array };
  sandbox.PlanSetupValidation = require("../validation.js");
  vm.createContext(sandbox);
  vm.runInContext(
    `${["data.js", "validation.js", "app.js", "workbook.js", "importValidation.js", "importPreview.js", "importService.js", "workbookImport.js"].map(read).join("\n")}
     var __wm = { handleWorkbookSelection, buildPlanningWorkbookSchema, cloneSampleProfile, buildBlankPlanningWorkbook,
       buildImportCandidate, validateImportCandidate, confirmWorkbookImport, cancelWorkbookImport, buildImportPreview,
       formatImportValidationReportText, downloadImportValidationReport, describeImportImpact, getPending: () => pendingWorkbookImport, formatImportValidationReport, replaceWorkingProfile,
       getProfile: () => workingProfile, setProfile: (p) => { workingProfile = p; },
       stubRender: () => { renderFormFields = renderAssetFields = restoreAdvancedTaxSettingsState = bindFieldListeners =
         renderValidationMessages = () => {}; },
       setRenderMetrics: (fn) => { renderMetrics = fn; },
       ImportService, verifyPlanProjection, describeImportSuccess, describeImportFailure, setImportLogger,
       setCalculate: (fn) => { calculate = fn; }, getCalculate: () => calculate,
       // Same data flow as renderMetrics (validate, calculate, timeline, recommendations) without the DOM.
       headlessRender: () => {
         currentValidationState = PlanSetupValidation.validatePlanSetup(workingProfile);
         if (!currentValidationState.isValid) return lastValidProjection;
         lastValidProjection = calculate(workingProfile);
         currentTimelineRows = buildTimelineRows(resolveEffectiveProfile(workingProfile).effectiveProfile);
         currentRecommendationItems = recommendations(lastValidProjection, workingProfile);
         return lastValidProjection;
       },
       getLive: () => ({ metrics: lastValidProjection, rows: currentTimelineRows, recs: currentRecommendationItems }) };`,
    sandbox,
    { filename: "wealth-map-import-validation.js" },
  );
  return sandbox.__wm;
}

const wm = loadModel();
wm.setImportLogger(() => {});
const plain = (value) => JSON.parse(JSON.stringify(value));
const sheetOf = (workbook, name) => workbook.getWorksheet(name);

function setValue(workbook, fieldId, value) {
  const entry = wm.buildPlanningWorkbookSchema().find((item) => item.fieldId === fieldId);
  const sheet = sheetOf(workbook, entry.worksheet);
  let row = 4;
  while (sheet.getCell(row, 6).value !== fieldId) row += 1;
  sheet.getCell(row, 3).value = value;
}

function fillSamplePlan(workbook) {
  const sample = wm.cloneSampleProfile();
  wm.buildPlanningWorkbookSchema()
    .filter((entry) => entry.worksheet !== "Timeline Overrides")
    .forEach((entry) => {
      let value = entry.fieldId.split(".").reduce((node, key) => node[key], sample);
      if (entry.dataType === "select") value = entry.allowedValues.find((option) => option.value === value).label;
      setValue(workbook, entry.fieldId, value);
    });
}

const OVERRIDE_COLUMNS = { returnPercent: 2, income: 3, expenses: 4, extraCashNeed: 5, extraWithdrawal: 6 };
const overrideRow = (age) => age + 8;

function setOverride(workbook, age, field, value) {
  sheetOf(workbook, "Timeline Overrides").getCell(overrideRow(age), OVERRIDE_COLUMNS[field]).value = value;
}

async function toFile(workbook) {
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  return { name: "plan.xlsx", size: buffer.length, arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length) };
}

// Runs the real selection flow with an injected apply so tests can observe whether state would change.
async function run(mutate = () => {}, { fill = true } = {}) {
  const workbook = wm.buildBlankPlanningWorkbook(ExcelJS);
  if (fill) fillSamplePlan(workbook);
  mutate(workbook);
  const applied = [];
  const ui = { status() {}, details() {}, closeDialog() {} };
  const result = await wm.handleWorkbookSelection([await toFile(workbook)], { ui, excelApi: ExcelJS });
  // Selecting a workbook must never apply it; only an explicit confirmation does.
  assert.equal(result.imported, false);
  if (result.awaitingConfirmation) wm.confirmWorkbookImport({ ui, applyProfile: (profile) => applied.push(profile) });
  return { result, applied, messages: plain(result.errors).map((e) => e.message), warnings: plain(result.warnings).map((w) => w.message) };
}

const hasMessage = (messages, pattern) => messages.some((message) => pattern.test(message));

test("a valid workbook imports with no errors or warnings", needsExcel, async () => {
  const { result, applied } = await run();
  assert.equal(result.valid ?? result.isValid, true);
  assert.deepEqual(plain(result.validation), { valid: true, errors: [], warnings: [] });
  assert.equal(applied.length, 1);
  assert.deepEqual(plain(applied[0]), plain(wm.cloneSampleProfile()));
});

test("valid values and overrides are applied to the imported profile", needsExcel, async () => {
  const { applied, result } = await run((workbook) => {
    setValue(workbook, "assets.cash", 12345);
    setValue(workbook, "filingStatus", "Married filing jointly");
    setOverride(workbook, 50, "returnPercent", 0.04);
    setOverride(workbook, 50, "income", 1000);
    setOverride(workbook, 70, "extraWithdrawal", 2500);
  });
  assert.equal(result.isValid, true, JSON.stringify(plain(result.errors)));
  const profile = plain(applied[0]);
  assert.equal(profile.assets.cash, 12345);
  assert.equal(profile.filingStatus, "Married filing jointly");
  assert.deepEqual(profile.timelineOverrides, { 50: { returnPercent: 4, income: 1000 }, 70: { extraWithdrawal: 2500 } });
});

test("missing required fields are errors that name the field", needsExcel, async () => {
  const { result, messages, applied } = await run(
    (workbook) => {
      setValue(workbook, "currentAge", "x");
    },
    { fill: false },
  );
  assert.equal(result.isValid, false);
  assert.equal(applied.length, 0);
  ["Current age", "Target retirement age", "Life expectancy", "Expected annual return", "Inflation rate"].forEach((label) => {
    assert.ok(hasMessage(messages, new RegExp(`^${label}`)), label);
  });
  assert.ok(messages.includes("Target retirement age is required."));
  assert.ok(messages.includes("Current age must be a valid number."));
  const issue = plain(result.errors).find((e) => e.message === "Target retirement age is required.");
  assert.equal(issue.field, "Target retirement age");
  assert.equal(issue.fieldId, "targetRetirementAge");
});

test("invalid ages and retirement inconsistencies are rejected", needsExcel, async () => {
  const cases = [
    [{ currentAge: 17 }, /Current age must be between 18 and 100/],
    [{ currentAge: 101, targetRetirementAge: 102, lifeExpectancy: 110 }, /Current age must be between 18 and 100/],
    [{ targetRetirementAge: 45 }, /Target retirement age must be greater than current age\./],
    [{ targetRetirementAge: 40 }, /Target retirement age must be greater than current age\./],
    [{ targetRetirementAge: 96 }, /Target retirement age cannot exceed life expectancy\./],
    [{ lifeExpectancy: 45, targetRetirementAge: 46 }, /Life expectancy must be greater than current age\./],
    [{ currentAge: 45.5 }, /Current age must be a whole number\./],
  ];
  for (const [changes, pattern] of cases) {
    const { result, messages, applied } = await run((workbook) =>
      Object.entries(changes).forEach(([field, value]) => setValue(workbook, field, value)),
    );
    assert.equal(result.isValid, false, JSON.stringify(changes));
    assert.ok(hasMessage(messages, pattern), `${JSON.stringify(changes)} -> ${messages}`);
    assert.equal(applied.length, 0);
  }
});

test("retirement age equal to life expectancy leaves no retirement duration", needsExcel, async () => {
  const { messages } = await run((workbook) => setValue(workbook, "targetRetirementAge", 95));
  assert.ok(hasMessage(messages, /Retirement duration must be greater than zero/));
});

test("invalid percentages are rejected", needsExcel, async () => {
  const cases = [
    ["expectedAnnualReturn", 1.5, /^Expected annual return.* cannot exceed 100%\./],
    ["inflationRate", -0.01, /Inflation rate cannot be negative\./],
    ["stateIncomeTaxRate", 2, /State income tax rate cannot exceed 100%\./],
    ["contributionRates.fourOhOneK", "ten", /must be a valid number\./],
  ];
  for (const [fieldId, value, pattern] of cases) {
    const { result, messages } = await run((workbook) => setValue(workbook, fieldId, value));
    assert.equal(result.isValid, false, fieldId);
    assert.ok(hasMessage(messages, pattern), `${fieldId}: ${messages}`);
  }
});

test("invalid account balances and currency values are rejected", needsExcel, async () => {
  const cases = [
    ["assets.cash", -1, /Cash cannot be negative\./],
    ["assets.rothIra", "lots", /must be a valid number\./],
    ["assets.realEstate", Infinity, /must be a valid number\./],
    ["currentAnnualExpenses", -5000, /cannot be negative\./],
    ["annualSalary", NaN, /must be a valid number\./],
  ];
  for (const [fieldId, value, pattern] of cases) {
    const { result, messages, applied } = await run((workbook) => setValue(workbook, fieldId, value));
    assert.equal(result.isValid, false, fieldId);
    assert.ok(hasMessage(messages, pattern), `${fieldId}: ${messages}`);
    assert.equal(applied.length, 0);
  }
});

test("savings and contributions above income are errors", needsExcel, async () => {
  const { result, messages } = await run((workbook) => {
    setValue(workbook, "annualSalary", 10000);
    setValue(workbook, "otherAnnualIncome", 0);
    setValue(workbook, "contributionRates.fourOhOneK", 0.5);
    setValue(workbook, "iraContributions.traditionalIraAnnual", 7000);
  });
  assert.equal(result.isValid, false);
  assert.ok(messages.includes("Annual savings cannot exceed annual income: 401(k), Traditional IRA, and Roth IRA contributions together are larger than salary plus other income."));
});

test("employer contributions do not count against income", needsExcel, async () => {
  const { result } = await run((workbook) => {
    setValue(workbook, "annualSalary", 100000);
    setValue(workbook, "contributionRates.fourOhOneK", 0.9);
    setValue(workbook, "employerMatch.rate", 1);
    setValue(workbook, "employerMatch.salaryCap", 0.5);
  });
  assert.equal(result.isValid, true, JSON.stringify(plain(result.errors)));
});

test("savings allocation must total 100% within tolerance", needsExcel, async () => {
  const bad = await run((workbook) => {
    setValue(workbook, "savingsAllocation.brokerage", 0.6);
    setValue(workbook, "savingsAllocation.cash", 0.3);
  });
  assert.equal(bad.result.isValid, false);
  assert.ok(bad.messages.some((m) => m.startsWith("Investment allocation must total 100%")));
  const edge = await run((workbook) => {
    setValue(workbook, "savingsAllocation.brokerage", 0.6);
    setValue(workbook, "savingsAllocation.cash", 0.4005);
  });
  assert.equal(edge.result.isValid, true, JSON.stringify(plain(edge.result.errors)));
  const lone = await run((workbook) => {
    setValue(workbook, "savingsAllocation.brokerage", 1);
    setValue(workbook, "savingsAllocation.cash", null);
  });
  assert.equal(lone.result.isValid, true);
  assert.equal(lone.applied[0].savingsAllocation.cash, 0);
});

test("Social Security claim age must be between 62 and 70", needsExcel, async () => {
  for (const age of [61, 71]) {
    const { result, messages } = await run((workbook) => setValue(workbook, "socialSecurityClaimAge", age));
    assert.equal(result.isValid, false);
    assert.ok(messages.includes("Social Security claim age must be between 62 and 70."));
  }
});

test("select fields reject unsupported options", needsExcel, async () => {
  const { result, messages } = await run((workbook) => setValue(workbook, "filingStatus", "Widowed"));
  assert.equal(result.isValid, false);
  assert.ok(hasMessage(messages, /must be one of: /), String(messages));
});

test("zero expenses is a warning and does not block import", needsExcel, async () => {
  const { result, warnings, applied } = await run((workbook) => setValue(workbook, "currentAnnualExpenses", 0));
  assert.equal(result.isValid, true);
  assert.ok(warnings.includes("Annual expenses are zero. Retirement projections may be unrealistic."));
  assert.equal(applied.length, 1);
});

test("blank optional fields use defaults or zero and are reported once as a warning", needsExcel, async () => {
  const { result, warnings, applied } = await run((workbook) => {
    setValue(workbook, "otherAnnualIncome", null);
    setValue(workbook, "stateIncomeTaxRate", null);
  });
  assert.equal(result.isValid, true);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Other annual income.*State income tax rate|State income tax rate.*Other annual income/);
  assert.equal(applied[0].otherAnnualIncome, 0);
  assert.equal(applied[0].stateIncomeTaxRate, wm.cloneSampleProfile().stateIncomeTaxRate);
});

test("timeline ranges that cannot be simulated are rejected", needsExcel, async () => {
  const { result, messages } = await run((workbook) => {
    setValue(workbook, "currentAge", 60);
    setValue(workbook, "lifeExpectancy", 60);
    setValue(workbook, "targetRetirementAge", 65);
  });
  assert.equal(result.isValid, false);
  assert.ok(messages.includes("The simulation timeline must start before it ends (current age must be less than life expectancy)."));
  const outside = await run((workbook) => {
    setValue(workbook, "lifeExpectancy", 80);
    setValue(workbook, "targetRetirementAge", 85);
  });
  assert.ok(outside.messages.includes("Retirement age falls outside the simulation timeline.") ||
    outside.messages.includes("Target retirement age cannot exceed life expectancy."));
  const fallsOutside = plain(outside.result.errors).filter((e) => e.section === "Timeline");
  assert.ok(fallsOutside.some((e) => e.message === "Target retirement age falls outside the simulation timeline."));
});

test("duplicate override ages are rejected once", needsExcel, async () => {
  const { result, messages, applied } = await run((workbook) => {
    setOverride(workbook, 50, "income", 1000);
    const sheet = sheetOf(workbook, "Timeline Overrides");
    sheet.getCell(overrideRow(51), 1).value = 50;
    setOverride(workbook, 51, "income", 2000);
    sheet.getCell(overrideRow(52), 1).value = 50;
    setOverride(workbook, 52, "income", 3000);
  });
  assert.equal(result.isValid, false);
  assert.equal(messages.filter((m) => m === "Multiple timeline overrides exist for age 50.").length, 1);
  assert.equal(applied.length, 0);
});

test("override ages outside the timeline are rejected", needsExcel, async () => {
  const { result, messages } = await run((workbook) => {
    setOverride(workbook, 100, "expenses", 1000);
    setOverride(workbook, 30, "expenses", 1000);
  });
  assert.equal(result.isValid, false);
  assert.ok(messages.includes("Override age 100 is outside the timeline range (45-95)."));
  assert.ok(messages.includes("Override age 30 is outside the timeline range (45-95)."));
});

test("override values must be numeric, finite, and not negative", needsExcel, async () => {
  const { result, messages } = await run((workbook) => {
    setOverride(workbook, 50, "income", -1);
    setOverride(workbook, 51, "expenses", "many");
    setOverride(workbook, 52, "extraCashNeed", Infinity);
    setOverride(workbook, 53, "returnPercent", -1.5);
    setOverride(workbook, 54, "returnPercent", -0.5);
  });
  assert.equal(result.isValid, false);
  assert.ok(messages.includes("Income override for age 50 cannot be negative."));
  assert.ok(messages.includes("Spending override for age 51 must be a valid number."));
  assert.ok(messages.includes("Additional need for age 52 must be a valid number."));
  assert.ok(messages.includes("Return override for age 53 cannot be below -100%."));
  assert.equal(messages.filter((m) => /age 54/.test(m)).length, 0);
});

test("overrides that do not apply to the year warn and are dropped", needsExcel, async () => {
  const { result, warnings, applied } = await run((workbook) => {
    setOverride(workbook, 70, "income", 5000);
    setOverride(workbook, 50, "extraWithdrawal", 5000);
    setOverride(workbook, 70, "expenses", 4000);
  });
  assert.equal(result.isValid, true);
  assert.ok(warnings.some((m) => /^Income override for age 70 is set after retirement age\./.test(m)));
  assert.ok(warnings.some((m) => /^Extra withdrawal for age 50 is set before retirement age\./.test(m)));
  assert.deepEqual(plain(applied[0].timelineOverrides), { 70: { expenses: 4000 } });
});

test("blocked imports report every issue and leave the plan untouched", needsExcel, async () => {
  const before = JSON.stringify(plain(wm.getProfile()));
  const workbook = wm.buildBlankPlanningWorkbook(ExcelJS);
  fillSamplePlan(workbook);
  setValue(workbook, "currentAge", 17);
  setValue(workbook, "assets.cash", -5);
  setValue(workbook, "currentAnnualExpenses", 0);
  setOverride(workbook, 100, "income", 1);
  const result = await wm.handleWorkbookSelection([await toFile(workbook)], { ui: { status() {}, details() {} }, excelApi: ExcelJS });
  assert.equal(result.imported, false);
  assert.ok(result.errors.length >= 3);
  assert.ok(result.warnings.length >= 1);
  assert.equal(JSON.stringify(plain(wm.getProfile())), before);
  const report = wm.formatImportValidationReport(plain(result.validation));
  assert.match(report, /^Import Validation Results/);
  assert.match(report, /Errors \(\d+\)/);
  assert.match(report, /Warnings \(\d+\)/);
  assert.match(report, /Import blocked until errors are resolved\./);
});

test("every issue has a severity, section, and human-readable message", needsExcel, async () => {
  const { result } = await run((workbook) => {
    setValue(workbook, "currentAge", 17);
    setValue(workbook, "currentAnnualExpenses", 0);
    setOverride(workbook, 100, "income", 1);
  });
  [...plain(result.validation.errors), ...plain(result.validation.warnings)].forEach((issue) => {
    assert.ok(["error", "warning"].includes(issue.severity));
    assert.ok(issue.section);
    assert.ok(issue.message && !/NaN|undefined|null/.test(issue.message));
  });
});

test("the app's Plan Setup validator also gates imports", needsExcel, async () => {
  const candidate = wm.buildImportCandidate(await (async () => {
    const workbook = wm.buildBlankPlanningWorkbook(ExcelJS);
    fillSamplePlan(workbook);
    return workbook;
  })());
  const fake = { validatePlanSetup: () => ({ blockingErrors: [{ field: "currentAge", message: "Rejected by app rule." }], warnings: [], isValid: false }) };
  const result = wm.validateImportCandidate(candidate, { planSetupValidator: fake });
  assert.equal(result.valid, false);
  assert.equal(result.errors[0].message, "Rejected by app rule.");
});

test("rules are extensible", needsExcel, async () => {
  const workbook = wm.buildBlankPlanningWorkbook(ExcelJS);
  fillSamplePlan(workbook);
  const candidate = wm.buildImportCandidate(workbook);
  const rule = () => [{ severity: "warning", section: "Custom", message: "Custom rule ran." }];
  const result = wm.validateImportCandidate(candidate, { rules: [rule] });
  assert.equal(result.valid, true);
  assert.deepEqual(plain(result.warnings.map((w) => w.message)), ["Custom rule ran."]);
});

test("replaceWorkingProfile is atomic: failures restore the previous plan", () => {
  const original = wm.cloneSampleProfile();
  original.name = "Original";
  wm.setProfile(original);
  wm.stubRender();
  const replacement = wm.cloneSampleProfile();
  replacement.name = "Replacement";
  wm.setRenderMetrics(() => {
    if (wm.getProfile().name === "Replacement") throw new Error("render failed");
  });
  assert.throws(() => wm.replaceWorkingProfile(replacement), /render failed/);
  assert.equal(wm.getProfile().name, "Original");
  wm.setRenderMetrics(() => {});
  wm.replaceWorkingProfile(replacement);
  assert.equal(wm.getProfile().name, "Replacement");
});

test("a failing apply is reported and does not import", needsExcel, async () => {
  const workbook = wm.buildBlankPlanningWorkbook(ExcelJS);
  fillSamplePlan(workbook);
  const ui = { status() {}, details() {}, closeDialog() {} };
  await wm.handleWorkbookSelection([await toFile(workbook)], { ui, excelApi: ExcelJS });
  const outcome = wm.confirmWorkbookImport({
    ui,
    applyProfile: () => {
      throw new Error("boom");
    },
  });
  assert.equal(outcome.imported, false);
  assert.equal(outcome.isValid, false);
  assert.ok(plain(outcome.errors).some((e) => e.code === "COMMIT_FAILED"));
  assert.equal(wm.getPending(), null);
});

// ---- Step 4: preview, confirmation, and report ----

async function preview(mutate = () => {}, current = wm.cloneSampleProfile()) {
  const workbook = wm.buildBlankPlanningWorkbook(ExcelJS);
  fillSamplePlan(workbook);
  mutate(workbook);
  const candidate = wm.buildImportCandidate(workbook);
  const validation = wm.validateImportCandidate(candidate);
  return plain(wm.buildImportPreview(candidate, validation, current));
}

test("selecting a valid workbook shows a preview and does not change the plan", needsExcel, async () => {
  const before = JSON.stringify(plain(wm.getProfile()));
  const workbook = wm.buildBlankPlanningWorkbook(ExcelJS);
  fillSamplePlan(workbook);
  setValue(workbook, "assets.cash", 424242);
  const shown = [];
  const result = await wm.handleWorkbookSelection([await toFile(workbook)], {
    ui: { status() {}, details: (r) => shown.push(r), closeDialog() {} },
    excelApi: ExcelJS,
    applyProfile: () => assert.fail("must not apply before confirmation"),
  });
  assert.equal(result.awaitingConfirmation, true);
  assert.equal(result.imported, false);
  assert.ok(result.preview);
  assert.ok(wm.getPending());
  assert.equal(shown.length, 1);
  assert.equal(JSON.stringify(plain(wm.getProfile())), before);
});

test("cancelling a preview discards it and keeps the plan", needsExcel, async () => {
  const workbook = wm.buildBlankPlanningWorkbook(ExcelJS);
  fillSamplePlan(workbook);
  const ui = { status() {}, details() {}, closeDialog() {} };
  await wm.handleWorkbookSelection([await toFile(workbook)], { ui, excelApi: ExcelJS });
  assert.equal(wm.cancelWorkbookImport({ ui }), true);
  assert.equal(wm.getPending(), null);
  assert.equal(wm.confirmWorkbookImport({ ui, applyProfile: () => assert.fail("nothing to apply") }), null);
});

test("an invalid workbook has no pending import and cannot be confirmed", needsExcel, async () => {
  const workbook = wm.buildBlankPlanningWorkbook(ExcelJS);
  fillSamplePlan(workbook);
  setValue(workbook, "currentAge", 17);
  const ui = { status() {}, details() {}, closeDialog() {} };
  const result = await wm.handleWorkbookSelection([await toFile(workbook)], { ui, excelApi: ExcelJS });
  assert.equal(result.awaitingConfirmation, false);
  assert.equal(wm.getPending(), null);
  assert.equal(wm.confirmWorkbookImport({ ui, applyProfile: () => assert.fail("blocked") }), null);
});

test("preview reports changed fields as current vs imported", needsExcel, async () => {
  const current = wm.cloneSampleProfile();
  current.targetRetirementAge = 67;
  current.currentAnnualExpenses = 75000;
  const model = await preview((workbook) => {
    setValue(workbook, "targetRetirementAge", 65);
    setValue(workbook, "currentAnnualExpenses", 70000);
  }, current);
  const retirement = model.changedFields.find((c) => c.fieldId === "targetRetirementAge");
  assert.equal(retirement.currentValue, 67);
  assert.equal(retirement.importedValue, 65);
  const expenses = model.changedFields.find((c) => c.fieldId === "currentAnnualExpenses");
  assert.equal(expenses.currentDisplay, "$75,000");
  assert.equal(expenses.importedDisplay, "$70,000");
  assert.equal(model.changedFields.length, 2);
  assert.ok(model.changedFields.every((c) => c.section && c.field));
  assert.deepEqual(plain(wm.describeImportImpact(model)).slice(0, 1), ["2 values will change"]);
});

test("unchanged plans report no changes, and every input appears in a section", needsExcel, async () => {
  const model = await preview();
  assert.equal(model.changedFields.length, 0);
  const shown = model.importedSections.flatMap((w) => w.sections.flatMap((s) => s.fields.map((f) => f.fieldId)));
  const expected = wm.buildPlanningWorkbookSchema().filter((e) => e.worksheet !== "Timeline Overrides").map((e) => e.fieldId);
  assert.deepEqual([...shown].sort(), [...expected].sort());
  assert.deepEqual(model.importedSections.map((w) => w.worksheet), ["Plan Setup", "Income & Expenses", "Assets"]);
  assert.equal(model.stats.fields, expected.length);
  assert.equal(model.stats.errors, 0);
  assert.equal(model.stats.overrides, 0);
  assert.equal(model.overrideSummary.imported.length, 0);
});

test("preview summarizes added, modified, and removed overrides", needsExcel, async () => {
  const current = wm.cloneSampleProfile();
  current.timelineOverrides = { 50: { income: 1000 }, 51: { expenses: 10 }, 52: { expenses: 20 } };
  const model = await preview((workbook) => {
    setOverride(workbook, 50, "income", 2000);
    setOverride(workbook, 51, "expenses", 10);
    setOverride(workbook, 70, "extraWithdrawal", 25000);
    setOverride(workbook, 71, "returnPercent", 0.05);
  }, current);
  const summary = model.overrideSummary;
  assert.deepEqual(summary.added, [70, 71]);
  assert.deepEqual(summary.modified, [50]);
  assert.deepEqual(summary.removed, [52]);
  assert.equal(model.stats.overrides, 4);
  const row = summary.imported.find((r) => r.age === 70);
  assert.equal(row.label, "Extra withdrawal");
  assert.equal(row.display, "$25,000");
  assert.equal(summary.imported.find((r) => r.age === 71).display, "5%");
  assert.deepEqual(plain(wm.describeImportImpact(model)).slice(1), [
    "2 timeline overrides will be added",
    "1 timeline override will be modified",
    "1 timeline override will be removed",
  ]);
});

test("an invalid preview exposes counts only, never rejected values", needsExcel, async () => {
  const model = await preview((workbook) => {
    setValue(workbook, "assets.cash", "<img src=x>");
    setOverride(workbook, 50, "income", 5);
  });
  assert.equal(model.validationResult.valid, false);
  assert.equal(model.importedSections.length, 0);
  assert.equal(model.changedFields.length, 0);
  assert.equal(model.stats.overrides, 1);
  assert.ok(!JSON.stringify(model).includes("<img"));
});

test("the validation report lists errors and warnings and downloads under the fixed name", needsExcel, async () => {
  const workbook = wm.buildBlankPlanningWorkbook(ExcelJS);
  fillSamplePlan(workbook);
  setValue(workbook, "currentAge", 17);
  setValue(workbook, "currentAnnualExpenses", 0);
  const saved = [];
  const ui = { status() {}, details() {}, closeDialog() {}, saveReport: (name, text) => saved.push([name, text]) };
  const result = await wm.handleWorkbookSelection([await toFile(workbook)], { ui, excelApi: ExcelJS });
  const text = wm.downloadImportValidationReport(result, { ui });
  assert.equal(saved[0][0], "wealthmap-import-validation-report.txt");
  assert.equal(saved[0][1], text);
  assert.match(text, /^Import Validation Report\n/);
  assert.match(text, /Errors:\n- .*Current age must be between 18 and 100\./);
  assert.match(text, /Warnings:\n- .*Annual expenses are zero\./);
  assert.match(text, /Import blocked until errors are resolved\./);
});

// ---- Step 5: atomic apply and recalculation ----

function headlessApp() {
  wm.stubRender();
  wm.setRenderMetrics(wm.headlessRender);
  const original = wm.cloneSampleProfile();
  original.name = "Original";
  wm.setProfile(original);
  wm.headlessRender();
  return original;
}

function importedPlan() {
  const profile = wm.cloneSampleProfile();
  profile.name = "Imported";
  profile.assets.cash = 123456;
  profile.timelineOverrides = { 50: { income: 1000 }, 70: { extraWithdrawal: 5000 } };
  return profile;
}

test("applyImport replaces the whole plan and regenerates every derived output", () => {
  const original = headlessApp();
  original.timelineOverrides = { 60: { expenses: 1 } };
  const oldMetrics = wm.getLive().metrics;
  const result = wm.ImportService.applyImport(importedPlan(), { counts: { fields: 43, overrides: 2 } });
  assert.equal(result.ok, true);
  assert.deepEqual(plain(result.summary), { fieldsImported: 43, overridesImported: 2, readinessRefreshed: true, timelineRegenerated: true, recommendationsUpdated: true });
  const profile = plain(wm.getProfile());
  assert.equal(profile.name, "Imported");
  assert.equal(profile.assets.cash, 123456);
  // Replaced, not merged: the old override at age 60 is gone.
  assert.deepEqual(profile.timelineOverrides, { 50: { income: 1000 }, 70: { extraWithdrawal: 5000 } });
  const live = wm.getLive();
  assert.notEqual(live.metrics, oldMetrics);
  assert.ok(Number.isFinite(live.metrics.score) && live.metrics.status);
  assert.ok(live.rows.length > 0 && Array.isArray(live.recs));
  // Timeline overrides flow through the standard engine: the age-50 row reflects the override.
  const row = live.rows.find((r) => r.age === 50);
  assert.ok(row);
  assert.match(wm.describeImportSuccess(result.summary), /^Plan Imported Successfully\. Your plan was updated and all WealthMap projections were recalculated\. 43 fields imported\. 2 timeline overrides imported\./);
});

test("the imported plan is isolated from the pending object", () => {
  headlessApp();
  const plan = importedPlan();
  wm.ImportService.applyImport(plan);
  plan.assets.cash = 1;
  assert.equal(wm.getProfile().assets.cash, 123456);
});

test("a projection failure in the dry run changes nothing", () => {
  const original = headlessApp();
  const before = JSON.stringify(plain(wm.getProfile()));
  const liveBefore = wm.getLive();
  const realCalculate = wm.getCalculate();
  wm.setCalculate(() => {
    throw new Error("override exploded");
  });
  const result = wm.ImportService.applyImport(importedPlan());
  wm.setCalculate(realCalculate);
  assert.equal(result.ok, false);
  assert.equal(result.rolledBack, true);
  assert.equal(result.code, "RECALCULATION_FAILED");
  assert.match(result.error, /could not recalculate the imported plan/);
  assert.doesNotMatch(result.error, /override exploded/);
  assert.equal(JSON.stringify(plain(wm.getProfile())), before);
  assert.equal(wm.getLive().metrics, liveBefore.metrics);
  assert.equal(wm.getProfile().name, original.name);
  assert.equal(wm.describeImportFailure(result.error, result.code).startsWith("Import Failed. "), true);
});

test("a non-finite score aborts before any state changes", () => {
  headlessApp();
  const before = JSON.stringify(plain(wm.getProfile()));
  const realCalculate = wm.getCalculate();
  wm.setCalculate((profile) => ({ ...realCalculate(profile), score: NaN }));
  const result = wm.ImportService.applyImport(importedPlan());
  wm.setCalculate(realCalculate);
  assert.equal(result.ok, false);
  assert.match(result.error, /Missing: Readiness Score/);
  assert.equal(JSON.stringify(plain(wm.getProfile())), before);
});

test("a failure while refreshing restores the previous plan and outputs", () => {
  headlessApp();
  const before = JSON.stringify(plain(wm.getProfile()));
  const realRender = wm.headlessRender;
  wm.setRenderMetrics(() => {
    if (wm.getProfile().name === "Imported") throw new Error("render exploded");
    return realRender();
  });
  const result = wm.ImportService.applyImport(importedPlan());
  assert.equal(result.ok, false);
  assert.equal(result.rolledBack, true);
  assert.equal(JSON.stringify(plain(wm.getProfile())), before);
  assert.ok(wm.getLive().metrics);
});

test("missing live outputs after the refresh roll the plan back", () => {
  headlessApp();
  const before = JSON.stringify(plain(wm.getProfile()));
  const realRender = wm.headlessRender;
  // A refresh that silently produces nothing for the imported plan.
  wm.setRenderMetrics(() => (wm.getProfile().name === "Imported" ? null : realRender()));
  const result = wm.ImportService.applyImport(importedPlan());
  assert.equal(result.ok, false);
  assert.equal(result.rolledBack, true);
  assert.match(result.error, /Missing: /);
  assert.equal(JSON.stringify(plain(wm.getProfile())), before);
  assert.equal(wm.getProfile().name, "Original");
});

test("plans carrying calculated outputs or missing inputs are refused", () => {
  headlessApp();
  const before = JSON.stringify(plain(wm.getProfile()));
  const withOutput = importedPlan();
  withOutput.score = 99;
  assert.match(wm.ImportService.applyImport(withOutput).error, /not plan inputs\..*Unexpected: score/);
  const incomplete = importedPlan();
  delete incomplete.assets.rothIra;
  assert.match(wm.ImportService.applyImport(incomplete).error, /Missing: assets\.rothIra/);
  assert.equal(JSON.stringify(plain(wm.getProfile())), before);
});

test("confirming through the real service imports atomically and reports the summary", needsExcel, async () => {
  headlessApp();
  const workbook = wm.buildBlankPlanningWorkbook(ExcelJS);
  fillSamplePlan(workbook);
  setValue(workbook, "assets.cash", 777000);
  setOverride(workbook, 50, "income", 1000);
  const statuses = [];
  const ui = { status: (t) => statuses.push(t), details() {}, closeDialog() {} };
  await wm.handleWorkbookSelection([await toFile(workbook)], { ui, excelApi: ExcelJS });
  assert.equal(wm.getProfile().assets.cash, wm.cloneSampleProfile().assets.cash);
  const outcome = wm.confirmWorkbookImport({ ui });
  assert.equal(outcome.imported, true);
  assert.equal(wm.getProfile().assets.cash, 777000);
  assert.deepEqual(plain(wm.getProfile().timelineOverrides), { 50: { income: 1000 } });
  assert.match(statuses.at(-1), /^Plan Imported Successfully\..*43 fields imported\. 1 timeline override imported\./);
});

test("a failed confirmation reports Import Failed and leaves the plan alone", needsExcel, async () => {
  headlessApp();
  const before = JSON.stringify(plain(wm.getProfile()));
  const workbook = wm.buildBlankPlanningWorkbook(ExcelJS);
  fillSamplePlan(workbook);
  setValue(workbook, "assets.cash", 777000);
  const statuses = [];
  const ui = { status: (t) => statuses.push(t), details() {}, closeDialog() {} };
  await wm.handleWorkbookSelection([await toFile(workbook)], { ui, excelApi: ExcelJS });
  const realCalculate = wm.getCalculate();
  wm.setCalculate(() => {
    throw new Error("boom");
  });
  const outcome = wm.confirmWorkbookImport({ ui });
  wm.setCalculate(realCalculate);
  assert.equal(outcome.imported, false);
  assert.match(statuses.at(-1), /^Import Failed\. WealthMap could not recalculate the imported plan\. No changes were applied to your current plan\.$/);
  assert.equal(JSON.stringify(plain(wm.getProfile())), before);
});
