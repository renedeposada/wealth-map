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

// ---- Pre-export validation (Step 6) ----
// validateCurrentPlanForExport() is the single gate before a workbook is built. It reports value-free
// issues { severity, code, fieldId, section, page, messageKey, age? }; plan values never appear in
// issues, messages, or logs. Cross-field rules are delegated to PlanSetupValidation (validation.js).

const EXPORT_SUPPORTED_MODEL_VERSIONS = Object.freeze([PLAN_EXPORT_MODEL_VERSION]);
const EXPORT_MODEL_KEYS = Object.freeze([
  "modelVersion",
  ...PLAN_EXPORT_REQUIRED_SECTIONS,
  "timelineOverrides",
]);
const EXPORT_SECTION_PAGES = Object.freeze({
  profile: "profile",
  assumptions: "profile",
  incomeAndExpenses: "cashflow",
  assets: "assets",
  timelineOverrides: "timeline",
  model: "profile",
});
const EXPORT_PAGE_ORDER = Object.freeze(["profile", "assets", "cashflow", "timeline"]);
const EXPORT_PAGE_LABELS = Object.freeze({
  profile: "Plan Setup",
  assets: "Assets",
  cashflow: "Income & Expenses",
  timeline: "Wealth Timeline",
});

function exportIssue(severity, code, section, fieldId, extra = {}) {
  const issue = { severity, code, fieldId: fieldId || null, section, page: EXPORT_SECTION_PAGES[section] || "profile", messageKey: code };
  if (extra.age !== undefined) issue.age = extra.age;
  return issue;
}

function validateCurrentPlanForExport(exportModel, options = {}) {
  const issues = [];
  const add = (code, section, fieldId, extra) => issues.push(exportIssue("error", code, section, fieldId, extra));
  const finish = () => {
    const seen = new Set();
    const unique = issues.filter((issue) => {
      const key = [issue.severity, issue.code, issue.section, issue.fieldId, issue.age].join(":");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const order = options.fieldOrder || [];
    const rank = (issue) => (order.indexOf(issue.fieldId) === -1 ? order.length : order.indexOf(issue.fieldId));
    unique.sort(
      (a, b) =>
        (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1) ||
        EXPORT_PAGE_ORDER.indexOf(a.page) - EXPORT_PAGE_ORDER.indexOf(b.page) ||
        rank(a) - rank(b) ||
        (a.age ?? -1) - (b.age ?? -1) ||
        String(a.code).localeCompare(String(b.code)),
    );
    const errors = unique.filter((issue) => issue.severity === "error");
    const warnings = unique.filter((issue) => issue.severity === "warning");
    const standardFieldCount = model_isObject(exportModel)
      ? PLAN_EXPORT_REQUIRED_SECTIONS.reduce((n, s) => n + (model_isObject(exportModel[s]) ? Object.keys(exportModel[s]).length : 0), 0)
      : 0;
    return {
      isValid: errors.length === 0,
      errors,
      warnings,
      summary: {
        errorCount: errors.length,
        warningCount: warnings.length,
        standardFieldCount,
        timelineOverrideCount: model_isObject(exportModel) && Array.isArray(exportModel.timelineOverrides) ? exportModel.timelineOverrides.length : 0,
      },
    };
  };
  function model_isObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  if (!model_isObject(exportModel)) {
    add("missingModel", "model");
    return finish();
  }
  Object.keys(exportModel).forEach((key) => {
    if (!EXPORT_MODEL_KEYS.includes(key)) add("unexpectedModelKey", "model");
  });
  if (exportModel.modelVersion === undefined || exportModel.modelVersion === null) add("missingModelVersion", "model");
  else if (!EXPORT_SUPPORTED_MODEL_VERSIONS.includes(exportModel.modelVersion)) add("unsupportedModelVersion", "model");

  const schema = (options.schema || buildPlanningWorkbookSchema()).filter((item) => item.worksheet !== WORKBOOK_SHEETS.timeline);
  const byId = new Map(schema.map((item) => [item.fieldId, item]));
  const sheetPage = { [WORKBOOK_SHEETS.planSetup]: "profile", [WORKBOOK_SHEETS.assets]: "assets", [WORKBOOK_SHEETS.incomeExpenses]: "cashflow" };
  const timelineIds = new Set(TIMELINE_OVERRIDE_FIELDS.map((entry) => entry.field));
  const seenIds = new Map();
  const failedIds = new Set();
  const fail = (code, section, fieldId) => {
    failedIds.add(fieldId);
    add(code, section, fieldId);
  };

  PLAN_EXPORT_REQUIRED_SECTIONS.forEach((section) => {
    const values = exportModel[section];
    if (!model_isObject(values)) return add("missingSection", section);
    Object.keys(values).forEach((fieldId) => {
      if (seenIds.has(fieldId)) fail("duplicateField", section, fieldId);
      seenIds.set(fieldId, section);
      if (workbookFieldIdIsProhibited(fieldId)) return fail("prohibitedField", section, fieldId);
      if (timelineIds.has(fieldId)) return fail("timelineFieldInStandardSection", section, fieldId);
      const item = byId.get(fieldId);
      if (!item) return fail("unknownField", section, fieldId);
      if (sheetPage[item.worksheet] !== EXPORT_SECTION_PAGES[section]) return fail("wrongSection", section, fieldId);
      const value = values[fieldId];
      if (value === null || value === undefined || value === "") {
        if (item.required) fail("missingRequired", section, fieldId);
        return;
      }
      if (item.dataType === "select") {
        if (!(item.allowedValues || []).some((entry) => entry.value === value)) fail("invalidSelection", section, fieldId);
      } else if (item.dataType === "text") {
        if (typeof value !== "string") fail("notText", section, fieldId);
      } else if (typeof value !== "number" || !Number.isFinite(value)) {
        fail("notFiniteNumber", section, fieldId);
      } else if (item.dataType === "integer" && !Number.isInteger(value)) {
        fail("notInteger", section, fieldId);
      } else if (value < (item.minimum ?? 0)) {
        fail("belowMinimum", section, fieldId);
      } else if (item.dataType === "percent" && value > 1) {
        fail("percentOutOfRange", section, fieldId);
      }
    });
  });
  REQUIRED_INPUT_IDS.forEach((fieldId) => {
    if (!seenIds.has(fieldId) && PLAN_EXPORT_REQUIRED_SECTIONS.every((s) => model_isObject(exportModel[s]))) {
      const item = byId.get(fieldId);
      add("missingRequired", item ? Object.keys(EXPORT_SECTION_PAGES).find((s) => EXPORT_SECTION_PAGES[s] === sheetPage[item.worksheet]) : "profile", fieldId);
    }
  });

  // Cross-field rules reuse the application's own validator on a profile rebuilt from the model.
  if (PLAN_EXPORT_REQUIRED_SECTIONS.every((s) => model_isObject(exportModel[s])) && typeof PlanSetupValidation !== "undefined") {
    const profile = {};
    PLAN_EXPORT_REQUIRED_SECTIONS.forEach((section) =>
      Object.keys(exportModel[section]).forEach((fieldId) => {
        if (!failedIds.has(fieldId) && !fieldId.startsWith("assets.")) importPathSet(profile, fieldId, exportModel[section][fieldId]);
      }),
    );
    const erroredFields = new Set(issues.map((issue) => issue.fieldId));
    PlanSetupValidation.validatePlanSetup(profile).blockingErrors.forEach((entry) => {
      const item = byId.get(entry.field);
      if (!item || erroredFields.has(entry.field)) return;
      const section = Object.keys(exportModel).find((s) => model_isObject(exportModel[s]) && entry.field in exportModel[s]) || "profile";
      add("crossFieldRule", section, entry.field);
    });
  }

  if (!Array.isArray(exportModel.timelineOverrides)) {
    add("missingSection", "timelineOverrides");
  } else {
    const limits = Object.fromEntries(TIMELINE_OVERRIDE_FIELDS.map((entry) => [entry.field, entry.min]));
    const seen = new Set();
    exportModel.timelineOverrides.forEach((record) => {
      if (!model_isObject(record)) return add("invalidOverrideRecord", "timelineOverrides");
      const field = typeof record.field === "string" ? record.field : null;
      const age = Number.isInteger(record.age) ? record.age : undefined;
      if (age === undefined) return add("invalidOverrideAge", "timelineOverrides", field);
      if (age < WORKBOOK_LAYOUT.timelineMinAge || age > WORKBOOK_LAYOUT.timelineMaxAge) return add("overrideAgeOutOfRange", "timelineOverrides", field, { age });
      if (!field || !(field in limits)) return add("unsupportedOverrideField", "timelineOverrides", field, { age });
      if (typeof record.value !== "number" || !Number.isFinite(record.value)) return add("invalidOverrideValue", "timelineOverrides", field, { age });
      if (record.value < limits[field]) return add("overrideBelowMinimum", "timelineOverrides", field, { age });
      const key = `${age}:${field}`;
      if (seen.has(key)) add("duplicateOverride", "timelineOverrides", field, { age });
      seen.add(key);
    });
  }
  return finish();
}

const EXPORT_ISSUE_TEXT = Object.freeze({
  missingModel: "The plan could not be read.",
  unexpectedModelKey: "The plan contains an unsupported section.",
  missingModelVersion: "The plan data version is missing.",
  unsupportedModelVersion: "The plan data version is not supported.",
  missingSection: "A required part of the plan is missing.",
  duplicateField: "is listed more than once.",
  prohibitedField: "is a calculated value and cannot be exported.",
  timelineFieldInStandardSection: "belongs on the Wealth Timeline, not here.",
  unknownField: "is not a supported workbook field.",
  wrongSection: "is not in the expected place.",
  missingRequired: "is required.",
  invalidSelection: "must be one of the available choices.",
  notText: "must be text.",
  notFiniteNumber: "must be a valid number.",
  notInteger: "must be a whole number.",
  belowMinimum: "is below the allowed minimum.",
  percentOutOfRange: "must be between 0% and 100%.",
  crossFieldRule: "conflicts with other plan settings. Review it on its page.",
  invalidOverrideRecord: "A Wealth Timeline override is not valid.",
  invalidOverrideAge: "A Wealth Timeline override has an invalid age.",
  overrideAgeOutOfRange: "has an override at an age outside the supported range.",
  unsupportedOverrideField: "A Wealth Timeline override uses an unsupported field.",
  invalidOverrideValue: "has an override that is not a valid number.",
  overrideBelowMinimum: "has an override below the allowed minimum.",
  duplicateOverride: "has more than one override for the same age.",
});

// Friendly, value-free message for an issue. Uses the field's label when the field is supported.
function exportValidationIssueMessage(issue) {
  const text = EXPORT_ISSUE_TEXT[issue && issue.messageKey] || "This item needs review.";
  if (!issue || !issue.fieldId || !/^(?:[a-z])/.test(text)) return text;
  const timeline = TIMELINE_OVERRIDE_FIELDS.find((entry) => entry.field === issue.fieldId);
  const item = timeline ? null : buildSupportedInputInventory().find((entry) => entry.fieldId === issue.fieldId);
  const label = timeline ? timeline.label : item ? item.label : "A field";
  const age = issue.age !== undefined ? ` (age ${issue.age})` : "";
  return `${label}${age} ${text}`;
}
