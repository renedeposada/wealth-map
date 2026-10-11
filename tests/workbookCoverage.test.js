const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

function loadModel() {
  const sandbox = { console, Math, Number, Intl, Object, Array, JSON, Date, Set, Map };
  vm.createContext(sandbox);
  vm.runInContext(
    `${read("data.js")}\n${read("app.js")}\n${read("workbook.js")}\nvar __wm = { buildSupportedInputInventory, buildPlanningWorkbookSchema, buildBlankPlanningWorkbook, auditWorkbookInputCoverage, auditWorkbookForCalculatedOutputs, formatCalculatedOutputAudit, WORKBOOK_PROHIBITED_FIELD_IDS, WORKBOOK_ALLOWED_CLASSIFICATIONS, inputConfig, calculate, cloneSampleProfile, SAMPLE_PROFILE, ASSET_METADATA, TIMELINE_OVERRIDE_FIELDS, WORKBOOK_LAYOUT };`,
    sandbox,
    { filename: "wealth-map-workbook.js" },
  );
  return sandbox.__wm;
}

const wm = loadModel();
const inventory = wm.buildSupportedInputInventory();
const ids = Array.from(inventory, (item) => item.fieldId);

function resolvePath(object, fieldId) {
  return fieldId.split(".").reduce((value, key) => value?.[key], object);
}

test("inventory covers every editable inputConfig field and excludes read-only ones", () => {
  const config = wm.inputConfig();
  const editable = Object.values(config)
    .flat()
    .filter(([, , type]) => type !== "readonly")
    .map(([key]) => key);
  assert.deepEqual([...ids.filter((id) => editable.includes(id))].sort(), [...editable].sort());
  assert.ok(!ids.includes("socialSecurityEstimatedBenefit"));
});

test("inventory covers every asset in ASSET_METADATA, workingProfile.assets and the Real Estate input", () => {
  const assetIds = Array.from(ids).filter((id) => id.startsWith("assets."));
  assert.deepEqual(
    assetIds.sort(),
    Object.keys(wm.SAMPLE_PROFILE.assets).map((key) => `assets.${key}`).sort(),
  );
  assert.deepEqual(
    assetIds.sort(),
    Object.keys(wm.ASSET_METADATA).map((key) => `assets.${key}`).sort(),
  );
  assert.match(read("index.html"), /data-field="assets\.realEstate"/);
});

test("every static data-field in index.html is in the inventory", () => {
  const staticFields = [...read("index.html").matchAll(/data-field="([^"]+)"/g)].map((m) => m[1]);
  staticFields.forEach((id) => assert.ok(ids.includes(id), `${id} missing`));
});

test("timeline inventory matches the override fields rendered in the Timeline table", () => {
  const appSource = read("app.js");
  const rendered = new Set(
    [...appSource.matchAll(/timelineInputCell\(row\.age, "([A-Za-z]+)"/g)].map((m) => m[1]),
  );
  [...appSource.matchAll(/extraField = row\.isRetired \? "(\w+)" : "(\w+)"/g)].forEach((m) => {
    rendered.add(m[1]);
    rendered.add(m[2]);
  });
  const inventoryFields = new Set(
    inventory.filter((item) => item.worksheet === "Timeline Overrides").map((item) => item.fieldId.split(".")[1]),
  );
  assert.deepEqual([...inventoryFields].sort(), [...rendered].sort());
  assert.deepEqual(
    [...inventoryFields].sort(),
    ["expenses", "extraCashNeed", "extraWithdrawal", "income", "returnPercent"],
  );
});

test("field IDs are unique, resolve to the profile, and have complete metadata", () => {
  assert.equal(new Set(ids).size, ids.length);
  const profile = wm.cloneSampleProfile();
  inventory
    .filter((item) => item.worksheet !== "Timeline Overrides")
    .forEach((item) => assert.notEqual(resolvePath(profile, item.fieldId), undefined, item.fieldId));
  inventory.forEach((item) => {
    ["fieldId", "label", "source", "worksheet", "section", "dataType", "description"].forEach((key) =>
      assert.ok(item[key], `${item.fieldId}.${key}`),
    );
    assert.equal(item.editable, true);
    if (item.dataType === "select") assert.ok(item.allowedValues.length > 0, item.fieldId);
  });
});

test("select options keep the internal value alongside the display label", () => {
  const mode = inventory.find((item) => item.fieldId === "socialSecurityBenefitMode");
  assert.deepEqual(JSON.parse(JSON.stringify(mode.allowedValues)), [
    { value: "auto", label: "Automatically estimate" },
    { value: "manual", label: "Enter manually" },
  ]);
  const filing = inventory.find((item) => item.fieldId === "filingStatus");
  assert.ok(filing.allowedValues.some((o) => o.value === "Single" && o.label === "Single"));
});

test("conditional, required and percent-scale metadata is explicit", () => {
  const byId = Object.fromEntries(inventory.map((item) => [item.fieldId, item]));
  assert.equal(byId.socialSecurityAnnualBenefit.conditional, true);
  assert.equal(byId.rothConversionAnnualAmount.conditional, true);
  assert.equal(byId["timelineOverrides.income"].conditional, true);
  assert.equal(byId.currentAge.required, true);
  assert.equal(byId.currentAge.dataType, "integer");
  assert.equal(byId["timelineOverrides.returnPercent"].excelToInternalMultiplier, 100);
  assert.equal(byId.stateIncomeTaxRate.excelToInternalMultiplier, 1);
});

test("workbook schema contains exactly the inventory and no calculated output", () => {
  const schema = wm.buildPlanningWorkbookSchema();
  assert.deepEqual(Array.from(schema, (entry) => entry.fieldId), ids);
  const calculated = /score|projected|required(Assets)|safeSpending|fundingGap|afterTax|totalAssets|netCashFlow/i;
  schema.forEach((entry) => assert.ok(!calculated.test(entry.fieldId), entry.fieldId));
});

let ExcelJS;
try {
  ExcelJS = require("exceljs");
} catch {
  ExcelJS = null;
}

test("generated workbook covers the inventory, is blank, and keeps sheet order", { skip: !ExcelJS }, async () => {
  const workbook = wm.buildBlankPlanningWorkbook(ExcelJS);
  assert.deepEqual(
    workbook.worksheets.map((sheet) => sheet.name),
    ["Instructions", "Plan Setup", "Assets", "Income & Expenses", "Timeline Overrides"],
  );
  assert.deepEqual(JSON.parse(JSON.stringify(wm.auditWorkbookInputCoverage(workbook))), {
    missing: [],
    unexpected: [],
    duplicates: [],
    wrongSheet: [],
  });
  const reloaded = new ExcelJS.Workbook();
  await reloaded.xlsx.load(await workbook.xlsx.writeBuffer());
  const layout = wm.WORKBOOK_LAYOUT;
  ["Plan Setup", "Assets", "Income & Expenses"].forEach((name) => {
    const sheet = reloaded.getWorksheet(name);
    for (let row = layout.inputHeaderRow + 1; row <= sheet.rowCount; row += 1) {
      assert.equal(sheet.getCell(row, 3).value, null, `${name} row ${row} must be blank`);
    }
  });
  const timeline = reloaded.getWorksheet("Timeline Overrides");
  assert.equal(timeline.getCell(layout.timelineHeaderRow, 2).value, "Return Override %");
  assert.equal(timeline.getCell(layout.timelineHeaderRow + 1, 1).value, 0);
  assert.equal(timeline.getCell(layout.timelineHeaderRow + 121, 1).value, 120);
  assert.ok(reloaded.getWorksheet("Plan Setup").getCell(layout.inputHeaderRow + 1, 3).fill);
});

test("every schema entry is an allowed input classification with no prohibited identifier", () => {
  const schema = wm.buildPlanningWorkbookSchema();
  const prohibited = Array.from(wm.WORKBOOK_PROHIBITED_FIELD_IDS);
  assert.ok(prohibited.includes("socialSecurityEstimatedBenefit"));
  schema.forEach((entry) => {
    assert.ok(wm.WORKBOOK_ALLOWED_CLASSIFICATIONS.includes(entry.classification), entry.fieldId);
    assert.ok(!prohibited.includes(entry.fieldId), entry.fieldId);
    assert.ok(!prohibited.includes(entry.fieldId.split(".").pop()), entry.fieldId);
  });
});

test("blocklist covers every calculate() output identifier", () => {
  const output = Object.keys(wm.calculate(wm.cloneSampleProfile()));
  const prohibited = new Set(Array.from(wm.WORKBOOK_PROHIBITED_FIELD_IDS));
  output.forEach((key) => assert.ok(prohibited.has(key), `${key} missing from blocklist`));
});

test("workbook generation does not read the active plan or calculation results", () => {
  const source = read("workbook.js")
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!/workingProfile/.test(source));
  assert.ok(!/\bcalculate\s*\(|generateRecommendations|buildTimeline|buildPdf/i.test(source));
});

test("calculated-output audit passes on the generated blank workbook", { skip: !ExcelJS }, async () => {
  const workbook = wm.buildBlankPlanningWorkbook(ExcelJS);
  const reloaded = new ExcelJS.Workbook();
  await reloaded.xlsx.load(await workbook.xlsx.writeBuffer());
  [workbook, reloaded].forEach((candidate) => {
    const audit = wm.auditWorkbookForCalculatedOutputs(candidate);
    assert.equal(audit.result, "PASS", JSON.stringify(audit.findings));
    assert.equal(audit.counts.inputFieldsReviewed, inventory.length - 5);
    assert.equal(audit.counts.timelineOverrideTypesReviewed, 5);
    Object.entries(audit.counts)
      .filter(([key]) => !key.endsWith("Reviewed"))
      .forEach(([key, value]) => assert.equal(value, 0, key));
  });
  const text = wm.formatCalculatedOutputAudit(wm.auditWorkbookForCalculatedOutputs(workbook));
  assert.match(text, /Formula cells found: 0/);
  assert.match(text, /Result: PASS/);
  // No formulas, hidden sheets, defined names, or sample data in the serialized package.
  const zip = await reloaded.xlsx.writeBuffer();
  const raw = Buffer.from(zip).toString("latin1");
  assert.ok(!raw.includes("Alex Morgan"));
  assert.equal(reloaded.worksheets.every((sheet) => sheet.state === "visible"), true);
  assert.equal(reloaded.definedNames.model.length, 0);
});

test("calculated-output audit detects planted outputs", { skip: !ExcelJS }, () => {
  const plant = (mutate) => {
    const workbook = wm.buildBlankPlanningWorkbook(ExcelJS);
    mutate(workbook);
    return wm.auditWorkbookForCalculatedOutputs(workbook);
  };
  const failing = [
    (w) => { w.getWorksheet("Assets").getCell("C5").value = { formula: "SUM(C4:C4)" }; },
    (w) => { w.getWorksheet("Plan Setup").getCell("C4").value = "Alex Morgan"; },
    (w) => { w.getWorksheet("Assets").getCell("C4").value = 1000; },
    (w) => { w.addWorksheet("Hidden", { state: "veryHidden" }); },
    (w) => { w.getWorksheet("Assets").getCell("F10").value = "totalAssets"; },
    (w) => { w.getWorksheet("Timeline Overrides").getCell(6, 8).value = "portfolioBalance"; },
    (w) => { w.getWorksheet("Timeline Overrides").getCell(7, 8).value = "Projected Balance"; },
    (w) => { w.getWorksheet("Timeline Overrides").getCell("B10").value = 0.05; },
    (w) => { w.getWorksheet("Plan Setup").getCell("D4").note = "Readiness 80"; },
    (w) => { w.definedNames.add("Plan Setup!$C$4", "Score"); },
  ];
  failing.forEach((mutate, index) => assert.equal(plant(mutate).result, "FAIL", `case ${index}`));
});
