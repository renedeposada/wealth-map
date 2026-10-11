// Plan export model: the single source of truth for every future Excel export of the current plan.
//
// Purpose
//   Current working profile -> buildPlanExportModel() -> PlanExportModel -> workbook generator.
//   It is the reverse of the import path (workbookImport.js) and shares its field inventory, so a
//   value is exported if and only if the workbook template defines a place to import it.
//
// Included (inputs only; field ids are those of buildSupportedInputInventory())
//   profile            Plan Setup personal details
//   assumptions        Projection, tax, retirement-setting and strategy inputs (incl. Social Security
//                      claim age / benefit inputs)
//   incomeAndExpenses  Income, expenses, employer savings, IRA contributions, savings allocation
//   assets             Account balances (real estate stays a separate asset)
//   timelineOverrides  Actual per-age overrides as sorted { age, field, value } records
//
// Excluded: every calculated output (readiness score/status, recommendations, projections, safe
// spending, tax/RMD/NIIT/IRMAA estimates, timeline results, milestones, the estimated Social Security
// benefit, ...). See WORKBOOK_PROHIBITED_FIELDS in workbook.js.
//
// Fidelity: values are copied without coercion (0 stays 0, numbers stay numbers). A missing optional
// value is exported as null (blank). Units are the application's internal units: profile percentages
// are decimals (0.05 = 5%); Timeline returnPercent is in percentage points (5 = 5%). The workbook
// generator applies each field's excelToInternalMultiplier when writing cells.
//
// Depends on (loaded earlier): app.js (inputConfig, TIMELINE_OVERRIDE_FIELDS, timelineOverrideFor,
// workingProfile) and workbook.js (INPUT_GROUPS, ASSET_SHEET_ORDER, ASSET_METADATA helpers,
// buildSupportedInputInventory, workbookFieldIdIsProhibited).

const PLAN_EXPORT_MODEL_VERSION = "1.0";

const PLAN_EXPORT_GROUP_SECTIONS = Object.freeze({
  profile: "profile",
  assumptions: "assumptions",
  basicTax: "assumptions",
  advancedTax: "assumptions",
  strategy: "assumptions",
  income: "incomeAndExpenses",
  expenses: "incomeAndExpenses",
  contributionsEmployer: "incomeAndExpenses",
  contributionsIra: "incomeAndExpenses",
  contributionsAdditional: "incomeAndExpenses",
});
const PLAN_EXPORT_REQUIRED_SECTIONS = Object.freeze([
  "profile",
  "assumptions",
  "incomeAndExpenses",
  "assets",
]);

// Diagnostics: counts only; never balances, income, or other personal financial data.
let planExportLogger = (entry) => console.info("[WealthMap export]", JSON.stringify(entry));
function setPlanExportLogger(logger) {
  planExportLogger = logger;
}
function logPlanExportEvent(entry) {
  try {
    planExportLogger(entry);
  } catch {
    // Logging must never break the export.
  }
}

function planExportIsBlank(value) {
  return value === undefined || value === null || value === "";
}

// Returns the exported input field ids grouped by model section, in workbook order.
function planExportFieldLayout() {
  const config = inputConfig();
  const layout = { profile: [], assumptions: [], incomeAndExpenses: [], assets: [] };
  INPUT_GROUPS.forEach(([group]) => {
    config[group].forEach(([fieldId, , type]) => {
      if (type === "readonly" || READ_ONLY_INPUT_IDS.has(fieldId)) return;
      layout[PLAN_EXPORT_GROUP_SECTIONS[group]].push(fieldId);
    });
  });
  const assetKeys = [
    ...ASSET_SHEET_ORDER.filter((key) => ASSET_METADATA[key]),
    ...Object.keys(ASSET_METADATA).filter((key) => !ASSET_SHEET_ORDER.includes(key)),
  ];
  assetKeys.forEach((key) => layout.assets.push(`assets.${key}`));
  return layout;
}

function planExportOverrides(profile) {
  const stored = profile.timelineOverrides || {};
  const fieldOrder = TIMELINE_OVERRIDE_FIELDS.map((entry) => entry.field);
  const records = [];
  Object.keys(stored).forEach((key) => {
    const age = Number(key);
    if (!Number.isInteger(age)) return;
    // timelineOverrideFor drops values the Timeline itself would ignore, matching import behavior.
    const valid = timelineOverrideFor(profile, age);
    fieldOrder.forEach((field) => {
      if (Object.prototype.hasOwnProperty.call(valid, field)) {
        records.push({ age, field, value: valid[field] });
      }
    });
  });
  return records.sort(
    (a, b) => a.age - b.age || fieldOrder.indexOf(a.field) - fieldOrder.indexOf(b.field),
  );
}

// Builds the input-only export model from a profile (defaults to the current working profile).
// Never mutates or aliases the profile.
function buildPlanExportModel(profile = workingProfile) {
  const layout = planExportFieldLayout();
  const model = { modelVersion: PLAN_EXPORT_MODEL_VERSION };
  let fieldCount = 0;
  Object.keys(layout).forEach((section) => {
    model[section] = {};
    layout[section].forEach((fieldId) => {
      const value = importPathGet(profile, fieldId);
      model[section][fieldId] = planExportIsBlank(value) ? null : value;
      fieldCount += 1;
    });
  });
  model.timelineOverrides = planExportOverrides(profile);
  logPlanExportEvent({
    event: "planExportModelCreated",
    fieldCount,
    timelineOverrideCount: model.timelineOverrides.length,
  });
  return model;
}

// Lightweight export-readiness check. Returns { valid, errors } where each error is
// { code, path } only (no values, so nothing financial is ever reported or logged).
function validatePlanExportModel(model) {
  const errors = [];
  const add = (code, path) => errors.push({ code, path });
  if (!model || typeof model !== "object") return { valid: false, errors: [{ code: "missingModel", path: "" }] };

  const dataTypes = new Map(buildSupportedInputInventory().map((item) => [item.fieldId, item]));
  const required = new Set(REQUIRED_INPUT_IDS);

  PLAN_EXPORT_REQUIRED_SECTIONS.forEach((section) => {
    const values = model[section];
    if (!values || typeof values !== "object") return add("missingSection", section);
    Object.keys(values).forEach((fieldId) => {
      const path = `${section}.${fieldId}`;
      if (workbookFieldIdIsProhibited(fieldId)) return add("calculatedOutput", path);
      const item = dataTypes.get(fieldId);
      if (!item) return add("unknownField", path);
      const value = values[fieldId];
      if (value === null) return required.has(fieldId) ? add("missingRequired", path) : undefined;
      if (["currency", "percent", "integer", "number"].includes(item.dataType)) {
        if (typeof value !== "number" || !Number.isFinite(value)) return add("notFiniteNumber", path);
        if (item.dataType === "integer" && !Number.isInteger(value)) add("notInteger", path);
        if (item.dataType === "percent" && (value < -1 || value > 1)) add("percentOutOfRange", path);
      } else if (typeof value !== "string") {
        add("notText", path);
      }
    });
  });
  required.forEach((fieldId) => {
    const present = PLAN_EXPORT_REQUIRED_SECTIONS.some((s) => model[s] && fieldId in model[s]);
    if (!present && PLAN_EXPORT_REQUIRED_SECTIONS.every((s) => model[s])) add("missingRequired", fieldId);
  });

  if (!Array.isArray(model.timelineOverrides)) {
    add("missingSection", "timelineOverrides");
  } else {
    const limits = Object.fromEntries(TIMELINE_OVERRIDE_FIELDS.map((entry) => [entry.field, entry.min]));
    const seen = new Set();
    model.timelineOverrides.forEach((record, index) => {
      const path = `timelineOverrides[${index}]`;
      const key = record && `${record.age}:${record.field}`;
      if (!record || !Number.isInteger(record.age) || !(record.field in limits)) return add("invalidOverride", path);
      if (typeof record.value !== "number" || !Number.isFinite(record.value) || record.value < limits[record.field]) {
        return add("invalidOverride", path);
      }
      if (seen.has(key)) add("duplicateOverride", path);
      seen.add(key);
    });
  }
  return { valid: errors.length === 0, errors };
}
