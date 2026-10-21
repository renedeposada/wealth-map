// Round-trip harness: drives the real export and import code through the workbook byte boundary.
//   profile -> export model -> populated workbook -> serialized bytes -> parsed workbook ->
//   structural validation -> import candidate -> import validation -> reconstructed profile -> comparison
// Nothing here re-implements export, import, schema or comparison logic; it only wires the application
// functions together. It uses no DOM, never downloads, and never logs or prints plan values.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

let ExcelJS;
try {
  ExcelJS = require("exceljs");
} catch {
  ExcelJS = null;
}
const needsExcel = { skip: !ExcelJS };
const root = path.join(__dirname, "..", "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));

const APP_FILES = [
  "data.js", "validation.js", "app.js", "workbook.js", "importValidation.js", "importPreview.js",
  "importService.js", "workbookImport.js", "planExport.js", "roundTripValidation.js",
];

function loadRoundTripApp() {
  const sandbox = {
    console: { ...console, info() {} }, Math, Number, Intl, Object, Array, JSON, Date, Set, Map, WeakMap, Uint8Array, Promise, Error, ExcelJS,
  };
  sandbox.PlanSetupValidation = require("../../validation.js");
  vm.createContext(sandbox);
  vm.runInContext(
    `${APP_FILES.map(read).join("\n")}
     var __app = { cloneSampleProfile, buildPlanExportModel, validateCurrentPlanForExport, buildExportWorkbook,
       buildSupportedInputInventory, buildPlanningWorkbookSchema, parsePlanningWorkbook, validatePlanningWorkbookStructure,
       buildImportCandidate, validateImportCandidate, validateExportImportRoundTrip, compareProfiles, compareTimelineOverrides,
       auditWorkbookForCalculatedOutputs, buildWorkbookFieldLocationIndex, buildWorkbookTimelineOverrideMap,
       workbookTimelineRowNumber, workbookFieldIdIsProhibited, TIMELINE_OVERRIDE_FIELDS, WORKBOOK_SHEETS, WORKBOOK_LAYOUT,
       WORKBOOK_TEMPLATE_VERSION, WORKBOOK_SCHEMA_VERSION, WORKBOOK_IDENTITY_LABELS, WORKBOOK_PROHIBITED_FIELDS,
       ROUND_TRIP_TOLERANCE, populateWorkbookInputs, populateWorkbookTimelineOverrides, validateWorkbookPopulationResult,
       planExportFieldLayout, createSafeExportError, exportUserMessage, logExportFailure, setPlanExportLogger,
       currentPlanWorkbookFilename, exportValidationIssueMessage, EXPORT_FAILURE_CODES, EXPORT_USER_MESSAGES,
       getWorkbookPopulationResult, getWorkbookTimelinePopulationResult };`,
    sandbox,
    { filename: "round-trip-regression.js" },
  );
  return sandbox.__app;
}

const app = loadRoundTripApp();

// Value-free description of a failure; only codes, field ids, ages, sections and locations.
function safeValidationErrors(structuralValidation, importValidation) {
  const errors = [];
  if (structuralValidation && !structuralValidation.isValid) {
    structuralValidation.errors.forEach((e) =>
      errors.push({ stage: "structure", code: e.code, worksheet: e.worksheet, row: e.row, column: e.column, fieldId: e.fieldId }),
    );
  }
  if (importValidation && !importValidation.valid) {
    importValidation.errors.forEach((e) => errors.push({ stage: "values", section: e.section, field: e.field, fieldId: e.fieldId }));
  }
  return plain(errors);
}

// Compares the original and reconstructed supported inputs with the shared Step 7 comparison helpers.
function compareRoundTrip(original, imported) {
  const differences = [...app.compareProfiles(original, imported), ...app.compareTimelineOverrides(original, imported)];
  return plain({ success: differences.length === 0, validationErrors: [], differences });
}

// options.mutateModel(model) / options.mutateWorkbook(workbook) run before serialization, so a
// mutation travels through the real byte boundary. Stops before comparison when validation fails.
async function roundTripProfile(profile, options = {}) {
  const exportModel = app.buildPlanExportModel(profile);
  if (options.mutateModel) options.mutateModel(exportModel);
  const exportValidation = app.validateCurrentPlanForExport(exportModel);
  const workbook = app.buildExportWorkbook(exportModel);
  if (options.mutateWorkbook) options.mutateWorkbook(workbook);
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const parsed = await app.parsePlanningWorkbook(buffer);
  const structuralValidation = app.validatePlanningWorkbookStructure(parsed, { name: "round-trip.xlsx", size: buffer.length });
  const result = {
    profile, exportModel, exportValidation, workbook, buffer, parsed, structuralValidation,
    candidate: null, importValidation: null, comparison: null,
    // Re-runs the comparison, e.g. after a test deliberately mutates candidate.profile.
    recompare() {
      this.comparison = compareRoundTrip(this.profile, this.candidate.profile);
      return this.comparison;
    },
  };
  if (!structuralValidation.isValid) {
    result.comparison = plain({ success: false, validationErrors: safeValidationErrors(structuralValidation), differences: [] });
    return result;
  }
  result.candidate = app.buildImportCandidate(parsed);
  result.importValidation = app.validateImportCandidate(result.candidate);
  result.candidate.valid = result.importValidation.valid;
  if (!result.importValidation.valid) {
    result.comparison = plain({ success: false, validationErrors: safeValidationErrors(null, result.importValidation), differences: [] });
    return result;
  }
  result.recompare();
  return result;
}

// Safe assertion message: metadata only, never values.
function diagnostics(result) {
  const parts = [];
  if (result.exportValidation && !result.exportValidation.isValid) {
    parts.push(`export:${result.exportValidation.errors.map((e) => `${e.code}@${e.fieldId}`).join(",")}`);
  }
  if (result.comparison) {
    parts.push(...result.comparison.validationErrors.map((e) => `${e.stage}:${e.code || e.section}@${e.fieldId || e.field || ""}`));
    parts.push(...result.comparison.differences.map((d) => `${d.type}@${d.fieldId}`));
  }
  return parts.join(" | ") || "ok";
}

module.exports = { ExcelJS, needsExcel, app, plain, roundTripProfile, compareRoundTrip, diagnostics, safeValidationErrors };
