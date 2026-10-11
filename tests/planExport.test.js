const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

function load() {
  const sandbox = { console: { ...console, info() {} }, Math, Number, Intl, Object, Array, JSON, Date, Set, Map, Uint8Array };
  vm.createContext(sandbox);
  vm.runInContext(
    `${["data.js", "validation.js", "app.js", "workbook.js", "workbookImport.js", "planExport.js"].map(read).join("\n")}
     var __pe = { buildPlanExportModel, validatePlanExportModel, setPlanExportLogger, cloneSampleProfile,
       buildSupportedInputInventory, workbookFieldIdIsProhibited, calculate };`,
    sandbox,
    { filename: "plan-export.js" },
  );
  return sandbox.__pe;
}

const pe = load();
const flat = (model) => ({ ...model.profile, ...model.assumptions, ...model.incomeAndExpenses, ...model.assets });

test("complete plan exports every supported non-timeline input", () => {
  const profile = pe.cloneSampleProfile();
  const model = pe.buildPlanExportModel(profile);
  const expected = pe.buildSupportedInputInventory()
    .filter((item) => !item.fieldId.startsWith("timelineOverrides."))
    .map((item) => item.fieldId);
  assert.deepEqual([...Object.keys(flat(model))].sort(), [...expected].sort());
  assert.equal(model.profile.currentAge, 45);
  assert.equal(model.assets["assets.realEstate"], 450000);
  assert.equal(model.assets["assets.cash"], 20000);
  assert.equal(model.timelineOverrides.length, 0);
  const result = pe.validatePlanExportModel(model);
  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
});

test("zero values and types survive; blank optional values stay blank", () => {
  const profile = pe.cloneSampleProfile();
  profile.otherAnnualIncome = 0;
  profile.stateIncomeTaxRate = 0;
  profile.assets.cash = 0;
  profile.niitThreshold = undefined;
  profile.irmaaAnnualSurcharge = "";
  const f = flat(pe.buildPlanExportModel(profile));
  assert.equal(f.otherAnnualIncome, 0);
  assert.equal(f.stateIncomeTaxRate, 0);
  assert.equal(f["assets.cash"], 0);
  assert.equal(f.niitThreshold, null);
  assert.equal(f.irmaaAnnualSurcharge, null);
  assert.equal(typeof f.expectedAnnualReturn, "number");
  assert.equal(typeof f.filingStatus, "string");
});

test("timeline overrides are exported sorted, including zeros, and only when real", () => {
  const profile = pe.cloneSampleProfile();
  profile.timelineOverrides = {
    70: { expenses: 0, extraWithdrawal: 5000 },
    50: { expenses: 85000, returnPercent: -2 },
    46: { extraCashNeed: 0 },
    20: { expenses: 1 },
    52: { income: 999 },
    71: { income: 5 },
  };
  profile.timelineOverrides[60] = {};
  const { timelineOverrides } = pe.buildPlanExportModel(profile);
  assert.deepEqual(JSON.parse(JSON.stringify(timelineOverrides)), [
    { age: 46, field: "extraCashNeed", value: 0 },
    { age: 50, field: "returnPercent", value: -2 },
    { age: 50, field: "expenses", value: 85000 },
    { age: 52, field: "income", value: 999 },
    { age: 70, field: "expenses", value: 0 },
    { age: 70, field: "extraWithdrawal", value: 5000 },
  ]);
  assert.equal(pe.validatePlanExportModel(pe.buildPlanExportModel(profile)).valid, true);
});

test("calculated outputs never appear", () => {
  const profile = pe.cloneSampleProfile();
  profile.timelineOverrides = { 50: { expenses: 1000 } };
  const model = pe.buildPlanExportModel(profile);
  const ids = Object.keys(flat(model));
  assert.ok(ids.every((id) => !pe.workbookFieldIdIsProhibited(id)));
  assert.ok(!ids.includes("socialSecurityEstimatedBenefit"));
  const text = JSON.stringify(model);
  ["readinessScore", "recommendations", "projectedAssets", "safeSpending", "fundingGap"].forEach((word) =>
    assert.ok(!text.includes(word), word),
  );
  const tampered = JSON.parse(text);
  tampered.assumptions.safeSpending = 1;
  assert.ok(pe.validatePlanExportModel(tampered).errors.some((e) => e.code === "calculatedOutput"));
});

test("repeated calls are equivalent and do not alias or mutate the profile", () => {
  const profile = pe.cloneSampleProfile();
  profile.timelineOverrides = { 50: { expenses: 1000 } };
  const snapshot = JSON.stringify(profile);
  const a = pe.buildPlanExportModel(profile);
  const b = pe.buildPlanExportModel(profile);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(JSON.stringify(profile), snapshot);
});

test("validation flags unusable values without echoing them", () => {
  const model = JSON.parse(JSON.stringify(pe.buildPlanExportModel(pe.cloneSampleProfile())));
  model.assets["assets.cash"] = NaN;
  model.assumptions.inflationRate = 5;
  model.profile.currentAge = null;
  model.timelineOverrides = [{ age: 50, field: "expenses", value: -1 }];
  const { valid, errors } = pe.validatePlanExportModel(model);
  assert.equal(valid, false);
  const codes = errors.map((e) => e.code);
  ["notFiniteNumber", "percentOutOfRange", "missingRequired", "invalidOverride"].forEach((c) => assert.ok(codes.includes(c), c));
  assert.ok(errors.every((e) => Object.keys(e).sort().join() === "code,path"));
  assert.equal(pe.validatePlanExportModel(undefined).valid, false);
});

test("logging reports counts only", () => {
  const entries = [];
  pe.setPlanExportLogger((e) => entries.push(e));
  const profile = pe.cloneSampleProfile();
  profile.timelineOverrides = { 50: { expenses: 1000 } };
  pe.buildPlanExportModel(profile);
  assert.equal(entries.length, 1);
  assert.deepEqual(Object.keys(entries[0]).sort(), ["event", "fieldCount", "timelineOverrideCount"]);
  assert.equal(entries[0].timelineOverrideCount, 1);
  assert.ok(!JSON.stringify(entries).includes("450000"));
});
