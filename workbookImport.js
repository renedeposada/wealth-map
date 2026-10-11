// Planning workbook import, step 1: file selection and structural validation only.
// Nothing here reads, normalizes, previews, or applies plan values; workingProfile, the Timeline
// overrides, and the calculation functions are never touched. All processing stays in the browser.
// Depends on workbook.js (schema, identity/version constants, prohibited-field helper) and on the
// ExcelJS browser build already used by the blank workbook generator.

const WORKBOOK_IMPORT_MAX_BYTES = 10 * 1024 * 1024;
const WORKBOOK_IMPORT_HEADER_SEARCH_ROWS = 30;
const WORKBOOK_IMPORT_MAX_FORMULA_ERRORS = 50;
// Bounds on what is read from an untrusted workbook.
const WORKBOOK_IMPORT_MAX_WORKSHEETS = 20;
const WORKBOOK_IMPORT_MAX_ROWS = 2000;
const WORKBOOK_IMPORT_MAX_COLUMNS = 100;
const WORKBOOK_VERSION_PATTERN = /^\d+\.\d+$/;
const WORKBOOK_INPUT_SHEET_NAMES = Object.freeze([
  WORKBOOK_SHEETS.planSetup,
  WORKBOOK_SHEETS.assets,
  WORKBOOK_SHEETS.incomeExpenses,
]);
const WORKBOOK_REQUIRED_INPUT_HEADERS = Object.freeze(INPUT_HEADERS);
const WORKBOOK_TIMELINE_AGE_HEADER = "Age";
const WORKBOOK_TIMELINE_NOTES_HEADER = "Notes";

const WORKBOOK_IMPORT_MESSAGES = Object.freeze({
  checking: "Checking planning workbook...",
  unsupportedType: "Select a WealthMap Planning Workbook in .xlsx format.",
  empty: "The selected workbook is empty.",
  tooLarge: "The selected workbook is too large. Choose a file smaller than 10 MB.",
  unreadable: "WealthMap could not read this workbook. Download a new planning workbook and try again.",
  unsupportedVersion:
    "This workbook version is not supported. Download a new planning workbook from WealthMap and try again.",
  formula:
    "The workbook contains a formula in an input cell. Replace the formula with a direct value and try again.",
  success: "Workbook structure validated successfully. No plan information has been imported.",
  imported: "Workbook imported. Your plan now uses the workbook values.",
  preview: "Workbook checked. Review the preview, then choose Import Plan. Your current plan is unchanged.",
  cancelled: "Import cancelled. Your current plan is unchanged.",
  blocked: "Import blocked. Your current plan is unchanged.",
  failure: "The workbook could not be imported because its structure is invalid.",
});

// Error codes whose own message is the best status text; everything else gets the generic failure.
const WORKBOOK_FILE_LEVEL_CODES = Object.freeze([
  "NO_FILE_SELECTED",
  "UNSUPPORTED_FILE_TYPE",
  "EMPTY_FILE",
  "FILE_TOO_LARGE",
  "FILE_READ_FAILED",
  "WORKBOOK_PARSE_FAILED",
  "ENCRYPTED_WORKBOOK",
  "WORKBOOK_TOO_LARGE",
  "UNSUPPORTED_TEMPLATE_VERSION",
  "UNSUPPORTED_SCHEMA_VERSION",
  "MISSING_TEMPLATE_VERSION",
  "MISSING_SCHEMA_VERSION",
]);

// Metadata only: file info, identity, versions, validation state, and the parsed workbook reference.
let pendingWorkbookImport = null;
let workbookImportRequestId = 0;

function createWorkbookValidationResult(fileName = "", fileSize = 0) {
  return {
    isValid: false,
    fileName,
    fileSize,
    workbookType: null,
    templateVersion: null,
    schemaVersion: null,
    errors: [],
    warnings: [],
    worksheetResults: [],
    workbook: null,
  };
}

function addWorkbookValidationIssue(result, severity, code, message, details = {}) {
  (severity === "warning" ? result.warnings : result.errors).push({
    code,
    message,
    worksheet: details.worksheet ?? null,
    row: details.row ?? null,
    column: details.column ?? null,
    fieldId: details.fieldId ?? null,
    expected: details.expected ?? null,
  });
}

const addWorkbookError = (result, code, message, details) =>
  addWorkbookValidationIssue(result, "error", code, message, details);
const addWorkbookWarning = (result, code, message, details) =>
  addWorkbookValidationIssue(result, "warning", code, message, details);

function workbookColumnLetter(column) {
  let letters = "";
  let number = column;
  while (number > 0) {
    const remainder = (number - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    number = Math.floor((number - 1) / 26);
  }
  return letters;
}

// Returns text for string-like cells only; numbers, dates, and formulas are never coerced.
function importCellText(cell) {
  if (!cell) return null;
  const value = cell.value;
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && Array.isArray(value.richText)) {
    return value.richText.map((part) => part.text).join("");
  }
  return null;
}

function importCellIsBlank(cell) {
  const value = cell ? cell.value : null;
  if (value == null) return true;
  const text = importCellText(cell);
  return text !== null && text.trim() === "";
}

// Safe text for messages: workbook content is untrusted and may be long.
function importDisplayText(text) {
  const clean = String(text).replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return clean.length > 60 ? `${clean.slice(0, 57)}...` : clean;
}

function openWorkbookFilePicker() {
  const input = $("#import-workbook-input");
  if (!input) return;
  // Clearing the value lets the same file be chosen again and still fire a change event.
  input.value = "";
  input.click();
}

function validateWorkbookFileSelection(files) {
  const list = files ? Array.from(files) : [];
  if (list.length === 0) {
    return { file: null, code: "NO_FILE_SELECTED", message: WORKBOOK_IMPORT_MESSAGES.unsupportedType };
  }
  const [file] = list;
  if (list.length > 1 || !file || !/\.xlsx$/i.test(String(file.name || ""))) {
    return { file, code: "UNSUPPORTED_FILE_TYPE", message: WORKBOOK_IMPORT_MESSAGES.unsupportedType };
  }
  if (!file.size) return { file, code: "EMPTY_FILE", message: WORKBOOK_IMPORT_MESSAGES.empty };
  if (file.size > WORKBOOK_IMPORT_MAX_BYTES) {
    return { file, code: "FILE_TOO_LARGE", message: WORKBOOK_IMPORT_MESSAGES.tooLarge };
  }
  return { file, code: null, message: null };
}

async function readWorkbookArrayBuffer(file) {
  if (typeof file.arrayBuffer === "function") return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("read failed"));
    reader.readAsArrayBuffer(file);
  });
}

async function parsePlanningWorkbook(buffer, excelApi = globalThis.ExcelJS) {
  const bytes = new Uint8Array(buffer);
  const isZip = bytes.length > 3 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  // Password-protected .xlsx files are OLE compound documents (D0 CF 11 E0), not ZIP packages.
  const isEncryptedContainer = bytes.length > 3 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;
  if (isEncryptedContainer) {
    const error = new Error("encrypted workbook");
    error.importCode = IMPORT_FAILURE_CODES.ENCRYPTED_WORKBOOK;
    throw error;
  }
  if (!isZip || !excelApi) throw new Error("not a workbook");
  const workbook = new excelApi.Workbook();
  await workbook.xlsx.load(buffer);
  return workbook;
}

function validateWorkbookIdentity(result, sheet) {
  const labels = WORKBOOK_IDENTITY_LABELS;
  const found = {};
  const repeated = new Set();
  if (sheet) {
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber > 60) return;
      const text = importCellText(row.getCell(1));
      const match = text && /^([^:]+):\s*(.*)$/.exec(text);
      if (!match) return;
      const key = Object.keys(labels).find((name) => labels[name] === match[1]);
      if (!key) return;
      if (key in found) repeated.add(key);
      found[key] = match[2].trim();
    });
  }
  const details = { worksheet: WORKBOOK_SHEETS.instructions };
  const identityProblem = (message, expected) =>
    addWorkbookError(result, "INVALID_WORKBOOK_TYPE", message, { ...details, expected });

  if (found.application !== WORKBOOK_APPLICATION_NAME) {
    identityProblem("The application name marker is missing or incorrect.", `${labels.application}: ${WORKBOOK_APPLICATION_NAME}`);
  }
  if (found.type !== WORKBOOK_TYPE) {
    identityProblem("The workbook type is missing or incorrect.", `${labels.type}: ${WORKBOOK_TYPE}`);
  }
  if (found.purpose !== WORKBOOK_PURPOSE) {
    identityProblem("The workbook purpose marker is missing or incorrect.", `${labels.purpose}: ${WORKBOOK_PURPOSE}`);
  }
  repeated.forEach((key) =>
    identityProblem(`The ${labels[key]} marker appears more than once.`, `${labels[key]} exactly once`),
  );
  result.workbookType = found.type ?? null;

  [
    ["templateVersion", "MISSING_TEMPLATE_VERSION", "UNSUPPORTED_TEMPLATE_VERSION", WORKBOOK_SUPPORTED_TEMPLATE_VERSIONS],
    ["schemaVersion", "MISSING_SCHEMA_VERSION", "UNSUPPORTED_SCHEMA_VERSION", WORKBOOK_SUPPORTED_SCHEMA_VERSIONS],
  ].forEach(([key, missingCode, unsupportedCode, supported]) => {
    const value = found[key];
    const expected = `${labels[key]}: ${supported.join(", ")}`;
    if (!value) {
      addWorkbookError(result, missingCode, `The ${labels[key]} is missing.`, { ...details, expected });
      return;
    }
    result[key] = value;
    if (!WORKBOOK_VERSION_PATTERN.test(value) || !supported.includes(value)) {
      addWorkbookError(result, unsupportedCode, WORKBOOK_IMPORT_MESSAGES.unsupportedVersion, { ...details, expected });
    }
  });
}

function validateWorkbookWorksheets(result, workbook) {
  const sheets = workbook.worksheets || [];
  const required = Object.values(WORKBOOK_SHEETS);
  const reserved = new Set(required.map((name) => name.toLowerCase().replace(/\s+/g, "")));
  const isReserved = (name) => reserved.has(String(name).toLowerCase().replace(/\s+/g, "").replace("and", "&"));
  const resolved = {};

  required.forEach((name) => {
    const matches = sheets.filter((sheet) => sheet.name === name);
    const entry = { worksheet: name, role: "required", found: matches.length > 0, visible: false, readable: false, errors: 0, warnings: 0 };
    result.worksheetResults.push(entry);
    if (matches.length === 0) {
      addWorkbookError(result, "MISSING_WORKSHEET", `The required worksheet "${name}" is missing.`, { worksheet: name, expected: `A worksheet named exactly "${name}"` });
    } else if (matches.length > 1) {
      addWorkbookError(result, "CONFLICTING_WORKSHEET", `The worksheet "${name}" appears more than once.`, { worksheet: name, expected: "Each required worksheet exactly once" });
    } else if (matches[0].state && matches[0].state !== "visible") {
      addWorkbookError(result, "CONFLICTING_WORKSHEET", `The required worksheet "${name}" is hidden.`, { worksheet: name, expected: "Required worksheets must be visible" });
    } else {
      entry.visible = true;
      try {
        void matches[0].rowCount;
        entry.readable = true;
        resolved[name] = matches[0];
      } catch {
        addWorkbookError(result, "STRUCTURAL_VALIDATION_FAILED", `The worksheet "${name}" could not be read.`, { worksheet: name });
      }
    }
  });

  sheets.forEach((sheet) => {
    if (required.includes(sheet.name)) return;
    const hidden = sheet.state && sheet.state !== "visible";
    const entry = { worksheet: sheet.name, role: "additional", found: true, visible: !hidden, readable: true, errors: 0, warnings: 0 };
    result.worksheetResults.push(entry);
    if (!hidden) {
      addWorkbookWarning(result, "ADDITIONAL_WORKSHEET_IGNORED", `The worksheet "${importDisplayText(sheet.name)}" is not part of the planning template. Its contents are ignored.`, { worksheet: sheet.name });
      return;
    }
    if (WORKBOOK_HELPER_SHEET_NAMES.includes(sheet.name)) return;
    const reason = isReserved(sheet.name)
      ? `The hidden worksheet "${importDisplayText(sheet.name)}" uses a reserved WealthMap worksheet name.`
      : `The hidden worksheet "${importDisplayText(sheet.name)}" is not supported because it could make the workbook ambiguous.`;
    addWorkbookError(result, "CONFLICTING_WORKSHEET", reason, { worksheet: sheet.name, expected: "No hidden worksheets" });
  });
  return resolved;
}

// Finds the row that best matches the expected headings, so columns are discovered by heading.
function findWorkbookHeaderRow(sheet, headings) {
  let best = null;
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber > WORKBOOK_IMPORT_HEADER_SEARCH_ROWS) return;
    let matches = 0;
    row.eachCell({ includeEmpty: false }, (cell) => {
      if (headings.includes(importCellText(cell))) matches += 1;
    });
    if (matches >= 2 && (!best || matches > best.matches)) best = { rowNumber, matches };
  });
  return best ? best.rowNumber : null;
}

// Maps each non-blank header cell to its columns; duplicates stay visible as multiple columns.
function readWorkbookHeaderColumns(sheet, rowNumber) {
  const columns = new Map();
  sheet.getRow(rowNumber).eachCell({ includeEmpty: false }, (cell, column) => {
    const text = importCellText(cell);
    if (text === null || text.trim() === "") return;
    if (!columns.has(text)) columns.set(text, []);
    columns.get(text).push(column);
  });
  return columns;
}

function validateWorkbookHeaders(result, sheet, headerRow, required, optional = []) {
  const columns = readWorkbookHeaderColumns(sheet, headerRow || 0);
  const located = {};
  required.forEach((heading) => {
    const found = columns.get(heading) || [];
    if (found.length === 0) {
      addWorkbookError(result, "MISSING_HEADER", `The required heading "${heading}" is missing.`, { worksheet: sheet.name, row: headerRow, expected: `Heading "${heading}" exactly once` });
    } else if (found.length > 1) {
      addWorkbookError(result, "DUPLICATE_HEADER", `The heading "${heading}" appears more than once.`, { worksheet: sheet.name, row: headerRow, column: found[1], expected: `Heading "${heading}" exactly once` });
    } else {
      located[heading] = found[0];
    }
  });
  optional.forEach((heading) => {
    const found = columns.get(heading) || [];
    if (found.length > 1) {
      addWorkbookError(result, "DUPLICATE_HEADER", `The heading "${heading}" appears more than once.`, { worksheet: sheet.name, row: headerRow, column: found[1], expected: `Heading "${heading}" at most once` });
    } else if (found.length === 1) {
      located[heading] = found[0];
    }
  });
  const known = new Set([...required, ...optional]);
  const unexpected = [];
  columns.forEach((list, heading) => {
    if (!known.has(heading)) unexpected.push({ heading, column: list[0] });
  });
  return { located, unexpected };
}

function detectWorkbookFormula(cell) {
  const value = cell ? cell.value : null;
  return Boolean(
    value && typeof value === "object" && ("formula" in value || "sharedFormula" in value),
  );
}

function detectImportableFormulas(result, sheet, headerRow, columns) {
  const entry = result.worksheetResults.find((item) => item.worksheet === sheet.name);
  let reported = 0;
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber <= headerRow) return;
    columns.forEach(({ column, fieldId, fieldIdColumn, heading }) => {
      if (!detectWorkbookFormula(row.getCell(column))) return;
      if (entry) entry.formulaCells = (entry.formulaCells || 0) + 1;
      if (reported >= WORKBOOK_IMPORT_MAX_FORMULA_ERRORS) return;
      reported += 1;
      addWorkbookError(result, "FORMULA_IN_IMPORTABLE_CELL", WORKBOOK_IMPORT_MESSAGES.formula, {
        worksheet: sheet.name,
        row: rowNumber,
        column,
        fieldId: fieldId ?? (fieldIdColumn ? importDisplayText(importCellText(row.getCell(fieldIdColumn)) ?? "") || null : null),
        expected: heading ? `A direct value in the "${heading}" column` : "A direct value",
      });
    });
  });
}

function validateWorkbookFieldIds(result, sheet, headerRow, located, schema, seen) {
  const fieldIdColumn = located["Field ID"];
  if (!fieldIdColumn) {
    addWorkbookError(result, "MISSING_FIELD_ID_COLUMN", 'The "Field ID" column could not be identified.', { worksheet: sheet.name, row: headerRow, expected: 'A "Field ID" heading' });
    return;
  }
  const expectedHere = schema.filter((entry) => entry.worksheet === sheet.name);
  const schemaById = new Map(schema.map((entry) => [entry.fieldId, entry]));
  const foundHere = new Set();

  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber <= headerRow) return;
    const idCell = row.getCell(fieldIdColumn);
    const section = located.Section ? row.getCell(located.Section) : null;
    const label = located.Field ? row.getCell(located.Field) : null;
    if (importCellIsBlank(idCell) && importCellIsBlank(section) && importCellIsBlank(label)) return;

    const where = { worksheet: sheet.name, row: rowNumber, column: fieldIdColumn };
    if (importCellIsBlank(idCell)) {
      addWorkbookError(result, "MISSING_REQUIRED_FIELD_ID", "This input row has no Field ID.", { ...where, expected: "A Field ID from the planning template" });
      return;
    }
    const fieldId = importCellText(idCell);
    if (fieldId === null) {
      addWorkbookError(result, "UNSUPPORTED_FIELD_ID", "The Field ID must be text.", { ...where, expected: "A Field ID from the planning template" });
      return;
    }
    const shown = importDisplayText(fieldId);
    if (workbookFieldIdIsProhibited(fieldId)) {
      addWorkbookError(result, "PROHIBITED_FIELD_ID", "This Field ID is a calculated or read-only value and cannot be imported.", { ...where, fieldId: shown });
      return;
    }
    const entry = schemaById.get(fieldId);
    if (!entry) {
      addWorkbookError(result, "UNSUPPORTED_FIELD_ID", "This Field ID is not recognized by the current planning template.", { ...where, fieldId: shown, expected: "A Field ID from the planning template" });
      return;
    }
    if (seen.has(fieldId)) {
      addWorkbookError(result, "DUPLICATE_FIELD_ID", "This Field ID appears more than once.", { ...where, fieldId, expected: "Each Field ID exactly once" });
      return;
    }
    seen.add(fieldId);
    if (entry.worksheet !== sheet.name) {
      addWorkbookError(result, "FIELD_ID_WRONG_WORKSHEET", `This Field ID belongs on the "${entry.worksheet}" worksheet.`, { ...where, fieldId, expected: `Worksheet "${entry.worksheet}"` });
      return;
    }
    foundHere.add(fieldId);
    if (section && importCellText(section) !== entry.section) {
      addWorkbookError(result, "STRUCTURAL_VALIDATION_FAILED", `This Field ID belongs in the "${entry.section}" section.`, { ...where, column: located.Section, fieldId, expected: `Section "${entry.section}"` });
    }
  });

  expectedHere.forEach((entry) => {
    if (foundHere.has(entry.fieldId) || seen.has(entry.fieldId)) return;
    addWorkbookError(result, "MISSING_REQUIRED_FIELD_ID", "A required Field ID is missing from this worksheet.", { worksheet: sheet.name, fieldId: entry.fieldId, expected: `Field ID ${entry.fieldId}` });
  });
}

function validateStandardWorksheet(result, sheet, schema, seen) {
  const headerRow = findWorkbookHeaderRow(sheet, WORKBOOK_REQUIRED_INPUT_HEADERS);
  if (!headerRow) {
    addWorkbookError(result, "MISSING_HEADER", "The heading row could not be found.", { worksheet: sheet.name, expected: `Headings: ${WORKBOOK_REQUIRED_INPUT_HEADERS.join(", ")}` });
    return;
  }
  const { located, unexpected } = validateWorkbookHeaders(result, sheet, headerRow, WORKBOOK_REQUIRED_INPUT_HEADERS);
  unexpected.forEach(({ heading, column }) =>
    addWorkbookError(result, "INVALID_HEADER", `The heading "${importDisplayText(heading)}" is not part of the planning template.`, { worksheet: sheet.name, row: headerRow, column, expected: `Headings: ${WORKBOOK_REQUIRED_INPUT_HEADERS.join(", ")}` }),
  );
  validateWorkbookFieldIds(result, sheet, headerRow, located, schema, seen);
  if (located.Value) {
    detectImportableFormulas(result, sheet, headerRow, [{ column: located.Value, heading: "Value", fieldIdColumn: located["Field ID"] }]);
  }
}

function validateTimelineStructure(result, sheet, schema) {
  const timelineEntries = schema.filter((entry) => entry.worksheet === WORKBOOK_SHEETS.timeline);
  const required = [WORKBOOK_TIMELINE_AGE_HEADER, ...timelineEntries.map((entry) => entry.columnHeader)];
  const headerRow = findWorkbookHeaderRow(sheet, [...required, WORKBOOK_TIMELINE_NOTES_HEADER]);
  if (!headerRow) {
    addWorkbookError(result, "INVALID_TIMELINE_STRUCTURE", "The Timeline heading row could not be found.", { worksheet: sheet.name, expected: `Headings: ${required.join(", ")}` });
    return;
  }
  const { located, unexpected } = validateWorkbookHeaders(result, sheet, headerRow, required, [WORKBOOK_TIMELINE_NOTES_HEADER]);
  unexpected.forEach(({ heading, column }) =>
    addWorkbookError(result, "INVALID_TIMELINE_STRUCTURE", `The Timeline column "${importDisplayText(heading)}" is not a supported override column.`, { worksheet: sheet.name, row: headerRow, column, expected: `Columns: ${required.join(", ")}` }),
  );

  // Each override column carries its Field ID in the row above the headings.
  const idRow = headerRow - 1;
  const importable = [];
  if (located[WORKBOOK_TIMELINE_AGE_HEADER]) {
    importable.push({ column: located[WORKBOOK_TIMELINE_AGE_HEADER], heading: WORKBOOK_TIMELINE_AGE_HEADER });
  }
  timelineEntries.forEach((entry) => {
    const column = located[entry.columnHeader];
    if (!column) return;
    const idText = idRow >= 1 ? importCellText(sheet.getRow(idRow).getCell(column)) : null;
    const where = { worksheet: sheet.name, row: idRow, column };
    if (workbookFieldIdIsProhibited(idText)) {
      addWorkbookError(result, "PROHIBITED_FIELD_ID", "This Field ID is a calculated or read-only value and cannot be imported.", { ...where, fieldId: importDisplayText(idText) });
    } else if (idText !== entry.fieldId) {
      addWorkbookError(result, "INVALID_TIMELINE_STRUCTURE", `The Field ID above "${entry.columnHeader}" is missing or incorrect.`, { ...where, expected: `Field ID ${entry.fieldId}` });
    }
    importable.push({ column, heading: entry.columnHeader, fieldId: entry.fieldId });
  });
  if (idRow >= 1) {
    const knownColumns = new Set(Object.values(located));
    sheet.getRow(idRow).eachCell({ includeEmpty: false }, (cell, column) => {
      const text = importCellText(cell);
      if (column === 1 || knownColumns.has(column) || !text || text === "Field ID") return;
      const prohibited = workbookFieldIdIsProhibited(text);
      addWorkbookError(result, prohibited ? "PROHIBITED_FIELD_ID" : "INVALID_TIMELINE_STRUCTURE", prohibited ? "This Field ID is a calculated or read-only value and cannot be imported." : "This Timeline column has an unsupported Field ID.", { worksheet: sheet.name, row: idRow, column, fieldId: importDisplayText(text) });
    });
  }
  detectImportableFormulas(result, sheet, headerRow, importable);
}

// Structural validation of an already parsed workbook. Never reads or interprets plan values.
function validatePlanningWorkbookStructure(workbook, fileInfo = {}, schema = buildPlanningWorkbookSchema()) {
  const result = createWorkbookValidationResult(fileInfo.name || "", fileInfo.size || 0);
  const sheetsInFile = workbook.worksheets || [];
  const oversized =
    sheetsInFile.length > WORKBOOK_IMPORT_MAX_WORKSHEETS ||
    sheetsInFile.some((sheet) => (sheet.rowCount || 0) > WORKBOOK_IMPORT_MAX_ROWS || (sheet.columnCount || 0) > WORKBOOK_IMPORT_MAX_COLUMNS);
  if (oversized) {
    addWorkbookError(result, "WORKBOOK_TOO_LARGE", "This workbook has too many worksheets, rows, or columns to import safely.", {
      expected: `At most ${WORKBOOK_IMPORT_MAX_WORKSHEETS} worksheets, ${WORKBOOK_IMPORT_MAX_ROWS} rows and ${WORKBOOK_IMPORT_MAX_COLUMNS} columns per worksheet`,
    });
    result.isValid = false;
    return result;
  }
  const resolved = validateWorkbookWorksheets(result, workbook);
  const track = (name, work) => {
    const sheet = resolved[name];
    if (!sheet) return;
    const before = result.errors.length;
    const beforeWarnings = result.warnings.length;
    try {
      work(sheet);
    } catch {
      addWorkbookError(result, "STRUCTURAL_VALIDATION_FAILED", `The worksheet "${name}" could not be validated.`, { worksheet: name });
    }
    const entry = result.worksheetResults.find((item) => item.worksheet === name);
    if (entry) {
      entry.errors = result.errors.length - before;
      entry.warnings = result.warnings.length - beforeWarnings;
    }
  };

  track(WORKBOOK_SHEETS.instructions, (sheet) => validateWorkbookIdentity(result, sheet));
  const seen = new Set();
  WORKBOOK_INPUT_SHEET_NAMES.forEach((name) =>
    track(name, (sheet) => validateStandardWorksheet(result, sheet, schema, seen)),
  );
  track(WORKBOOK_SHEETS.timeline, (sheet) => validateTimelineStructure(result, sheet, schema));

  result.isValid = result.errors.length === 0;
  if (result.isValid) result.workbook = workbook;
  return result;
}

function failedWorkbookResult(file, code, message) {
  const result = createWorkbookValidationResult(file?.name || "", file?.size || 0);
  addWorkbookError(result, code, message);
  return result;
}

async function validatePlanningWorkbookFile(files, deps = {}) {
  const selection = validateWorkbookFileSelection(files);
  if (selection.code) return failedWorkbookResult(selection.file, selection.code, selection.message);
  const { file } = selection;
  let buffer;
  try {
    buffer = await readWorkbookArrayBuffer(file);
  } catch (error) {
    logImportEvent({ stage: "reading", code: IMPORT_FAILURE_CODES.UNREADABLE_WORKBOOK, cause: error });
    return failedWorkbookResult(file, "FILE_READ_FAILED", WORKBOOK_IMPORT_MESSAGES.unreadable);
  }
  let workbook;
  try {
    workbook = await parsePlanningWorkbook(buffer, deps.excelApi);
  } catch (error) {
    if (error && error.importCode === IMPORT_FAILURE_CODES.ENCRYPTED_WORKBOOK) {
      return failedWorkbookResult(file, "ENCRYPTED_WORKBOOK", importUserMessage(IMPORT_FAILURE_CODES.ENCRYPTED_WORKBOOK));
    }
    logImportEvent({ stage: "reading", code: IMPORT_FAILURE_CODES.UNREADABLE_WORKBOOK, cause: error });
    return failedWorkbookResult(file, "WORKBOOK_PARSE_FAILED", WORKBOOK_IMPORT_MESSAGES.unreadable);
  }
  return validatePlanningWorkbookStructure(workbook, file);
}

// ---- Parse and normalize (no validation decisions, no state access) ----

// Blank money-like fields mean "none", so they import as 0; every other blank setting uses the app default.
const WORKBOOK_IMPORT_ZERO_WHEN_BLANK = Object.freeze(new Set([
  ...OPTIONAL_BLANK_FIELDS,
  "annualSalary",
  "currentAnnualExpenses",
  "contributionRates.fourOhOneK",
  "employerMatch.rate",
  "employerMatch.salaryCap",
  "assets.cash",
  "assets.brokerage",
  "assets.fourOhOneK",
  "assets.traditionalIra",
  "assets.rothIra",
]));

function importPathGet(object, fieldId) {
  return fieldId.split(".").reduce((value, key) => (value == null ? undefined : value[key]), object);
}

function importPathSet(object, fieldId, value) {
  const path = fieldId.split(".");
  const last = path.pop();
  const parent = path.reduce((node, key) => {
    if (node[key] == null || typeof node[key] !== "object") node[key] = {};
    return node[key];
  }, object);
  parent[last] = value;
}

// Excel cells can hold numbers, text, booleans, dates, or errors; only numbers and text are meaningful.
function importCellValue(cell) {
  if (!cell || importCellIsBlank(cell)) return null;
  const text = importCellText(cell);
  if (text !== null) return text.trim();
  const value = cell.value;
  if (value && typeof value === "object" && "result" in value) return null;
  return value;
}

function importCellRaw(cell) {
  const value = importCellValue(cell);
  return value !== null && typeof value === "object" && !(value instanceof Date) ? String(value) : value;
}

function normalizeImportedValue(item, raw) {
  if (raw === null) return null;
  if (item.dataType === "select") return typeof raw === "string" ? raw : String(raw);
  return raw;
}

function importEffectiveValue(item, normalized, defaults) {
  if (normalized !== null) {
    if (item.dataType === "select") {
      const option = (item.allowedValues || []).find((entry) => entry.label === normalized);
      return option ? option.value : normalized;
    }
    return normalized;
  }
  if (item.required) return null;
  if (item.fieldId === "name") return "";
  if (WORKBOOK_IMPORT_ZERO_WHEN_BLANK.has(item.fieldId)) return 0;
  const fallback = importPathGet(defaults, item.fieldId);
  return fallback === undefined ? null : fallback;
}

function readImportStandardValues(sheet, inventory, candidate) {
  const headerRow = findWorkbookHeaderRow(sheet, WORKBOOK_REQUIRED_INPUT_HEADERS);
  if (!headerRow) return;
  const columns = readWorkbookHeaderColumns(sheet, headerRow);
  const idColumn = (columns.get("Field ID") || [])[0];
  const valueColumn = (columns.get("Value") || [])[0];
  if (!idColumn || !valueColumn) return;
  const byId = new Map(inventory.map((item) => [item.fieldId, item]));
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber <= headerRow) return;
    const id = importCellText(row.getCell(idColumn));
    const item = id && byId.get(id.trim());
    if (!item || item.worksheet !== sheet.name) return;
    candidate.values[item.fieldId] = normalizeImportedValue(item, importCellRaw(row.getCell(valueColumn)));
    candidate.locations[item.fieldId] = { worksheet: sheet.name, row: rowNumber, column: valueColumn };
  });
}

function readImportTimelineRows(sheet, inventory, candidate) {
  const entries = inventory.filter((item) => item.worksheet === WORKBOOK_SHEETS.timeline);
  const headings = [WORKBOOK_TIMELINE_AGE_HEADER, ...entries.map((entry) => entry.columnHeader)];
  const headerRow = findWorkbookHeaderRow(sheet, headings);
  if (!headerRow) return;
  const columns = readWorkbookHeaderColumns(sheet, headerRow);
  const ageColumn = (columns.get(WORKBOOK_TIMELINE_AGE_HEADER) || [])[0];
  if (!ageColumn) return;
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber <= headerRow) return;
    const values = {};
    entries.forEach((entry) => {
      const column = (columns.get(entry.columnHeader) || [])[0];
      values[entry.fieldId.replace("timelineOverrides.", "")] = column ? importCellRaw(row.getCell(column)) : null;
    });
    const ageCell = row.getCell(ageColumn);
    const rawAge = importCellRaw(ageCell);
    const hasValues = Object.values(values).some((value) => value !== null);
    if (rawAge === null && !hasValues) return;
    candidate.overrideRows.push({ row: rowNumber, age: typeof rawAge === "number" ? rawAge : NaN, values });
  });
}

// Turns a structurally valid workbook into a candidate for validateImportCandidate().
function buildImportCandidate(workbook, schema = buildPlanningWorkbookSchema()) {
  const inventory = schema;
  const defaults = cloneSampleProfile();
  const candidate = { inventory, values: {}, effective: {}, locations: {}, overrideRows: [], defaulted: [], profile: null };
  WORKBOOK_INPUT_SHEET_NAMES.forEach((name) => {
    const sheet = workbook.getWorksheet(name);
    if (sheet) readImportStandardValues(sheet, inventory, candidate);
  });
  const timeline = workbook.getWorksheet(WORKBOOK_SHEETS.timeline);
  if (timeline) readImportTimelineRows(timeline, inventory, candidate);

  inventory
    .filter((item) => item.worksheet !== WORKBOOK_SHEETS.timeline)
    .forEach((item) => {
      const normalized = candidate.values[item.fieldId] ?? null;
      candidate.values[item.fieldId] = normalized;
      candidate.effective[item.fieldId] = importEffectiveValue(item, normalized, defaults);
      if (normalized === null && !item.required && item.fieldId !== "name") candidate.defaulted.push(item.fieldId);
    });
  // Savings allocation only counts as entered when at least one side is; both blank keeps the default split.
  const allocationIds = ["savingsAllocation.brokerage", "savingsAllocation.cash"];
  if (allocationIds.every((id) => candidate.values[id] === null)) {
    allocationIds.forEach((id) => (candidate.effective[id] = importPathGet(defaults, id)));
  } else {
    allocationIds.forEach((id) => {
      if (candidate.values[id] === null) candidate.effective[id] = 0;
    });
    candidate.defaulted = candidate.defaulted.filter((id) => !allocationIds.includes(id));
  }
  candidate.profile = buildImportedProfile(candidate, defaults);
  return candidate;
}

// Assembles a complete profile from the sample baseline, every supported input, and the overrides.
function buildImportedProfile(candidate, baseline = cloneSampleProfile()) {
  const profile = baseline;
  candidate.inventory
    .filter((item) => item.worksheet !== WORKBOOK_SHEETS.timeline)
    .forEach((item) => importPathSet(profile, item.fieldId, candidate.effective[item.fieldId]));
  profile.timelineOverrides = {};
  const fields = TIMELINE_OVERRIDE_FIELDS.map((entry) => entry.field);
  (candidate.overrideRows || []).forEach((row) => {
    if (!Number.isInteger(row.age)) return;
    const next = {};
    fields.forEach((field) => {
      const value = row.values[field];
      if (typeof value !== "number" || !Number.isFinite(value)) return;
      const internal = field === "returnPercent" ? value * 100 : value;
      if (timelineOverrideIsAllowed(profile, row.age, field)) next[field] = internal;
    });
    if (Object.keys(next).length) profile.timelineOverrides[row.age] = next;
  });
  return profile;
}

// Merges structural, value, and override findings into the report shape used by the dialog.
function importIssueToReportItem(issue) {
  return {
    code: issue.severity === "error" ? "VALUE_VALIDATION_FAILED" : "VALUE_VALIDATION_WARNING",
    message: issue.message,
    section: issue.section,
    field: issue.field,
    worksheet: issue.worksheet,
    row: issue.row,
    column: issue.column,
    fieldId: issue.fieldId,
  };
}

// The pending import holds the fully validated profile and its preview until the user confirms or cancels.
function setPendingWorkbookImport(result, profile = null) {
  const { workbook, ...validation } = result;
  pendingWorkbookImport = {
    fileName: result.fileName,
    fileSize: result.fileSize,
    workbookType: result.workbookType,
    templateVersion: result.templateVersion,
    schemaVersion: result.schemaVersion,
    validation,
    profile,
  };
  return pendingWorkbookImport;
}

function clearPendingWorkbookImport() {
  pendingWorkbookImport = null;
}

function describeWorkbookValidationFeedback(result) {
  if (result.valuesChecked) {
    const warnings = result.warnings.length ? ` ${result.warnings.length} warning(s) to review.` : "";
    if (result.imported) return `${WORKBOOK_IMPORT_MESSAGES.imported}${warnings}`;
    if (result.awaitingConfirmation) return `${WORKBOOK_IMPORT_MESSAGES.preview}${warnings}`;
    return `${WORKBOOK_IMPORT_MESSAGES.blocked} Fix ${result.errors.length} error(s) in the workbook and import it again.`;
  }
  if (result.isValid) {
    return result.warnings.length
      ? `Workbook structure is valid with ${result.warnings.length} warning(s). No plan information has been imported.`
      : WORKBOOK_IMPORT_MESSAGES.success;
  }
  const first = result.errors[0];
  return first && WORKBOOK_FILE_LEVEL_CODES.includes(first.code) && result.errors.length === 1
    ? first.message
    : WORKBOOK_IMPORT_MESSAGES.failure;
}

function describeWorkbookIssue(issue) {
  const parts = [];
  if (issue.section && !issue.worksheet) parts.push(`Section: ${importDisplayText(issue.section)}`);
  if (issue.field && !issue.fieldId) parts.push(`Field: ${importDisplayText(issue.field)}`);
  if (issue.worksheet) parts.push(`Worksheet: ${importDisplayText(issue.worksheet)}`);
  if (issue.row) parts.push(`Row ${issue.row}`);
  if (issue.column) parts.push(`Column ${workbookColumnLetter(issue.column)}`);
  if (issue.fieldId) parts.push(`Field ID: ${issue.fieldId}`);
  const location = parts.length ? `${parts.join(", ")}. ` : "";
  const expected = issue.expected ? ` Expected: ${issue.expected}.` : "";
  return `${location}${issue.message}${expected}`;
}

// ---- Import preview dialog ----

function importPreviewElement(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function importPreviewStatusText(result) {
  if (!result.isValid) return "❌ Errors";
  return result.warnings.length ? "⚠ Valid with warnings" : "✅ Valid";
}

function renderImportPreviewStats(result, preview) {
  const stats = $("#import-preview-stats");
  stats.replaceChildren();
  const rows = [["Workbook Status", importPreviewStatusText(result)]];
  if (preview) {
    rows.push(
      ["Sections Imported", preview.stats.sections],
      ["Fields Imported", preview.stats.fields],
      ["Errors", preview.stats.errors],
      ["Warnings", preview.stats.warnings],
      ["Timeline Overrides", preview.stats.overrides],
    );
  } else {
    rows.push(["Errors", result.errors.length], ["Warnings", result.warnings.length]);
  }
  rows.forEach(([label, value]) => {
    const group = importPreviewElement("div", "import-preview-stat");
    group.append(importPreviewElement("dt", "", label), importPreviewElement("dd", "", String(value)));
    stats.append(group);
  });
}

function renderImportPreviewIssues(result) {
  [["errors", result.errors, "Import Validation Errors"], ["warnings", result.warnings, "Import Warnings"]].forEach(([key, items, title]) => {
    const section = $(`#workbook-import-${key}-section`);
    const list = $(`#workbook-import-${key}`);
    list.replaceChildren();
    section.hidden = items.length === 0;
    $(`#workbook-import-${key}-heading`).textContent = `${title} (${items.length})`;
    items.forEach((issue) => list.append(importPreviewElement("li", "", describeWorkbookIssue(issue))));
  });
}

function renderImportPreviewChanges(preview) {
  const changes = $("#import-preview-changes");
  changes.replaceChildren();
  preview.changedFields.forEach((change) => {
    const item = importPreviewElement("li", "import-preview-change");
    item.append(
      importPreviewElement("strong", "", change.field),
      importPreviewElement("span", "import-preview-change-section", ` (${change.section})`),
    );
    const values = importPreviewElement("div", "import-preview-change-values");
    values.append(
      importPreviewElement("span", "", `Current: ${change.currentDisplay}`),
      importPreviewElement("span", "import-preview-arrow", " → "),
      importPreviewElement("span", "", `Imported: ${change.importedDisplay}`),
    );
    item.append(values);
    changes.append(item);
  });
  $("#import-preview-changes-heading").textContent = `Changed Fields (${preview.changedFields.length})`;
  $("#import-preview-no-changes").hidden = preview.changedFields.length > 0;
}

function renderImportPreviewSections(preview) {
  const container = $("#import-preview-sections");
  container.replaceChildren();
  preview.importedSections.forEach((worksheet) => {
    const group = importPreviewElement("section", "import-preview-group");
    group.append(importPreviewElement("h3", "", worksheet.worksheet));
    worksheet.sections.forEach((section) => {
      group.append(importPreviewElement("h4", "", section.title));
      const list = importPreviewElement("dl", "import-preview-values");
      section.fields.forEach((field) => {
        const row = importPreviewElement("div", field.changed ? "import-preview-value is-changed" : "import-preview-value");
        row.append(importPreviewElement("dt", "", field.label));
        const value = importPreviewElement("dd");
        if (field.changed) {
          value.append(
            importPreviewElement("span", "import-preview-old", field.currentDisplay),
            importPreviewElement("span", "import-preview-arrow", " → "),
            importPreviewElement("strong", "", field.importedDisplay),
            importPreviewElement("span", "import-preview-changed-tag", " (changed)"),
          );
        } else {
          value.append(importPreviewElement("span", "", field.importedDisplay));
        }
        row.append(value);
        list.append(row);
      });
      group.append(list);
    });
    container.append(group);
  });
}

function renderImportPreviewOverrides(preview) {
  const list = $("#import-preview-overrides");
  list.replaceChildren();
  const rows = preview.overrideSummary.imported;
  rows.forEach((row) => list.append(importPreviewElement("li", "", `Age ${row.age} → ${row.label} → ${row.display}`)));
  $("#import-preview-no-overrides").hidden = rows.length > 0;
}

function renderImportPreviewImpact(preview) {
  const list = $("#import-preview-impact");
  list.replaceChildren();
  describeImportImpact(preview).forEach((line) => list.append(importPreviewElement("li", "", line)));
}

// Default browser feedback; tests inject a recording replacement.
const workbookImportBrowserUi = {
  status(text) {
    const status = $("#workbook-import-status");
    if (!status) return;
    status.textContent = text;
    status.hidden = false;
  },
  details(result) {
    const dialog = $("#workbook-import-dialog");
    const hasDetails = result.errors.length > 0 || result.warnings.length > 0 || Boolean(result.awaitingConfirmation);
    const button = $("#workbook-import-details-button");
    if (button) button.hidden = !hasDetails;
    if (!dialog || !hasDetails) return;
    const preview = result.preview || null;
    const confirmable = Boolean(result.awaitingConfirmation);
    $("#workbook-import-dialog-summary").textContent = "Review imported data before replacing your current plan.";
    renderImportPreviewStats(result, preview);
    renderImportPreviewIssues(result);
    const showPreview = Boolean(preview) && result.isValid;
    ["import-preview-impact-section", "import-preview-changes-section", "import-preview-overrides-section", "import-preview-sections"].forEach((id) => {
      $(`#${id}`).hidden = !showPreview;
    });
    if (showPreview) {
      renderImportPreviewImpact(preview);
      renderImportPreviewChanges(preview);
      renderImportPreviewSections(preview);
      renderImportPreviewOverrides(preview);
    }
    $("#import-preview-overwrite").hidden = !confirmable;
    $("#workbook-import-dialog-note").textContent = confirmable
      ? "Nothing has been imported yet. Your current plan is unchanged until you choose Import Plan."
      : "Import blocked until errors are resolved. Your current plan is unchanged.";
    $("#close-workbook-import-dialog").textContent = confirmable ? "Cancel" : "Close";
    $("#confirm-workbook-import").hidden = !confirmable;
    $("#download-import-validation-report").hidden = confirmable || result.errors.length === 0;
    lastWorkbookImportResult = result;
    if (!dialog.open) dialog.showModal();
    // Blocking errors take focus so keyboard and screen-reader users land on the validation summary.
    const errorsHeading = $("#workbook-import-errors-heading");
    (result.errors.length > 0 && errorsHeading ? errorsHeading : $("#close-workbook-import-dialog")).focus();
  },
  busy(isBusy) {
    const confirm = $("#confirm-workbook-import");
    if (confirm) {
      confirm.disabled = isBusy;
      confirm.setAttribute("aria-busy", String(isBusy));
    }
    const status = $("#workbook-import-status");
    if (status) status.setAttribute("aria-busy", String(isBusy));
  },
  closeDialog() {
    const dialog = $("#workbook-import-dialog");
    if (dialog && dialog.open) dialog.close();
  },
  saveReport(fileName, text) {
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
};

let lastWorkbookImportResult = null;

// Value stage: parse, validate, and build the preview. Nothing is applied here.
// Operational failures (a throw) are reported as one safe error and logged; they are not field validation issues.
function validateAndPreviewWorkbookValues(structural, deps = {}) {
  const { workbook, ...base } = structural;
  const final = { ...base, valuesChecked: true, imported: false, awaitingConfirmation: false, isValid: false };
  const operational = (code, cause) => {
    logImportEvent({ stage: code === IMPORT_FAILURE_CODES.PREVIEW_FAILED ? "preview" : "parsing", code, cause, workbookVersion: base.schemaVersion, templateVersion: base.templateVersion });
    final.errors = [...base.errors, { code, message: importUserMessage(code) }];
    final.operationalFailure = code;
    return final;
  };
  let candidate;
  try {
    candidate = buildImportCandidate(workbook);
  } catch (error) {
    return operational(IMPORT_FAILURE_CODES.PARSING_FAILED, error);
  }
  try {
    const validation = validateImportCandidate(candidate);
    const currentProfile = (deps.getCurrentProfile || currentWorkingProfile)();
    const preview = buildImportPreview(candidate, validation, currentProfile);
    final.validation = validation;
    final.errors = [...base.errors, ...validation.errors.map(importIssueToReportItem)];
    final.warnings = [...base.warnings, ...validation.warnings.map(importIssueToReportItem)];
    final.isValid = validation.valid;
    final.preview = preview;
    if (validation.valid) {
      final.awaitingConfirmation = true;
      setPendingWorkbookImport(final, candidate.profile);
    }
  } catch (error) {
    clearPendingWorkbookImport();
    final.validation = undefined;
    final.warnings = base.warnings;
    final.awaitingConfirmation = false;
    final.isValid = false;
    final.preview = undefined;
    return operational(IMPORT_FAILURE_CODES.PREVIEW_FAILED, error);
  }
  return final;
}

async function handleWorkbookSelection(files, deps = {}) {
  const ui = deps.ui || workbookImportBrowserUi;
  // Cancelling the picker produces no files: leave all state and feedback untouched.
  if (!files || files.length === 0) return null;
  // A pending preview or import in flight must not be replaced mid-transaction.
  if (["importing", "recalculating", "committing"].includes(getImportStatus())) return null;
  const requestId = (workbookImportRequestId += 1);
  // A new selection invalidates any earlier preview immediately, so stale results can never be confirmed.
  clearPendingWorkbookImport();
  setImportStatus("reading");
  ui.status(WORKBOOK_IMPORT_MESSAGES.checking);
  try {
    let result;
    try {
      result = await validatePlanningWorkbookFile(files, deps);
    } catch (error) {
      logImportEvent({ stage: "reading", code: IMPORT_FAILURE_CODES.UNREADABLE_WORKBOOK, cause: error });
      result = failedWorkbookResult(Array.from(files)[0], "STRUCTURAL_VALIDATION_FAILED", WORKBOOK_IMPORT_MESSAGES.unreadable);
    }
    // A newer selection owns the state now; this late result must not overwrite it.
    if (requestId !== workbookImportRequestId) return null;
    clearPendingWorkbookImport();
    setImportStatus("validating");
    if (result.isValid) result = validateAndPreviewWorkbookValues(result, deps);
    if (requestId !== workbookImportRequestId) {
      clearPendingWorkbookImport();
      return null;
    }
    setImportStatus(result.awaitingConfirmation ? "awaiting-confirmation" : result.isValid ? "preview-ready" : "failed");
    ui.status(describeWorkbookValidationFeedback(result));
    ui.details(result);
    return result;
  } catch (error) {
    clearPendingWorkbookImport();
    setImportStatus("failed");
    logImportEvent({ stage: "validating", code: IMPORT_FAILURE_CODES.UNKNOWN_IMPORT_FAILURE, cause: error });
    ui.status(importUserMessage(IMPORT_FAILURE_CODES.UNKNOWN_IMPORT_FAILURE));
    return null;
  }
}

// The only place an import is applied, and only for a previewed, valid workbook.
// A custom deps.applyProfile (tests) replaces the transaction; otherwise ImportService runs it atomically.
function confirmWorkbookImport(deps = {}) {
  const ui = deps.ui || workbookImportBrowserUi;
  const pending = pendingWorkbookImport;
  // Consuming the pending import first makes a second confirmation (double click) a no-op.
  if (!pending || !pending.profile) return null;
  clearPendingWorkbookImport();
  if (ui.busy) ui.busy(true);
  const outcome = { ...pending.validation, imported: false, awaitingConfirmation: false };
  const stats = (pending.validation.preview && pending.validation.preview.stats) || {};
  let applied;
  try {
    if (deps.applyProfile) {
      try {
        deps.applyProfile(pending.profile);
        applied = { ok: true, summary: { fieldsImported: stats.fields, overridesImported: stats.overrides } };
      } catch (error) {
        logImportEvent({ stage: "committing", code: IMPORT_FAILURE_CODES.COMMIT_FAILED, cause: error });
        applied = { ok: false, code: IMPORT_FAILURE_CODES.COMMIT_FAILED, error: importUserMessage(IMPORT_FAILURE_CODES.COMMIT_FAILED) };
      }
    } else {
      applied = ImportService.applyImport(pending.profile, {
        counts: { fields: stats.fields, overrides: stats.overrides },
        schemaVersion: pending.schemaVersion,
        templateVersion: pending.templateVersion,
      });
    }
  } finally {
    if (ui.busy) ui.busy(false);
  }
  outcome.imported = applied.ok;
  outcome.importSummary = applied.summary || null;
  if (ui.closeDialog) ui.closeDialog();
  if (applied.ok) {
    ui.status(describeImportSuccess(applied.summary));
  } else {
    const message = describeImportFailure(applied.error, applied.code);
    outcome.isValid = false;
    outcome.errors = [...outcome.errors, { code: applied.code || "IMPORT_APPLY_FAILED", message }];
    outcome.operationalFailure = applied.code || IMPORT_FAILURE_CODES.UNKNOWN_IMPORT_FAILURE;
    ui.status(message);
    ui.details(outcome);
  }
  return outcome;
}

function cancelWorkbookImport(deps = {}) {
  const ui = deps.ui || workbookImportBrowserUi;
  if (!pendingWorkbookImport) return false;
  clearPendingWorkbookImport();
  setImportStatus("idle");
  ui.status(WORKBOOK_IMPORT_MESSAGES.cancelled);
  return true;
}

function downloadImportValidationReport(result, deps = {}) {
  const ui = deps.ui || workbookImportBrowserUi;
  if (!result) return null;
  const text = formatImportValidationReportText(result, describeWorkbookIssue);
  ui.saveReport(IMPORT_REPORT_FILENAME, text);
  return text;
}

function bindWorkbookImport() {
  const input = $("#import-workbook-input");
  const dialog = $("#workbook-import-dialog");
  const detailsButton = $("#workbook-import-details-button");
  if (input) input.addEventListener("change", () => handleWorkbookSelection(input.files));
  if (detailsButton) detailsButton.addEventListener("click", () => dialog.showModal());
  if (dialog) {
    const returnFocus = () => (detailsButton && !detailsButton.hidden ? detailsButton : $("#plan-actions-button")).focus();
    $("#close-workbook-import-dialog").addEventListener("click", () => dialog.close());
    $("#confirm-workbook-import").addEventListener("click", () => confirmWorkbookImport());
    $("#download-import-validation-report").addEventListener("click", () => downloadImportValidationReport(lastWorkbookImportResult));
    // Closing any other way (button, Escape) while a preview is pending cancels it; a valid preview
    // cannot be reopened afterwards because its pending profile is gone.
    dialog.addEventListener("close", () => {
      if (cancelWorkbookImport() && detailsButton) detailsButton.hidden = true;
      returnFocus();
    });
  }
}
