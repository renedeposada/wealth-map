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
const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

function fakeElement(id) {
  return {
    id, hidden: false, disabled: false, textContent: "", attrs: {}, children: [], focused: 0, clicked: 0, listeners: {},
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k]; },
    focus() { this.focused += 1; },
    click() { this.clicked += 1; },
    remove() {},
    append(...c) { this.children.push(...c); },
    replaceChildren(...c) { this.children = c; },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    all() { return [this, ...this.children.flatMap((c) => (c.all ? c.all() : []))]; },
  };
}

function setup() {
  const elements = {};
  const get = (id) => (elements[id] ||= fakeElement(id));
  ["export-current-plan", "plan-actions-message", "plan-actions-button", "workbook-import-status", "plan-actions-menu", "export-validation-summary"].forEach(get);
  const anchors = [];
  const blobs = [];
  const logs = [];
  const sandbox = {
    console: { ...console, info() {}, error: (...a) => logs.push(a) },
    Math, Number, Intl, Object, Array, JSON, Date, Set, Map, WeakMap, Uint8Array, Promise, Error, ExcelJS,
    document: {
      querySelector: (sel) => get(sel.slice(1)),
      createElement: (tag) => { const e = fakeElement(tag); if (tag === "a") anchors.push(e); return e; },
      body: { append() {} },
      addEventListener() {},
    },
    URL: { createObjectURL: (b) => { blobs.push(b); return "blob:x"; }, revokeObjectURL() {} },
    Blob: class { constructor(parts, opts) { this.parts = parts; this.type = opts.type; } },
    setTimeout: () => 1,
  };
  sandbox.PlanSetupValidation = require("../validation.js");
  vm.createContext(sandbox);
  vm.runInContext(
    `${["data.js", "validation.js", "app.js", "workbook.js", "importValidation.js", "importPreview.js", "importService.js", "workbookImport.js", "planExport.js"].map(read).join("\n")}
     var __x = { exportCurrentPlanFromMenu, validateCurrentPlanForExport, buildPlanExportModel, exportValidationIssueMessage,
       validateWorkbookPopulationResult, downloadCurrentPlanWorkbook, cloneSampleProfile, setPlanExportLogger,
       setProfile: (p) => { workingProfile = p; }, setValid: (v) => { currentValidationState = { blockingErrors: [], warnings: [], isValid: v }; },
       spy: (name, fn) => { const orig = globalThis[name]; globalThis[name] = (...a) => fn(orig, ...a); } };`,
    sandbox,
  );
  sandbox.__x.setPlanExportLogger(() => {});
  sandbox.__x.setProfile(sandbox.__x.cloneSampleProfile());
  return { x: sandbox.__x, get, anchors, blobs, logs };
}

const validModel = (x) => x.buildPlanExportModel(x.cloneSampleProfile());
const codes = (r) => r.errors.map((e) => e.code);

test("sample plan model is valid and counts are reported", () => {
  const { x } = setup();
  const result = x.validateCurrentPlanForExport(validModel(x));
  assert.equal(result.isValid, true);
  assert.equal(result.errors.length, 0);
  assert.ok(result.summary.standardFieldCount > 20);
});

test("structure and version errors", () => {
  const { x } = setup();
  assert.equal(codes(x.validateCurrentPlanForExport(null)).join(), "missingModel");
  const m = validModel(x);
  delete m.assets;
  m.extra = 1;
  m.modelVersion = "9";
  const r = x.validateCurrentPlanForExport(m);
  assert.ok(["missingSection", "unexpectedModelKey", "unsupportedModelVersion"].every((c) => codes(r).includes(c)));
  assert.equal(r.isValid, false);
});

test("field support, required, type, range, select and cross-field errors", () => {
  const { x } = setup();
  const m = validModel(x);
  m.profile.totalNetWorth = 5;
  m.profile.bogusField = 1;
  m.profile.currentAge = "abc";
  m.profile.lifeExpectancy = null;
  m.assumptions.inflationRate = 7;
  m.profile.targetRetirementAge = m.profile.currentAge === "abc" ? 70 : 70;
  m.incomeAndExpenses.annualSalary = -5;
  m.incomeAndExpenses.returnPercent = 1;
  const r = x.validateCurrentPlanForExport(m);
  const has = (code, fieldId) => r.errors.some((e) => e.code === code && e.fieldId === fieldId);
  assert.ok(has("unknownField", "bogusField"));
  assert.ok(has("notFiniteNumber", "currentAge"));
  assert.ok(has("missingRequired", "lifeExpectancy"));
  assert.ok(has("percentOutOfRange", "inflationRate"));
  assert.ok(has("belowMinimum", "annualSalary"));
  assert.ok(has("timelineFieldInStandardSection", "returnPercent"));
  r.errors.forEach((e) => assert.deepEqual(Object.keys(e).sort().filter((k) => k === "value"), []));
});

test("zero is not missing and cross-field rules are reported", () => {
  const { x } = setup();
  const m = validModel(x);
  m.incomeAndExpenses.annualSalary = 0;
  assert.equal(x.validateCurrentPlanForExport(m).isValid, true);
  m.profile.targetRetirementAge = m.profile.currentAge - 1;
  const r = x.validateCurrentPlanForExport(m);
  assert.ok(r.errors.some((e) => e.code === "crossFieldRule" && e.fieldId === "targetRetirementAge" && e.page === "profile"));
});

test("select values must match allowed values", () => {
  const { x } = setup();
  const m = validModel(x);
  const key = Object.keys(m.profile).find((k) => k === "filingStatus") || "filingStatus";
  assert.ok(key in m.profile || key in m.assumptions);
  (key in m.profile ? m.profile : m.assumptions)[key] = "not-a-choice";
  assert.ok(codes(x.validateCurrentPlanForExport(m)).includes("invalidSelection"));
});

test("timeline override errors and duplicates, with pages", () => {
  const { x } = setup();
  const m = validModel(x);
  m.timelineOverrides = [
    { age: 40, field: "returnPercent", value: 5 },
    { age: 40, field: "returnPercent", value: 6 },
    { age: 150, field: "returnPercent", value: 5 },
    { age: 41.5, field: "returnPercent", value: 5 },
    { age: 42, field: "nope", value: 5 },
    { age: 43, field: "returnPercent", value: NaN },
    null,
  ];
  const r = x.validateCurrentPlanForExport(m);
  ["duplicateOverride", "overrideAgeOutOfRange", "invalidOverrideAge", "unsupportedOverrideField", "invalidOverrideValue", "invalidOverrideRecord"].forEach((c) =>
    assert.ok(codes(r).includes(c), c),
  );
  assert.ok(r.errors.every((e) => e.page === "timeline"));
});

test("messages use labels and never contain plan values", () => {
  const { x } = setup();
  const m = validModel(x);
  m.incomeAndExpenses.annualSalary = -987654;
  const r = x.validateCurrentPlanForExport(m);
  const text = JSON.stringify(r) + r.errors.map((e) => x.exportValidationIssueMessage(e)).join(" ");
  assert.ok(!text.includes("987654"));
  assert.match(x.exportValidationIssueMessage(r.errors[0]), /Annual salary|salary/i);
});

test("population result validation throws a safe error", () => {
  const { x } = setup();
  assert.throws(() => x.validateWorkbookPopulationResult({}), (e) => e.code === "INVALID_WORKBOOK_BUILD_RESULT");
});

test("invalid plan: summary shown, no workbook built, no download, button restored", { skip: !ExcelJS }, async () => {
  const env = setup();
  const profile = env.x.cloneSampleProfile();
  profile.targetRetirementAge = profile.currentAge - 1;
  env.x.setProfile(profile);
  let built = 0;
  env.x.spy("buildExportWorkbook", (orig, ...a) => { built += 1; return orig(...a); });
  await env.x.exportCurrentPlanFromMenu();
  assert.equal(built, 0);
  assert.equal(env.blobs.length, 0);
  assert.equal(env.anchors.length, 0);
  const summary = env.get("export-validation-summary");
  assert.equal(summary.hidden, false);
  const heading = summary.children[0];
  assert.equal(heading.textContent, "Review your plan before exporting.");
  assert.equal(heading.focused, 1);
  const button = env.get("export-current-plan");
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "Export Current Plan");
});

test("summary lists at most 10 issues", { skip: !ExcelJS }, async () => {
  const env = setup();
  const profile = env.x.cloneSampleProfile();
  Object.keys(profile).forEach((k) => { if (typeof profile[k] === "number") profile[k] = -1; });
  env.x.setProfile(profile);
  await env.x.exportCurrentPlanFromMenu();
  const list = env.get("export-validation-summary").children.find((c) => c.id === "ul");
  assert.ok(list.children.length <= 10);
});

test("valid plan still downloads", { skip: !ExcelJS }, async () => {
  const env = setup();
  await env.x.exportCurrentPlanFromMenu();
  assert.equal(env.anchors[0].download.startsWith("WealthMap_Current_Plan_"), true);
  assert.equal(env.get("export-validation-summary").hidden, true);
});
