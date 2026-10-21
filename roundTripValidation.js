// Developer-quality export -> import round-trip validation. Pure and DOM-free: it never runs in the
// user-facing export workflow, never mutates application state, and never logs financial values.
// Only supported editable inputs (buildSupportedInputInventory) are compared, never calculated outputs.

const ROUND_TRIP_TOLERANCE = 0.000001;

function pathGet(object, fieldId) {
  return importPathGet(object, fieldId);
}

// Normalizes a value so blank-like inputs and numeric noise compare consistently.
function stableRoundTripValue(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value.trim() === "" ? null : value.trim();
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  return value;
}

function roundTripValuesEqual(a, b) {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < ROUND_TRIP_TOLERANCE;
  return a === b;
}

function compareRoundTripValue(fieldId, originalValue, importedValue) {
  const original = stableRoundTripValue(originalValue);
  const imported = stableRoundTripValue(importedValue);
  // Blank optional inputs intentionally fall back to defaults on import, so they are not a loss of data.
  if (original === null) return null;
  if (imported === null) return { type: "missing", fieldId };
  if (roundTripValuesEqual(original, imported)) return null;
  return { type: "changed", fieldId, original, imported };
}

function compareProfiles(original, imported, inventory = buildSupportedInputInventory()) {
  return inventory
    .filter((item) => item.worksheet !== WORKBOOK_SHEETS.timeline)
    .map((item) =>
      compareRoundTripValue(item.fieldId, pathGet(original, item.fieldId), pathGet(imported, item.fieldId)),
    )
    .filter(Boolean);
}

// Uses the export's own override filter so values the Timeline ignores are not expected to survive.
function roundTripOverrideMap(profile) {
  const map = new Map();
  planExportOverrides(profile).forEach((record) => {
    map.set(`timelineOverrides.${record.age}.${record.field}`, record.value);
  });
  return map;
}

function compareTimelineOverrides(original, imported) {
  const expected = roundTripOverrideMap(original);
  const actual = roundTripOverrideMap(imported);
  const differences = [];
  expected.forEach((value, fieldId) => {
    const difference = compareRoundTripValue(fieldId, value, actual.get(fieldId));
    if (difference) differences.push(difference);
  });
  actual.forEach((value, fieldId) => {
    if (!expected.has(fieldId)) differences.push({ type: "unexpected", fieldId, imported: stableRoundTripValue(value) });
  });
  return differences;
}

function roundTripValidationError(stage, issue = {}) {
  const error = { stage, message: issue.message || "Validation failed." };
  ["code", "section", "field"].forEach((key) => {
    if (issue[key]) error[key] = issue[key];
  });
  return error;
}

// options.transformImported(profile) is a test hook that may alter the imported profile before comparison.
function validateExportImportRoundTrip(profile, options = {}) {
  const failure = (validationErrors) => ({ success: false, validationErrors, differences: [] });
  let candidate;
  try {
    const exportModel = buildPlanExportModel(profile);
    const workbook = buildExportWorkbook(exportModel);
    const structural = validatePlanningWorkbookStructure(workbook);
    if (!structural.isValid) return failure(structural.errors.map((issue) => roundTripValidationError("structure", issue)));
    candidate = buildImportCandidate(workbook);
    const validation = validateImportCandidate(candidate);
    candidate.valid = validation.valid;
    if (candidate.valid !== true) return failure(validation.errors.map((issue) => roundTripValidationError("values", issue)));
  } catch {
    return failure([{ stage: "pipeline", message: "The export or import pipeline failed." }]);
  }
  const imported = typeof options.transformImported === "function"
    ? options.transformImported(candidate.profile) || candidate.profile
    : candidate.profile;
  const differences = [...compareProfiles(profile, imported), ...compareTimelineOverrides(profile, imported)];
  return { success: differences.length === 0, validationErrors: [], differences };
}
