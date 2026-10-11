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

function loadModel() {
  const sandbox = { console, Math, Number, Intl, Object, Array, JSON, Date, Set, Map, Uint8Array, calcCalls: 0 };
  vm.createContext(sandbox);
  vm.runInContext(
    `${["data.js", "validation.js", "app.js", "workbook.js", "importValidation.js", "importPreview.js", "importService.js", "workbookImport.js"].map(read).join("\n")}
     (function () { const original = calculate; calculate = function () { calcCalls += 1; return original.apply(this, arguments); }; })();
     var __wm = { handleWorkbookSelection, buildPlanningWorkbookSchema, cloneSampleProfile, validatePlanningWorkbookStructure, validateWorkbookFileSelection,
       buildBlankPlanningWorkbook, getProfile: () => workingProfile, getPending: () => pendingWorkbookImport,
       getPage: () => currentPage, WORKBOOK_IMPORT_MAX_BYTES, WORKBOOK_IMPORT_MESSAGES,
       WORKBOOK_TEMPLATE_VERSION, WORKBOOK_SCHEMA_VERSION, WORKBOOK_HELPER_SHEET_NAMES };`,
    sandbox,
    { filename: "wealth-map-import.js" },
  );
  return sandbox;
}

const sandbox = loadModel();
const wm = sandbox.__wm;
const plain = (value) => JSON.parse(JSON.stringify(value));

function recordingUi() {
  const log = { statuses: [], details: [] };
  return { log, status: (text) => log.statuses.push(text), details: (result) => log.details.push(result) };
}

async function toFile(workbook, name = "plan.xlsx") {
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  return {
    name,
    size: buffer.length,
    arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length),
  };
}

// Writes every supported input from the sample plan so the workbook is a complete, valid plan.
function fillSamplePlan(workbook) {
  const sample = wm.cloneSampleProfile();
  wm.buildPlanningWorkbookSchema()
    .filter((entry) => entry.worksheet !== "Timeline Overrides")
    .forEach((entry) => {
      const sheet = workbook.getWorksheet(entry.worksheet);
      let row = 4;
      while (sheet.getCell(row, 6).value !== entry.fieldId) row += 1;
      let value = entry.fieldId.split(".").reduce((node, key) => node[key], sample);
      if (entry.dataType === "select") value = entry.allowedValues.find((option) => option.value === value).label;
      sheet.getCell(row, 3).value = value;
    });
}

// Generates a complete valid workbook, applies a mutation, saves it, and runs the real selection flow.
// applyProfile is injected so the shared sandbox plan is never replaced by these checks.
async function importWorkbook(mutate = () => {}, name, { fill = true } = {}) {
  const workbook = wm.buildBlankPlanningWorkbook(ExcelJS);
  if (fill) fillSamplePlan(workbook);
  mutate(workbook);
  const ui = recordingUi();
  const applied = [];
  const result = await wm.handleWorkbookSelection([await toFile(workbook, name)], {
    ui,
    excelApi: ExcelJS,
    applyProfile: (profile) => applied.push(profile),
  });
  // Structural checks must not apply anything; confirmation is exercised in importValidation.test.js.
  return { result, ui, applied };
}

const codes = (result) => plain(result.errors).map((error) => error.code);
const sheetOf = (workbook, name) => workbook.getWorksheet(name);
const instructionRow = (workbook, label) => {
  const sheet = sheetOf(workbook, "Instructions");
  for (let row = 1; row <= sheet.rowCount; row += 1) {
    if (String(sheet.getCell(row, 1).value).startsWith(`${label}:`)) return sheet.getCell(row, 1);
  }
  throw new Error(`no ${label}`);
};
const rowOfFieldId = (workbook, sheetName, fieldId) => {
  const sheet = sheetOf(workbook, sheetName);
  for (let row = 4; row <= sheet.rowCount; row += 1) if (sheet.getCell(row, 6).value === fieldId) return row;
  throw new Error(`no ${fieldId}`);
};
const valueCell = (workbook, sheetName, fieldId) =>
  sheetOf(workbook, sheetName).getCell(rowOfFieldId(workbook, sheetName, fieldId), 3);

test("a complete generated workbook passes structure and value validation", needsExcel, async () => {
  const { result, ui, applied } = await importWorkbook();
  assert.equal(result.isValid, true, JSON.stringify(plain(result.errors)));
  assert.equal(result.errors.length, 0);
  assert.equal(result.warnings.length, 0);
  assert.equal(result.templateVersion, wm.WORKBOOK_TEMPLATE_VERSION);
  assert.equal(result.schemaVersion, wm.WORKBOOK_SCHEMA_VERSION);
  assert.equal(result.worksheetResults.length, 5);
  assert.deepEqual(plain(ui.log.statuses), ["Checking planning workbook...", wm.WORKBOOK_IMPORT_MESSAGES.preview]);
  assert.equal(applied.length, 0);
  assert.equal(result.awaitingConfirmation, true);
  assert.ok(wm.getPending());
});

test("additional visible worksheets only warn", needsExcel, async () => {
  const { result, ui } = await importWorkbook((workbook) => {
    workbook.addWorksheet("My Notes").getCell("A1").value = "secret 99999";
  });
  assert.equal(result.isValid, true);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0].worksheet, "My Notes");
  assert.match(ui.log.statuses.at(-1), /Workbook checked\..*1 warning\(s\)/);
  assert.ok(!JSON.stringify(plain({ ...result, workbook: null })).includes("99999"));
});

test("identity and version problems are rejected", needsExcel, async () => {
  const cases = [
    ["Application", "Other", "INVALID_WORKBOOK_TYPE"],
    ["Workbook Type", "Something else", "INVALID_WORKBOOK_TYPE"],
    ["Workbook Purpose", "Report", "INVALID_WORKBOOK_TYPE"],
    ["Template Version", "9.0", "UNSUPPORTED_TEMPLATE_VERSION"],
    ["Template Version", "v1", "UNSUPPORTED_TEMPLATE_VERSION"],
    ["Schema Version", "2.0", "UNSUPPORTED_SCHEMA_VERSION"],
  ];
  for (const [label, value, code] of cases) {
    const { result } = await importWorkbook((workbook) => {
      instructionRow(workbook, label).value = `${label}: ${value}`;
    });
    assert.equal(result.isValid, false, label);
    assert.ok(codes(result).includes(code), `${label}=${value}`);
  }
  const missing = [
    ["Template Version", "MISSING_TEMPLATE_VERSION"],
    ["Schema Version", "MISSING_SCHEMA_VERSION"],
    ["Application", "INVALID_WORKBOOK_TYPE"],
  ];
  for (const [label, code] of missing) {
    const { result } = await importWorkbook((workbook) => {
      instructionRow(workbook, label).value = null;
    });
    assert.ok(codes(result).includes(code), label);
  }
  const { result, ui } = await importWorkbook((workbook) => {
    instructionRow(workbook, "Template Version").value = "Template Version: 9.0";
  });
  assert.equal(ui.log.statuses.at(-1), wm.WORKBOOK_IMPORT_MESSAGES.unsupportedVersion);
  assert.equal(result.isValid, false);
});

test("identity is not taken from the filename", needsExcel, async () => {
  const { result } = await importWorkbook((workbook) => {
    instructionRow(workbook, "Workbook Type").value = null;
  }, "WealthMap_Planning_Workbook.xlsx");
  assert.ok(codes(result).includes("INVALID_WORKBOOK_TYPE"));
});

test("missing, renamed, and conflicting worksheets are rejected", needsExcel, async () => {
  for (const name of ["Instructions", "Plan Setup", "Assets", "Income & Expenses", "Timeline Overrides"]) {
    const { result } = await importWorkbook((workbook) => workbook.removeWorksheet(sheetOf(workbook, name).id));
    assert.ok(codes(result).includes("MISSING_WORKSHEET"), name);
  }
  const renames = [
    ["Plan Setup", "PlanSetup"],
    ["Plan Setup", "Plan  Setup"],
    ["Assets", "Asset"],
    ["Income & Expenses", "Income and Expenses"],
    ["Timeline Overrides", "Timeline"],
  ];
  for (const [from, to] of renames) {
    const { result } = await importWorkbook((workbook) => {
      sheetOf(workbook, from).name = to;
    });
    assert.equal(result.isValid, false, to);
    assert.ok(codes(result).includes("MISSING_WORKSHEET"), to);
  }
  const hiddenReserved = await importWorkbook((workbook) => {
    workbook.addWorksheet("Notes Helper").state = "hidden";
    workbook.addWorksheet("plansetup").state = "veryHidden";
  });
  assert.equal(hiddenReserved.result.errors.filter((e) => e.code === "CONFLICTING_WORKSHEET").length, 2);
  const hiddenRequired = await importWorkbook((workbook) => {
    sheetOf(workbook, "Assets").state = "hidden";
  });
  assert.ok(codes(hiddenRequired.result).includes("CONFLICTING_WORKSHEET"));
});

test("heading problems block import", needsExcel, async () => {
  const header = (workbook, name, column) => sheetOf(workbook, name).getCell(3, column);
  let { result } = await importWorkbook((workbook) => {
    header(workbook, "Plan Setup", 3).value = null;
  });
  assert.ok(codes(result).includes("MISSING_HEADER"));
  ({ result } = await importWorkbook((workbook) => {
    header(workbook, "Assets", 6).value = "Field Id";
  }));
  assert.ok(codes(result).includes("MISSING_HEADER"));
  assert.ok(codes(result).includes("INVALID_HEADER"));
  assert.ok(codes(result).includes("MISSING_FIELD_ID_COLUMN"));
  ({ result } = await importWorkbook((workbook) => {
    header(workbook, "Income & Expenses", 5).value = "Value";
  }));
  assert.ok(codes(result).includes("DUPLICATE_HEADER"));
  ({ result } = await importWorkbook((workbook) => {
    sheetOf(workbook, "Timeline Overrides").getCell(7, 4).value = "Spend";
  }));
  assert.ok(codes(result).includes("MISSING_HEADER"));
  assert.ok(codes(result).includes("INVALID_TIMELINE_STRUCTURE"));
  ({ result } = await importWorkbook((workbook) => {
    sheetOf(workbook, "Timeline Overrides").getCell(7, 3).value = "Age";
  }));
  assert.ok(codes(result).includes("DUPLICATE_HEADER"));
});

test("Field ID problems are reported with location and code", needsExcel, async () => {
  const idCell = (workbook, fieldId) =>
    sheetOf(workbook, "Plan Setup").getCell(rowOfFieldId(workbook, "Plan Setup", fieldId), 6);
  let { result } = await importWorkbook((workbook) => {
    idCell(workbook, "currentAge").value = null;
  });
  assert.ok(codes(result).includes("MISSING_REQUIRED_FIELD_ID"));
  ({ result } = await importWorkbook((workbook) => {
    idCell(workbook, "currentAge").value = "lifeExpectancy";
  }));
  assert.ok(codes(result).includes("DUPLICATE_FIELD_ID"));
  assert.ok(codes(result).includes("MISSING_REQUIRED_FIELD_ID"));
  ({ result } = await importWorkbook((workbook) => {
    idCell(workbook, "currentAge").value = "age";
  }));
  const unsupported = plain(result.errors).find((e) => e.code === "UNSUPPORTED_FIELD_ID");
  assert.equal(unsupported.worksheet, "Plan Setup");
  assert.equal(unsupported.fieldId, "age");
  assert.ok(unsupported.row > 3 && unsupported.column === 6);
  ({ result } = await importWorkbook((workbook) => {
    idCell(workbook, "currentAge").value = 42;
  }));
  assert.ok(codes(result).includes("UNSUPPORTED_FIELD_ID"));
  ({ result } = await importWorkbook((workbook) => {
    idCell(workbook, "currentAge").value = "legacyCurrentAge";
  }));
  assert.ok(codes(result).includes("UNSUPPORTED_FIELD_ID"));
  ({ result } = await importWorkbook((workbook) => {
    sheetOf(workbook, "Plan Setup").getCell(4, 1).value = "Wrong Section";
  }));
  assert.ok(codes(result).includes("STRUCTURAL_VALIDATION_FAILED"));
});

test("a field on the wrong worksheet is reported", needsExcel, async () => {
  const { result } = await importWorkbook((workbook) => {
    const assets = sheetOf(workbook, "Assets");
    assets.getCell(assets.rowCount + 1, 6).value = "annualSalary";
  });
  assert.ok(codes(result).includes("FIELD_ID_WRONG_WORKSHEET"));
});

test("prohibited and read-only Field IDs are rejected", needsExcel, async () => {
  const ids = [
    "socialSecurityEstimatedBenefit", "readinessScore", "totalAssets",
    "annualSavingsRate", "recommendedClaimAge", "fundingGap",
  ];
  for (const id of ids) {
    const { result } = await importWorkbook((workbook) => {
      const sheet = sheetOf(workbook, "Plan Setup");
      sheet.getCell(sheet.rowCount + 1, 6).value = id;
    });
    assert.ok(codes(result).includes("PROHIBITED_FIELD_ID"), id);
  }
  const { result } = await importWorkbook((workbook) => {
    sheetOf(workbook, "Timeline Overrides").getCell(6, 8).value = "projectedAssets";
  });
  assert.ok(codes(result).includes("PROHIBITED_FIELD_ID"));
});

test("timeline output columns and wrong Field IDs are rejected", needsExcel, async () => {
  let { result } = await importWorkbook((workbook) => {
    sheetOf(workbook, "Timeline Overrides").getCell(7, 8).value = "Ending Portfolio Balance";
  });
  assert.ok(codes(result).includes("INVALID_TIMELINE_STRUCTURE"));
  ({ result } = await importWorkbook((workbook) => {
    sheetOf(workbook, "Timeline Overrides").getCell(6, 3).value = "timelineOverrides.expenses";
  }));
  assert.ok(codes(result).includes("INVALID_TIMELINE_STRUCTURE"));
});

test("formulas in importable cells are rejected, including cached results", needsExcel, async () => {
  const cases = [
    (workbook) => { valueCell(workbook, "Assets", "assets.cash").value = { formula: "1+1", result: 2 }; },
    (workbook) => { sheetOf(workbook, "Timeline Overrides").getCell(8, 4).value = { formula: "A8*2", result: 0 }; },
    (workbook) => { sheetOf(workbook, "Timeline Overrides").getCell(9, 1).value = { formula: "A8+1", result: 1 }; },
  ];
  for (const mutate of cases) {
    const { result, ui } = await importWorkbook(mutate);
    const formula = plain(result.errors).find((e) => e.code === "FORMULA_IN_IMPORTABLE_CELL");
    assert.ok(formula);
    assert.equal(formula.message, wm.WORKBOOK_IMPORT_MESSAGES.formula);
    assert.ok(formula.row > 0 && formula.column > 0);
    assert.equal(result.workbook, null);
    assert.equal(wm.getPending(), null);
    assert.equal(ui.log.statuses.at(-1), wm.WORKBOOK_IMPORT_MESSAGES.failure);
  }
  const { result } = await importWorkbook((workbook) => {
    valueCell(workbook, "Assets", "assets.cash").value = { formula: "1+1", result: 2 };
  });
  assert.equal(plain(result.errors).find((e) => e.code === "FORMULA_IN_IMPORTABLE_CELL").fieldId, "assets.cash");
});

test("formulas outside importable cells do not block import", needsExcel, async () => {
  const { result } = await importWorkbook((workbook) => {
    sheetOf(workbook, "Instructions").getCell("D1").value = { formula: "1+1", result: 2 };
  });
  assert.equal(result.isValid, true);
});

test("file selection problems use the specified codes and messages", async () => {
  const messages = wm.WORKBOOK_IMPORT_MESSAGES;
  const cases = [
    [[{ name: "plan.csv", size: 10 }], "UNSUPPORTED_FILE_TYPE", messages.unsupportedType],
    [[{ name: "plan.xlsx.txt", size: 10 }], "UNSUPPORTED_FILE_TYPE", messages.unsupportedType],
    [[{ name: "a.xlsx", size: 10 }, { name: "b.xlsx", size: 10 }], "UNSUPPORTED_FILE_TYPE", messages.unsupportedType],
    [[{ name: "plan.xlsx", size: 0 }], "EMPTY_FILE", messages.empty],
    [[{ name: "plan.xlsx", size: wm.WORKBOOK_IMPORT_MAX_BYTES + 1 }], "FILE_TOO_LARGE", messages.tooLarge],
  ];
  for (const [files, code, message] of cases) {
    const ui = recordingUi();
    const result = await wm.handleWorkbookSelection(files, { ui, excelApi: ExcelJS });
    assert.equal(result.errors[0].code, code);
    assert.equal(ui.log.statuses.at(-1), message);
    assert.equal(result.isValid, false);
  }
  assert.equal(wm.validateWorkbookFileSelection([{ name: "UPPER.XLSX", size: wm.WORKBOOK_IMPORT_MAX_BYTES }]).code, null);
  assert.equal(wm.validateWorkbookFileSelection([]).code, "NO_FILE_SELECTED");
});

test("unreadable and corrupted files are rejected safely", async () => {
  const unreadable = { name: "plan.xlsx", size: 10, arrayBuffer: async () => { throw new Error("boom stack"); } };
  const corrupt = { name: "plan.xlsx", size: 10, arrayBuffer: async () => Buffer.from("not a zip file").buffer };
  const zipLike = {
    name: "plan.xlsx",
    size: 10,
    arrayBuffer: async () => Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]).buffer,
  };
  const cases = [[unreadable, "FILE_READ_FAILED"], [corrupt, "WORKBOOK_PARSE_FAILED"], [zipLike, "WORKBOOK_PARSE_FAILED"]];
  for (const [file, code] of cases) {
    const ui = recordingUi();
    const result = await wm.handleWorkbookSelection([file], { ui, excelApi: ExcelJS });
    assert.equal(result.errors[0].code, code);
    assert.equal(ui.log.statuses.at(-1), wm.WORKBOOK_IMPORT_MESSAGES.unreadable);
    assert.ok(!JSON.stringify(plain(result)).includes("boom"));
  }
});

test("cancelling the picker is a no-op", needsExcel, async () => {
  await importWorkbook();
  const before = wm.getPending();
  const ui = recordingUi();
  assert.equal(await wm.handleWorkbookSelection([], { ui }), null);
  assert.equal(await wm.handleWorkbookSelection(null, { ui }), null);
  assert.deepEqual(plain(ui.log), { statuses: [], details: [] });
  assert.equal(wm.getPending(), before);
});

test("the same workbook can be selected repeatedly", needsExcel, async () => {
  const workbook = wm.buildBlankPlanningWorkbook(ExcelJS);
  fillSamplePlan(workbook);
  const file = await toFile(workbook);
  const applied = [];
  const deps = { ui: recordingUi(), excelApi: ExcelJS, applyProfile: (profile) => applied.push(profile) };
  const first = await wm.handleWorkbookSelection([file], deps);
  const second = await wm.handleWorkbookSelection([file], deps);
  assert.ok(first.isValid && second.isValid);
  assert.equal(applied.length, 0);
});

test("an invalid workbook is never applied", needsExcel, async () => {
  const { result, applied } = await importWorkbook((workbook) => workbook.removeWorksheet(sheetOf(workbook, "Assets").id));
  assert.equal(result.isValid, false);
  assert.equal(applied.length, 0);
  assert.equal(wm.getPending(), null);
});

test("validation never changes plan state, runs calculations, or navigates", needsExcel, async () => {
  const profileBefore = JSON.stringify(plain(wm.getProfile()));
  const pageBefore = wm.getPage();
  const calcBefore = sandbox.calcCalls;
  const mutations = [
    () => {},
    (workbook) => workbook.removeWorksheet(sheetOf(workbook, "Assets").id),
    (workbook) => { valueCell(workbook, "Assets", "assets.cash").value = { formula: "1", result: 1 }; },
    (workbook) => { valueCell(workbook, "Assets", "assets.cash").value = 777777; },
  ];
  for (const mutate of mutations) await importWorkbook(mutate);
  assert.equal(JSON.stringify(plain(wm.getProfile())), profileBefore);
  assert.equal(wm.getPage(), pageBefore);
  assert.equal(sandbox.calcCalls, calcBefore);
  assert.deepEqual(plain(wm.getProfile().timelineOverrides), {});
});

test("import source avoids workbook HTML, formula evaluation, uploads, and value logging", () => {
  const source = read("workbookImport.js").replace(/\/\/.*$/gm, "");
  const forbidden = /innerHTML|insertAdjacentHTML|fetch\(|XMLHttpRequest|console\.|eval\(|workingProfile|SAMPLE_PROFILE|calculate\(|localStorage/;
  assert.ok(!forbidden.test(source));
});

test("generated workbooks declare no helper sheets", () => {
  assert.deepEqual(plain(wm.WORKBOOK_HELPER_SHEET_NAMES), []);
});
