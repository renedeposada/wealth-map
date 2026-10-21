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
    `${["data.js", "validation.js", "app.js", "workbook.js", "importValidation.js", "importPreview.js", "importService.js", "workbookImport.js", "planExport.js", "roundTripValidation.js"].map(read).join("\n")}
     var __rt = { validateExportImportRoundTrip, compareProfiles, compareTimelineOverrides, pathGet, stableRoundTripValue,
       cloneSampleProfile, buildSupportedInputInventory };`,
    sandbox,
    { filename: "round-trip.js" },
  );
  return sandbox.__rt;
}

const rt = load();
const plain = (value) => JSON.parse(JSON.stringify(value));
const sample = () => rt.cloneSampleProfile();

function withOverrides(overrides) {
  const profile = sample();
  profile.timelineOverrides = overrides;
  return profile;
}

function roundTrip(profile) {
  const result = plain(rt.validateExportImportRoundTrip(profile));
  assert.deepEqual(result.validationErrors, [], JSON.stringify(result.validationErrors));
  assert.deepEqual(result.differences, []);
  assert.equal(result.success, true);
  return result;
}

test("helpers: pathGet, stableRoundTripValue, tolerance", () => {
  assert.equal(rt.pathGet({ a: { b: 3 } }, "a.b"), 3);
  assert.equal(rt.pathGet({ a: null }, "a.b"), undefined);
  assert.equal(rt.stableRoundTripValue(undefined), null);
  assert.equal(rt.stableRoundTripValue("  "), null);
  assert.equal(rt.stableRoundTripValue(NaN), null);
  assert.equal(rt.stableRoundTripValue(5), 5);
  const inventory = rt.buildSupportedInputInventory();
  const a = { currentAge: 50 };
  assert.deepEqual(plain(rt.compareProfiles(a, { currentAge: 50 + 1e-9 }, inventory)), []);
  assert.deepEqual(plain(rt.compareProfiles(a, { currentAge: 51 }, inventory)), [
    { type: "changed", fieldId: "currentAge", original: 50, imported: 51 },
  ]);
  assert.deepEqual(plain(rt.compareProfiles(a, {}, inventory)), [{ type: "missing", fieldId: "currentAge" }]);
});

test("sample profile survives export -> import -> compare", needsExcel, () => {
  roundTrip(sample());
});

test("empty timeline overrides round-trip", needsExcel, () => {
  roundTrip(withOverrides({}));
});

test("timeline overrides survive with ages, types and values", needsExcel, () => {
  const base = sample();
  const working = base.currentAge + 1;
  const retired = base.targetRetirementAge + 2;
  const profile = withOverrides({
    [working]: { returnPercent: 7.25, income: 123456, expenses: 54321, extraCashNeed: 9000 },
    [retired]: { returnPercent: -12.5, expenses: 70000, extraWithdrawal: 15000 },
  });
  roundTrip(profile);
  const imported = plain(rt.compareTimelineOverrides(profile, profile));
  assert.deepEqual(imported, []);
});

test("custom Social Security settings survive", needsExcel, () => {
  const profile = sample();
  Object.assign(profile, { socialSecurityBenefitMode: "manual", socialSecurityAnnualBenefit: 31250, socialSecurityClaimAge: 68, socialSecurityStrategy: "auto" });
  roundTrip(profile);
});

test("custom contribution and allocation settings survive", needsExcel, () => {
  const profile = sample();
  profile.contributionRates = { ...profile.contributionRates, fourOhOneK: 0.08 };
  profile.iraContributions = { traditionalIraAnnual: 2500, rothIraAnnual: 1500 };
  profile.savingsAllocation = { brokerage: 0.3, cash: 0.7 };
  roundTrip(profile);
});

test("asset balances survive", needsExcel, () => {
  const profile = sample();
  Object.assign(profile.assets, { brokerage: 111111, rothIra: 22222, cash: 33333, realEstate: 444444 });
  roundTrip(profile);
});

test("an intentional mismatch after import is reported", needsExcel, () => {
  const result = plain(
    rt.validateExportImportRoundTrip(sample(), {
      transformImported: (imported) => {
        imported.currentAge += 1;
        return imported;
      },
    }),
  );
  assert.equal(result.success, false);
  assert.ok(result.differences.length > 0);
  assert.ok(result.differences.every((d) => !("row" in d) && !("column" in d) && !("worksheet" in d)));
});

test("a changed override after import is reported", needsExcel, () => {
  const age = sample().currentAge + 1;
  const result = plain(
    rt.validateExportImportRoundTrip(withOverrides({ [age]: { expenses: 50000 } }), {
      transformImported: (imported) => {
        imported.timelineOverrides[age].expenses = 1;
        return imported;
      },
    }),
  );
  assert.equal(result.success, false);
  assert.equal(result.differences[0].type, "changed");
  assert.equal(result.differences[0].fieldId, `timelineOverrides.${age}.expenses`);
});
