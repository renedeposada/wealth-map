// Import service: applies a validated, confirmed import as one atomic transaction.
//
//   1. capture a backup of the current plan
//   2. verify the new plan produces a valid projection (dry run; no application state is touched)
//   3. replace the whole plan and run the application's single render/calculation path
//   4. verify the live outputs exist
//   5. commit, or restore the backup if anything failed
//
// There is no second calculation path: the dry run and the live refresh both call the same
// calculate(), buildTimelineRows() and recommendations() used for manual edits and the sample plan.
// Depends on app.js globals (replaceWorkingProfile, currentWorkingProfile, calculate, ...).

// Central failure model. Codes classify failures; user-facing text comes only from IMPORT_USER_MESSAGES.
// Raw exceptions are kept as `cause` for diagnostics and are never shown to the user or logged verbatim.
const IMPORT_FAILURE_CODES = Object.freeze({
  NO_FILE_SELECTED: "NO_FILE_SELECTED",
  UNSUPPORTED_FILE_TYPE: "UNSUPPORTED_FILE_TYPE",
  FILE_TOO_LARGE: "FILE_TOO_LARGE",
  EMPTY_FILE: "EMPTY_FILE",
  UNREADABLE_WORKBOOK: "UNREADABLE_WORKBOOK",
  ENCRYPTED_WORKBOOK: "ENCRYPTED_WORKBOOK",
  UNSUPPORTED_WORKBOOK_VERSION: "UNSUPPORTED_WORKBOOK_VERSION",
  INVALID_WORKBOOK_STRUCTURE: "INVALID_WORKBOOK_STRUCTURE",
  PARSING_FAILED: "PARSING_FAILED",
  NORMALIZATION_FAILED: "NORMALIZATION_FAILED",
  VALIDATION_FAILED: "VALIDATION_FAILED",
  PREVIEW_FAILED: "PREVIEW_FAILED",
  RECALCULATION_FAILED: "RECALCULATION_FAILED",
  COMMIT_FAILED: "COMMIT_FAILED",
  ROLLBACK_FAILED: "ROLLBACK_FAILED",
  IMPORT_IN_PROGRESS: "IMPORT_IN_PROGRESS",
  UNKNOWN_IMPORT_FAILURE: "UNKNOWN_IMPORT_FAILURE",
});

const IMPORT_USER_MESSAGES = Object.freeze({
  NO_FILE_SELECTED: "Select a valid .xlsx workbook generated from WealthMap.",
  UNSUPPORTED_FILE_TYPE:
    "This file is not a supported WealthMap workbook. Select a valid .xlsx workbook generated from WealthMap.",
  FILE_TOO_LARGE: "The selected workbook is too large. Choose a file smaller than 10 MB.",
  EMPTY_FILE: "The selected workbook is empty.",
  UNREADABLE_WORKBOOK: "WealthMap could not read this workbook. Your current plan was not changed.",
  ENCRYPTED_WORKBOOK:
    "This workbook is password-protected or encrypted, which WealthMap cannot read. Remove the protection and try again. Your current plan was not changed.",
  UNSUPPORTED_WORKBOOK_VERSION:
    "This workbook version is not supported. Download a new planning workbook from WealthMap and try again.",
  INVALID_WORKBOOK_STRUCTURE:
    "This workbook is missing required WealthMap sections. Review the validation details and correct the file before importing.",
  PARSING_FAILED: "WealthMap could not read this workbook. Your current plan was not changed.",
  NORMALIZATION_FAILED: "The workbook contained values that are not plan inputs. No changes were applied to your current plan.",
  VALIDATION_FAILED: "This plan cannot be imported until the identified errors are corrected.",
  PREVIEW_FAILED: "WealthMap could not prepare the import preview. Your current plan was not changed.",
  RECALCULATION_FAILED:
    "WealthMap could not recalculate the imported plan. No changes were applied to your current plan.",
  COMMIT_FAILED: "The imported plan could not be applied. No changes were applied to your current plan.",
  ROLLBACK_FAILED:
    "The import failed, and WealthMap could not confirm that the previous plan was fully restored. Reload the saved plan before making additional changes.",
  IMPORT_IN_PROGRESS: "An import is already in progress.",
  UNKNOWN_IMPORT_FAILURE:
    "The import could not be completed. Your current plan was not changed. Review the file and try again.",
});

function importUserMessage(code) {
  return IMPORT_USER_MESSAGES[code] || IMPORT_USER_MESSAGES.UNKNOWN_IMPORT_FAILURE;
}

class ImportFailure extends Error {
  constructor(code, detail = "", cause = undefined) {
    super(importUserMessage(code));
    this.name = "ImportFailure";
    this.code = code;
    // Detail is authored by this module (field or output names only) and is safe to show.
    this.detail = detail;
    this.cause = cause;
  }
}

// Explicit import status instead of loosely related booleans.
const IMPORT_STATUSES = Object.freeze([
  "idle",
  "reading",
  "validating",
  "preview-ready",
  "awaiting-confirmation",
  "importing",
  "recalculating",
  "committing",
  "succeeded",
  "failed",
]);
const IMPORT_BUSY_STATUSES = Object.freeze(["reading", "validating", "importing", "recalculating", "committing"]);
let importStatus = "idle";
// Set only when a rollback could not be confirmed; blocks further state-changing imports.
let importIntegrityLocked = false;
let importOperationCounter = 0;

function setImportStatus(status) {
  if (!IMPORT_STATUSES.includes(status)) throw new Error(`Unknown import status: ${status}`);
  importStatus = status;
  return status;
}
const getImportStatus = () => importStatus;
const nextImportOperationId = () => `import-${(importOperationCounter += 1)}`;

// Diagnostics: only whitelisted, non-financial context is logged (no balances, plan state, or cell contents).
let importLogger = (entry) => console.error("[WealthMap import]", JSON.stringify(entry));
function setImportLogger(logger) {
  importLogger = logger;
}
function logImportEvent(entry) {
  const safe = {};
  ["operationId", "stage", "code", "rollback", "workbookVersion", "templateVersion"].forEach((key) => {
    if (entry[key] !== undefined && entry[key] !== null) safe[key] = entry[key];
  });
  if (entry.cause && typeof entry.cause === "object" && entry.cause.name) safe.errorType = String(entry.cause.name);
  if (entry.rollbackCause && typeof entry.rollbackCause === "object" && entry.rollbackCause.name) {
    safe.rollbackErrorType = String(entry.rollbackCause.name);
  }
  try {
    importLogger(safe);
  } catch {
    // Logging must never break the import.
  }
}

function importDeepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

const importIsFinite = (value) => typeof value === "number" && Number.isFinite(value);

// Inputs and derived outputs stay separate: the imported plan may only contain keys that exist in the
// sample plan's input shape, so no score, projection, or tax output can ride in with an import.
function assertImportedPlanIsInputsOnly(profile, baseline = cloneSampleProfile()) {
  if (!profile || typeof profile !== "object") throw new ImportFailure(IMPORT_FAILURE_CODES.NORMALIZATION_FAILED);
  const allowed = new Set(Object.keys(baseline));
  const unexpected = Object.keys(profile).filter((key) => !allowed.has(key));
  if (unexpected.length) {
    throw new ImportFailure(IMPORT_FAILURE_CODES.NORMALIZATION_FAILED, `Unexpected: ${unexpected.join(", ")}.`);
  }
  // Every supported input must be present, so the import fully replaces the plan with no mixed state.
  const missing = buildSupportedInputInventory()
    .filter((item) => item.worksheet !== WORKBOOK_SHEETS.timeline)
    .filter((item) => item.fieldId.split(".").reduce((node, key) => (node == null ? undefined : node[key]), profile) === undefined)
    .map((item) => item.fieldId);
  if (missing.length) {
    throw new ImportFailure(IMPORT_FAILURE_CODES.NORMALIZATION_FAILED, `Missing: ${missing.join(", ")}.`);
  }
}

// Critical outputs that must exist for a projection to be usable.
function describeMissingOutputs(outputs) {
  const missing = [];
  if (!outputs.metrics || !importIsFinite(outputs.metrics.score)) missing.push("Readiness Score");
  if (!outputs.metrics || typeof outputs.metrics.status !== "string" || !outputs.metrics.status) missing.push("Readiness Status");
  if (!outputs.metrics || !importIsFinite(outputs.metrics.projectedAssets)) missing.push("Projected Retirement Assets");
  if (!Array.isArray(outputs.timelineRows) || outputs.timelineRows.length === 0) missing.push("Timeline");
  if (!Array.isArray(outputs.recommendations)) missing.push("Recommendations");
  return missing;
}

// Dry run on a private copy using the application's own functions. Never reads or writes app state.
function verifyPlanProjection(profile) {
  const copy = importDeepClone(profile);
  let outputs;
  try {
    const metrics = calculate(copy);
    const timelineRows = buildTimelineRows(resolveEffectiveProfile(copy).effectiveProfile);
    outputs = { metrics, timelineRows, recommendations: recommendations(metrics, copy) };
  } catch (error) {
    throw new ImportFailure(IMPORT_FAILURE_CODES.RECALCULATION_FAILED, "", error);
  }
  const missing = describeMissingOutputs(outputs);
  if (missing.length) {
    throw new ImportFailure(IMPORT_FAILURE_CODES.RECALCULATION_FAILED, `Missing: ${missing.join(", ")}.`);
  }
  return outputs;
}

// Checks the live, rendered state after the refresh.
function verifyLiveOutputs() {
  const missing = describeMissingOutputs({
    metrics: lastValidProjection,
    timelineRows: currentTimelineRows,
    recommendations: currentRecommendationItems,
  });
  if (!currentValidationState || !currentValidationState.isValid) missing.push("Plan Setup validation");
  if (missing.length) {
    throw new ImportFailure(IMPORT_FAILURE_CODES.RECALCULATION_FAILED, `Missing: ${missing.join(", ")}.`);
  }
}

function summarizeImport(profile, counts = {}) {
  return {
    fieldsImported: counts.fields ?? null,
    overridesImported: counts.overrides ?? Object.keys(profile.timelineOverrides || {}).length,
    readinessRefreshed: true,
    timelineRegenerated: true,
    recommendationsUpdated: true,
  };
}

const importStableJson = (value) =>
  JSON.stringify(value, (key, node) =>
    node && typeof node === "object" && !Array.isArray(node)
      ? Object.keys(node).sort().reduce((sorted, name) => ({ ...sorted, [name]: node[name] }), {})
      : node,
  );

const ImportService = {
  // Returns { ok: true, summary } or { ok: false, code, rolledBack, error }. Never throws.
  // The candidate is verified in isolation first; the live state is replaced only after that succeeds,
  // and is restored (and the restoration checked) if any later step fails.
  applyImport(importedProfile, options = {}) {
    const operationId = nextImportOperationId();
    const meta = { operationId, workbookVersion: options.schemaVersion, templateVersion: options.templateVersion };
    const fail = (code, rest = {}) => ({
      ok: false,
      code,
      operationId,
      rolledBack: rest.rolledBack ?? false,
      error: !rest.detail ? importUserMessage(code) : `${importUserMessage(code)} ${rest.detail}`,
    });
    if (importIntegrityLocked) {
      logImportEvent({ ...meta, stage: "preflight", code: IMPORT_FAILURE_CODES.ROLLBACK_FAILED });
      return fail(IMPORT_FAILURE_CODES.ROLLBACK_FAILED);
    }
    if (importStatus === "importing" || importStatus === "recalculating" || importStatus === "committing") {
      return fail(IMPORT_FAILURE_CODES.IMPORT_IN_PROGRESS);
    }

    const hooks = {
      replace: options.replace || replaceWorkingProfile,
      current: options.current || currentWorkingProfile,
      verifyProjection: options.verifyProjection || verifyPlanProjection,
      verifyLive: options.verifyLive || verifyLiveOutputs,
    };
    let stage = "importing";
    setImportStatus("importing");
    let previous;
    try {
      previous = importDeepClone(hooks.current());
    } catch (error) {
      setImportStatus("failed");
      logImportEvent({ ...meta, stage, code: IMPORT_FAILURE_CODES.UNKNOWN_IMPORT_FAILURE, cause: error });
      return fail(IMPORT_FAILURE_CODES.UNKNOWN_IMPORT_FAILURE);
    }
    const previousJson = importStableJson(previous);
    let replaceStarted = false;

    try {
      // Fresh private copy so later edits can never alias the pending import.
      const plan = importDeepClone(importedProfile);
      assertImportedPlanIsInputsOnly(plan);
      stage = "recalculating";
      setImportStatus("recalculating");
      hooks.verifyProjection(plan);
      stage = "committing";
      setImportStatus("committing");
      replaceStarted = true;
      try {
        hooks.replace(plan);
      } catch (error) {
        throw new ImportFailure(IMPORT_FAILURE_CODES.COMMIT_FAILED, "", error);
      }
      stage = "verifying";
      setImportStatus("recalculating");
      try {
        hooks.verifyLive();
      } catch (error) {
        throw error instanceof ImportFailure ? error : new ImportFailure(IMPORT_FAILURE_CODES.RECALCULATION_FAILED, "", error);
      }
      setImportStatus("succeeded");
      return { ok: true, rolledBack: false, operationId, summary: summarizeImport(plan, options.counts) };
    } catch (error) {
      const failure =
        error instanceof ImportFailure ? error : new ImportFailure(IMPORT_FAILURE_CODES.UNKNOWN_IMPORT_FAILURE, "", error);
      let rollbackCause = null;
      let restored = true;
      if (replaceStarted) {
        try {
          // replaceWorkingProfile restores itself when it throws, so only re-replace if state differs.
          if (importStableJson(hooks.current()) !== previousJson || stage === "verifying") hooks.replace(importDeepClone(previous));
          restored = importStableJson(hooks.current()) === previousJson;
          if (!restored) rollbackCause = new Error("State mismatch after rollback");
        } catch (rollbackError) {
          restored = false;
          rollbackCause = rollbackError;
        }
      }
      setImportStatus("failed");
      logImportEvent({ ...meta, stage, code: failure.code, cause: failure.cause || failure, rollback: replaceStarted ? (restored ? "restored" : "failed") : "not-needed" });
      if (!restored) {
        importIntegrityLocked = true;
        logImportEvent({ ...meta, stage: "rollback", code: IMPORT_FAILURE_CODES.ROLLBACK_FAILED, cause: rollbackCause, rollback: "failed" });
        return fail(IMPORT_FAILURE_CODES.ROLLBACK_FAILED);
      }
      return fail(failure.code, { rolledBack: true, detail: failure.detail });
    }
  },
};

function describeImportSuccess(summary) {
  const parts = [];
  if (summary.fieldsImported != null) parts.push(`${summary.fieldsImported} fields imported`);
  parts.push(`${summary.overridesImported} timeline override${summary.overridesImported === 1 ? "" : "s"} imported`);
  parts.push("Readiness Score refreshed", "Timeline regenerated", "Recommendations updated");
  return `Plan Imported Successfully. Your plan was updated and all WealthMap projections were recalculated. ${parts.join(". ")}.`;
}

// `message` is already user-safe (from importUserMessage). Only a confirmed rollback may say nothing changed.
function describeImportFailure(message, code) {
  if (code === IMPORT_FAILURE_CODES.ROLLBACK_FAILED) return `Import Failed. ${message}`.trim();
  if (/not changed|No changes were applied/.test(message)) return `Import Failed. ${message}`.trim();
  return `Import Failed. No changes were applied to your plan. ${message}`.trim();
}
