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
const html = read("index.html");

function fakeElement(id) {
  return {
    id, hidden: false, disabled: false, textContent: "", attrs: {}, clicked: 0, focused: 0, removed: 0,
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k]; },
    focus() { this.focused += 1; },
    click() { this.clicked += 1; if (this.onClick) this.onClick(); },
    remove() { this.removed += 1; },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    listeners: {},
  };
}

function setup() {
  const elements = {};
  const get = (id) => (elements[id] ||= fakeElement(id));
  ["export-current-plan", "plan-actions-message", "plan-actions-button", "workbook-import-status", "plan-actions-menu"].forEach(get);
  elements["export-current-plan"].textContent = "Export Current Plan";
  const anchors = [];
  const revoked = [];
  const blobs = [];
  const logs = [];
  const timers = [];
  const sandbox = {
    console: { ...console, info() {}, error: (...a) => logs.push(a) },
    Math, Number, Intl, Object, Array, JSON, Date, Set, Map, WeakMap, Uint8Array, Promise, Error, ExcelJS,
    document: {
      querySelector: (sel) => get(sel.slice(1)),
      createElement: () => { const a = fakeElement("a"); anchors.push(a); return a; },
      body: { append() {} },
      listeners: {},
      addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    },
    URL: { createObjectURL: (b) => { blobs.push(b); return "blob:x"; }, revokeObjectURL: (u) => revoked.push(u) },
    Blob: class { constructor(parts, opts) { this.parts = parts; this.type = opts.type; } },
    setTimeout: (fn) => { timers.push(fn); return 1; },
  };
  sandbox.PlanSetupValidation = require("../validation.js");
  vm.createContext(sandbox);
  vm.runInContext(
    `${["data.js", "validation.js", "app.js", "workbook.js", "importValidation.js", "importPreview.js", "importService.js", "workbookImport.js", "planExport.js"].map(read).join("\n")}
     var __x = { exportCurrentPlanFromMenu, updateCurrentPlanExportAvailability, currentPlanWorkbookFilename, workbookDateStamp,
       downloadBlankPlanningWorkbook, setProfile: (p) => { workingProfile = p; }, getProfile: () => workingProfile,
       setValid: (v) => { currentValidationState = { blockingErrors: [], warnings: [], isValid: v }; },
       spy: (name, fn) => { const orig = globalThis[name]; globalThis[name] = (...a) => fn(orig, ...a); },
       bindPlanActions,
       setPlanExportLogger, cloneSampleProfile, buildExportWorkbook: () => buildExportWorkbook };`,
    sandbox,
  );
  sandbox.__x.setPlanExportLogger(() => {});
  return { x: sandbox.__x, get, anchors, revoked, blobs, logs, timers, sandbox };
}

test("filename uses the local date and no plan data", () => {
  const { x } = setup();
  const date = new Date(2026, 9, 14, 23, 59);
  const name = x.currentPlanWorkbookFilename({ name: "Jane Secret", annualSalary: 123456 }, date);
  assert.equal(name, "WealthMap_Current_Plan_2026-10-14.xlsx");
  assert.match(name, /^[A-Za-z0-9_.-]+$/);
  assert.equal(name.match(/\.xlsx/g).length, 1);
  assert.equal(x.workbookDateStamp(new Date(2026, 0, 5)), "2026-01-05");
});

test("menu contains the three workbook actions as native buttons", () => {
  const labels = {
    "export-current-plan": "Export Current Plan",
    "download-workbook": "Download Blank Planning Workbook",
    "import-workbook": "Import Planning Workbook",
  };
  Object.entries(labels).forEach(([id, label]) => {
    assert.match(html, new RegExp(`<button class="plan-actions-item" id="${id}" type="button">${label}</button>`));
  });
  assert.ok(html.indexOf('id="export-current-plan"') < html.indexOf('id="download-workbook"'));
  assert.match(html, /id="workbook-import-status" role="status" aria-live="polite"/);
});

test("export reads the profile at click time, downloads once, and cleans up", needsExcel, async () => {
  const env = setup();
  const profile = env.x.cloneSampleProfile();
  env.x.setProfile(profile);
  const changed = env.x.cloneSampleProfile();
  changed.currentAge = 52;
  env.x.setProfile(changed);
  let buildCalls = 0;
  env.x.spy("buildPlanExportModel", (orig, p) => { buildCalls += 1; assert.equal(p.currentAge, 52); return orig(p); });
  await env.x.exportCurrentPlanFromMenu();
  assert.equal(buildCalls, 1);
  assert.equal(env.blobs.length, 1);
  assert.equal(env.blobs[0].type, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.equal(env.anchors.length, 1);
  assert.match(env.anchors[0].download, /^WealthMap_Current_Plan_\d{4}-\d{2}-\d{2}\.xlsx$/);
  assert.equal(env.anchors[0].clicked, 1);
  assert.equal(env.anchors[0].removed, 1);
  env.timers.forEach((fn) => fn());
  assert.deepEqual(env.revoked, ["blob:x"]);
  assert.equal(env.get("plan-actions-menu").hidden, true);
  assert.equal(env.get("workbook-import-status").hidden, false);
  assert.equal(env.get("workbook-import-status").textContent, "Current plan Excel download started.");
  assert.equal(env.get("plan-actions-button").focused, 1);
  const button = env.get("export-current-plan");
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "Export Current Plan");
  assert.equal(button.attrs["aria-busy"], "false");
});

test("busy state blocks a second export and is restored afterwards", needsExcel, async () => {
  const env = setup();
  env.x.setProfile(env.x.cloneSampleProfile());
  env.x.setValid(true);
  const button = env.get("export-current-plan");
  const first = env.x.exportCurrentPlanFromMenu();
  assert.equal(button.disabled, true);
  assert.equal(button.attrs["aria-busy"], "true");
  assert.equal(button.textContent, "Exporting...");
  await env.x.exportCurrentPlanFromMenu();
  await first;
  assert.equal(env.anchors.length, 1);
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "Export Current Plan");
});

test("failures show a safe message, trigger no download, restore the button, and allow retry", needsExcel, async () => {
  const secret = "Secret Name 987654";
  const cases = {
    model: (env) => env.x.spy("buildPlanExportModel", () => { throw new Error(secret); }),
    build: (env) => env.x.spy("buildExportWorkbook", () => { throw new Error(secret); }),
    population: (env) => env.x.spy("populateWorkbookInputs", (orig, wb) => ({ populatedFieldIds: [], blankFieldIds: [], errors: [{ code: "UNKNOWN_EXPORT_FIELD", fieldId: "x" }] })),
    serialize: (env) => env.x.spy("buildExportWorkbook", (orig, m) => { const wb = orig(m); wb.xlsx.writeBuffer = async () => { throw new Error(secret); }; return wb; }),
    download: (env) => { env.sandbox.URL.createObjectURL = () => { throw new Error(secret); }; },
  };
  for (const [name, arrange] of Object.entries(cases)) {
    const env = setup();
    const profile = env.x.cloneSampleProfile();
    profile.name = secret;
    env.x.setProfile(profile);
    env.x.setValid(true);
    arrange(env);
    await env.x.exportCurrentPlanFromMenu();
    const message = env.get("plan-actions-message");
    assert.equal(message.hidden, false, name);
    const expected = ["build", "population"].includes(name)
      ? "WealthMap could not prepare the Excel workbook. Please try again."
      : "Current plan export failed. Please review your plan and try again.";
    assert.equal(message.textContent, expected, name);
    assert.equal(env.get("plan-actions-menu").hidden, false, name);
    assert.equal(env.get("workbook-import-status").textContent, "", name);
    assert.ok(!JSON.stringify(env.logs).includes(secret), name);
    assert.ok(!JSON.stringify(env.logs).includes("987654"), name);
    assert.equal(env.get("export-current-plan").disabled, false, name);
    assert.equal(env.get("export-current-plan").textContent, "Export Current Plan", name);
    assert.equal(env.get("export-current-plan").focused, 1, name);
    assert.ok(env.anchors.every((a) => a.clicked === 0), name);
    assert.equal(env.logs.length, 1, name);
  }
});

test("missing workbook library gives the unavailable message", async () => {
  const env = setup();
  env.x.setProfile(env.x.cloneSampleProfile());
  env.x.setValid(true);
  delete env.sandbox.ExcelJS;
  await env.x.exportCurrentPlanFromMenu();
  assert.match(env.get("plan-actions-message").textContent, /^Excel export is unavailable right now/);
  assert.equal(env.anchors.length, 0);
});

test("invalid plan keeps Export Current Plan available so validation can explain the issues", () => {
  const env = setup();
  env.x.setValid(false);
  env.x.updateCurrentPlanExportAvailability();
  const button = env.get("export-current-plan");
  assert.equal(button.disabled, false);
  assert.equal(button.attrs["aria-disabled"], "false");
});

test("blank workbook download keeps its filename and never reads the plan", needsExcel, async () => {
  const env = setup();
  let modelCalls = 0;
  env.x.spy("buildPlanExportModel", (orig, ...a) => { modelCalls += 1; return orig(...a); });
  await env.x.downloadBlankPlanningWorkbook();
  assert.equal(env.anchors[0].download, "WealthMap_Planning_Workbook.xlsx");
  assert.equal(env.anchors[0].clicked, 1);
  assert.equal(env.anchors[0].removed, 1);
  assert.equal(modelCalls, 0);
});

test("Escape still closes the menu and the export item is bound as a click action", () => {
  const env = setup();
  env.x.bindPlanActions();
  env.get("plan-actions-menu").hidden = false;
  env.sandbox.document.listeners.keydown.forEach((fn) => fn({ key: "Escape" }));
  assert.equal(env.get("plan-actions-menu").hidden, true);
  assert.equal(env.get("plan-actions-button").focused, 1);
  assert.equal(env.get("export-current-plan").listeners.click.length, 1);
  assert.equal(env.get("export-current-plan").disabled, false);
});
