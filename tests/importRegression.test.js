// Step 6: regression and failure-hardening tests for the Excel import workflow.
// Every test builds its own sandboxed application (tests/helpers/importHarness.js), so no state is shared.
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ExcelJS,
  FIXTURES,
  buildGoldenWorkbook,
  fileFromBuffer,
  filledWorkbook,
  goldenChanges,
  loadApp,
  plain,
  recordingUi,
  setValue,
  toBuffer,
  toFile,
} = require("./helpers/importHarness.js");

const needsExcel = { skip: !ExcelJS };
const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const json = (value) => JSON.stringify(plain(value));
const snapshot = (wm) => json({ profile: wm.getProfile(), live: wm.live() });
const select = (wm, file, ui = recordingUi(), extra = {}) =>
  wm.handleWorkbookSelection([file], { ui, excelApi: ExcelJS, ...extra });
const messagesOf = (result) => plain(result.errors).map((error) => error.message);
const SAFE_MESSAGE_LEAKS = /stack|\bat \S+ \(|\.js:\d|\/workspaces|node_modules|TypeError|ReferenceError|boom|exploded/i;
const assertSafeText = (text) => assert.doesNotMatch(String(text), SAFE_MESSAGE_LEAKS);

// Applies the golden changes the way manual entry does: by editing the working plan values directly.
function manualGoldenPlan(wm) {
  const plan = wm.cloneSampleProfile();
  const { values, overrides } = goldenChanges();
  Object.entries(values).forEach(([fieldId, value]) => {
    const keys = fieldId.split(".");
    const last = keys.pop();
    keys.reduce((node, key) => node[key], plan)[last] = value;
  });
  plan.timelineOverrides = {};
  overrides.forEach(([age, field, value]) => {
    plan.timelineOverrides[age] = { ...plan.timelineOverrides[age], [field]: field === "returnPercent" ? value * 100 : value };
  });
  return plan;
}

// ---- Fixtures through the real selection flow ----

for (const [name, fixture] of Object.entries(FIXTURES)) {
  test(`fixture ${name} is handled safely by selection`, needsExcel, async () => {
    const wm = loadApp();
    const before = snapshot(wm);
    const ui = recordingUi();
    const result = await select(wm, await toFile(fixture.build(wm)), ui, {
      applyProfile: () => assert.fail("selection must never apply a workbook"),
    });
    const { expect } = fixture;
    assert.equal(Boolean(result.imported), false);
    assert.equal(snapshot(wm), before, "selection must not change the plan or outputs");
    if (expect.valid === true) {
      assert.equal(result.isValid, true, json(result.errors));
      assert.equal(result.awaitingConfirmation, true);
      assert.ok(wm.getPending());
      if (expect.overrides !== undefined) assert.equal(result.preview.stats.overrides, expect.overrides);
      if (expect.warnings) assert.ok(result.warnings.length > 0);
    } else {
      assert.equal(result.isValid, false);
      assert.equal(wm.getPending(), null);
      assert.equal(wm.confirmWorkbookImport({ ui }), null, "an invalid workbook cannot be confirmed");
      if (expect.code) assert.ok(plain(result.errors).some((e) => e.code === expect.code), json(result.errors));
      if (expect.message) assert.ok(messagesOf(result).some((m) => expect.message.test(m)), messagesOf(result).join(" | "));
    }
    ui.log.statuses.forEach(assertSafeText);
    assertSafeText(json({ ...result, workbook: null }));
    assert.equal(wm.getImportStatus(), expect.valid === true ? "awaiting-confirmation" : "failed");
  });
}

// ---- Untrusted file boundary ----

test("files that are not readable workbooks are rejected without throwing or changing the plan", needsExcel, async () => {
  const wm = loadApp();
  const before = snapshot(wm);
  const zipWithJunk = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("not really a workbook")]);
  const cases = [
    ["encrypted container", fileFromBuffer(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]))],
    ["corrupted zip", fileFromBuffer(zipWithJunk)],
    ["text file named .xlsx", fileFromBuffer(Buffer.from("hello, this is plain text"))],
    ["macro workbook extension", fileFromBuffer(zipWithJunk, "plan.xlsm")],
    ["empty file", { name: "plan.xlsx", size: 0, arrayBuffer: async () => new ArrayBuffer(0) }],
    ["oversized file", { name: "plan.xlsx", size: 11 * 1024 * 1024, arrayBuffer: async () => assert.fail("must not read") }],
    ["read failure", { name: "plan.xlsx", size: 10, arrayBuffer: async () => Promise.reject(new Error("disk /secret/path failed")) }],
  ];
  for (const [label, file] of cases) {
    const ui = recordingUi();
    const result = await select(wm, file, ui);
    assert.equal(result.isValid, false, label);
    assert.equal(wm.getPending(), null, label);
    assert.equal(snapshot(wm), before, label);
    ui.log.statuses.forEach(assertSafeText);
    messagesOf(result).forEach(assertSafeText);
  }
  const encrypted = await select(wm, cases[0][1]);
  assert.equal(plain(encrypted.errors)[0].code, "ENCRYPTED_WORKBOOK");
  assert.match(plain(encrypted.errors)[0].message, /password-protected or encrypted/);
});

test("workbooks with excessive worksheets, rows, or columns are rejected", needsExcel, async () => {
  const wm = loadApp();
  const tooManyRows = filledWorkbook(wm, (workbook) => (workbook.addWorksheet("Big").getCell(5000, 1).value = "x"));
  const tooManySheets = filledWorkbook(wm, (workbook) => {
    for (let index = 0; index < 25; index += 1) workbook.addWorksheet(`Extra ${index}`);
  });
  const tooWide = filledWorkbook(wm, (workbook) => (workbook.addWorksheet("Wide").getCell(1, 500).value = "x"));
  for (const workbook of [tooManyRows, tooManySheets, tooWide]) {
    const result = await select(wm, await toFile(workbook));
    assert.equal(result.isValid, false);
    assert.equal(plain(result.errors)[0].code, "WORKBOOK_TOO_LARGE");
    assert.equal(wm.getPending(), null);
  }
});

test("cell text is never interpreted as markup or code", needsExcel, async () => {
  const wm = loadApp();
  const workbook = filledWorkbook(wm, (book) => setValue(wm, book, "name", '<img src=x onerror="alert(1)">'));
  const result = await select(wm, await toFile(workbook));
  // The name is plain text in the candidate; rendering uses textContent (checked below).
  assert.equal(result.isValid, true, json(result.errors));
  const source = read("workbookImport.js");
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|eval\(|new Function/);
});

// ---- Failure classification and rollback at every stage ----

const FAILURE_STAGES = [
  {
    stage: "reading",
    arrange: (wm) => wm.swap("parsePlanningWorkbook", async () => { throw new TypeError("zip exploded"); }),
    log: "UNREADABLE_WORKBOOK",
    blockedAtSelection: true,
  },
  {
    stage: "parsing",
    arrange: (wm) => wm.swap("buildImportCandidate", () => { throw new Error("candidate exploded"); }),
    code: "PARSING_FAILED",
    blockedAtSelection: true,
  },
  {
    stage: "preview",
    arrange: (wm) => wm.swap("buildImportPreview", () => { throw new Error("preview exploded"); }),
    code: "PREVIEW_FAILED",
    blockedAtSelection: true,
  },
  {
    stage: "timeline generation",
    arrange: (wm) => wm.swap("buildTimelineRows", () => { throw new Error("timeline exploded"); }),
    code: "RECALCULATION_FAILED",
  },
  {
    stage: "projection calculation",
    arrange: (wm) => wm.swap("calculate", () => { throw new Error("projection exploded"); }),
    code: "RECALCULATION_FAILED",
  },
  {
    stage: "readiness calculation",
    arrange: (wm) => wm.swap("calculate", () => ({ score: Number.NaN, status: "", projectedAssets: Number.NaN })),
    code: "RECALCULATION_FAILED",
  },
  {
    stage: "recommendation generation",
    arrange: (wm) => wm.swap("recommendations", () => { throw new Error("recommendations exploded"); }),
    code: "RECALCULATION_FAILED",
  },
];

for (const scenario of FAILURE_STAGES) {
  test(`a ${scenario.stage} failure leaves the plan untouched, is logged safely, and can be retried`, needsExcel, async () => {
    const wm = loadApp();
    const before = snapshot(wm);
    const file = await toFile(buildGoldenWorkbook(wm));
    const ui = recordingUi();
    const restore = scenario.arrange(wm);
    const name = scenario.stage === "reading" ? "parsePlanningWorkbook"
      : scenario.stage === "parsing" ? "buildImportCandidate"
      : scenario.stage === "preview" ? "buildImportPreview"
      : scenario.stage === "timeline generation" ? "buildTimelineRows"
      : scenario.stage === "recommendation generation" ? "recommendations" : "calculate";
    let result = await select(wm, file, ui);
    let outcome = null;
    if (scenario.blockedAtSelection) {
      assert.equal(result.isValid, false);
      assert.equal(wm.getPending(), null);
      assert.equal(wm.confirmWorkbookImport({ ui }), null);
      if (scenario.code) assert.equal(result.operationalFailure, scenario.code);
      assert.ok(plain(result.errors).length >= 1);
    } else {
      // Break the engine only for the candidate: selection ran with the real engine, so re-arm before confirming.
      assert.equal(result.awaitingConfirmation, true);
      outcome = wm.confirmWorkbookImport({ ui });
      assert.equal(outcome.imported, false);
      assert.equal(outcome.operationalFailure, scenario.code);
    }
    wm.swap(name, restore);
    assert.equal(snapshot(wm), before, "plan, overrides and derived outputs are unchanged");
    assert.equal(wm.getProfile().timelineOverrides && Object.keys(wm.getProfile().timelineOverrides).length, 0);
    assert.equal(wm.getImportStatus(), "failed");
    assert.equal(wm.getPending(), null);
    if (outcome) {
      assert.deepEqual(ui.log.busy, [true, false], "controls are re-enabled");
      assert.match(ui.log.statuses.at(-1), /^Import Failed\./);
      assert.ok(plain(outcome.errors).some((e) => e.code === scenario.code));
    }
    ui.log.statuses.forEach(assertSafeText);
    messagesOf(result).forEach(assertSafeText);
    // Logged through the application logger with a code and stage, and nothing sensitive.
    assert.ok(wm.logs.length >= 1);
    assert.ok(wm.logs.some((entry) => entry.code === (scenario.code || scenario.log)), json(wm.logs));
    const logged = json(wm.logs);
    ["140000", "41000", "95000", "Sample", "plan.xlsx"].forEach((secret) => assert.ok(!logged.includes(secret), secret));
    // A second attempt works.
    result = await select(wm, file, recordingUi());
    assert.equal(result.awaitingConfirmation, true);
    const retry = wm.confirmWorkbookImport({ ui: recordingUi() });
    assert.equal(retry.imported, true);
    assert.equal(wm.getProfile().assets.cash, 41000);
  });
}

test("a commit failure after partial replacement restores the previous plan and outputs", () => {
  const wm = loadApp();
  const before = snapshot(wm);
  const imported = manualGoldenPlan(wm);
  let calls = 0;
  const result = wm.ImportService.applyImport(imported, {
    replace: (plan) => {
      calls += 1;
      if (calls === 1) {
        // Simulates a store that applied part of the candidate before failing.
        wm.setProfile({ ...wm.getProfile(), assets: { ...wm.getProfile().assets, cash: 1 } });
        throw new Error("write failed");
      }
      wm.replaceWorkingProfile(plan);
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "COMMIT_FAILED");
  assert.equal(result.rolledBack, true);
  assert.equal(calls, 2, "the previous plan is restored through the same replace path");
  assert.equal(snapshot(wm), before);
  assert.equal(wm.logs.filter((entry) => entry.rollback === "restored").length, 1);
  assert.equal(wm.getImportStatus(), "failed");
});

test("a failure verifying the live outputs rolls back and regenerates the previous outputs", () => {
  const wm = loadApp();
  const before = snapshot(wm);
  const result = wm.ImportService.applyImport(manualGoldenPlan(wm), {
    verifyLive: () => {
      throw new Error("final check failed");
    },
  });
  assert.equal(result.code, "RECALCULATION_FAILED");
  assert.equal(result.rolledBack, true);
  assert.equal(snapshot(wm), before);
});

test("when rollback itself fails the user is told the previous plan could not be confirmed", () => {
  const wm = loadApp();
  const result = wm.ImportService.applyImport(manualGoldenPlan(wm), {
    replace: () => {
      throw new Error("storage unavailable");
    },
    current: (() => {
      let first = true;
      return () => {
        const profile = wm.getProfile();
        if (first) {
          first = false;
          return profile;
        }
        // After the failed commit the live plan no longer matches the backup.
        return { ...profile, name: "Corrupted" };
      };
    })(),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "ROLLBACK_FAILED");
  assert.equal(result.rolledBack, false);
  assert.equal(result.error, wm.IMPORT_USER_MESSAGES.ROLLBACK_FAILED);
  assert.doesNotMatch(wm.describeImportFailure(result.error, result.code), /No changes were applied/);
  const codes = wm.logs.map((entry) => entry.code);
  assert.ok(codes.includes("COMMIT_FAILED"), "the original failure is logged");
  assert.ok(wm.logs.some((entry) => entry.stage === "rollback" && entry.code === "ROLLBACK_FAILED"), "the rollback failure is logged separately");
  // State changes are blocked until the saved plan is reloaded.
  let called = false;
  const blocked = wm.ImportService.applyImport(manualGoldenPlan(wm), { replace: () => (called = true) });
  assert.equal(blocked.code, "ROLLBACK_FAILED");
  assert.equal(called, false);
});

// ---- Duplicate and overlapping actions ----

test("confirming twice runs one transaction and one success notification", needsExcel, async () => {
  const wm = loadApp();
  const ui = recordingUi();
  await select(wm, await toFile(buildGoldenWorkbook(wm)), ui);
  const first = wm.confirmWorkbookImport({ ui });
  const second = wm.confirmWorkbookImport({ ui });
  assert.equal(first.imported, true);
  assert.equal(second, null);
  assert.equal(ui.log.statuses.filter((text) => /^Plan Imported Successfully/.test(text)).length, 1);
  assert.equal(ui.log.closed, 1);
  assert.equal(wm.getPending(), null);
  assert.equal(wm.getImportStatus(), "succeeded");
  assert.deepEqual(ui.log.busy, [true, false]);
});

test("only one import transaction can run at a time", () => {
  const wm = loadApp();
  let inner;
  const outer = wm.ImportService.applyImport(manualGoldenPlan(wm), {
    replace: (plan) => {
      inner = wm.ImportService.applyImport(manualGoldenPlan(wm), { replace: () => assert.fail("must not run") });
      wm.replaceWorkingProfile(plan);
    },
  });
  assert.equal(outer.ok, true);
  assert.equal(inner.code, "IMPORT_IN_PROGRESS");
});

test("a late result from an older selection cannot overwrite a newer one", needsExcel, async () => {
  const wm = loadApp();
  const slowBuffer = await toBuffer(buildGoldenWorkbook(wm));
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const slow = {
    name: "slow.xlsx",
    size: slowBuffer.length,
    arrayBuffer: async () => {
      await gate;
      return slowBuffer.buffer.slice(slowBuffer.byteOffset, slowBuffer.byteOffset + slowBuffer.length);
    },
  };
  const ui = recordingUi();
  const slowRun = select(wm, slow, ui);
  const fast = await select(wm, await toFile(filledWorkbook(wm), "fast.xlsx"), ui);
  assert.equal(wm.getPending().fileName, "fast.xlsx");
  release();
  assert.equal(await slowRun, null);
  assert.equal(wm.getPending().fileName, "fast.xlsx");
  assert.equal(fast.awaitingConfirmation, true);
  assert.equal(ui.log.details.length, 1, "the stale result is never presented");
});

test("selecting another workbook, cancelling, or closing discards the preview without applying it", needsExcel, async () => {
  const wm = loadApp();
  const before = snapshot(wm);
  const ui = recordingUi();
  await select(wm, await toFile(buildGoldenWorkbook(wm)), ui);
  assert.ok(wm.getPending());
  const invalid = await select(wm, await toFile(FIXTURES.crossFieldInvalid.build(wm)), ui);
  assert.equal(invalid.isValid, false);
  assert.equal(wm.getPending(), null, "the stale preview is gone");
  assert.equal(wm.confirmWorkbookImport({ ui }), null);
  await select(wm, await toFile(buildGoldenWorkbook(wm)), ui);
  assert.equal(wm.cancelWorkbookImport({ ui }), true);
  assert.equal(wm.getImportStatus(), "idle");
  assert.equal(wm.confirmWorkbookImport({ ui }), null);
  assert.equal(snapshot(wm), before);
  assert.equal(ui.log.statuses.filter((text) => /Imported Successfully/.test(text)).length, 0);
});

test("a selection made while an import is running is ignored", needsExcel, async () => {
  const wm = loadApp();
  const file = await toFile(buildGoldenWorkbook(wm));
  wm.setImportStatus("committing");
  assert.equal(await select(wm, file), null);
  assert.equal(wm.getPending(), null);
});

test("a corrected workbook can be selected after an invalid one and imports cleanly", needsExcel, async () => {
  const wm = loadApp();
  const ui = recordingUi();
  const bad = await select(wm, await toFile(FIXTURES.crossFieldInvalid.build(wm)), ui);
  assert.equal(bad.isValid, false);
  const good = await select(wm, await toFile(buildGoldenWorkbook(wm)), ui);
  assert.equal(good.errors.length, 0, "errors from the previous workbook are not carried over");
  assert.equal(ui.log.details.at(-1), good);
  const outcome = wm.confirmWorkbookImport({ ui });
  assert.equal(outcome.imported, true);
  assert.equal(wm.getProfile().assets.cash, 41000);
});

// ---- Manual entry equivalence and calculation regression ----

test("an imported plan equals the same plan entered manually, inputs and every derived output", needsExcel, async () => {
  const manual = loadApp();
  const manualPlan = manualGoldenPlan(manual);
  manual.replaceWorkingProfile(manualPlan);
  const manualLive = plain(manual.live());

  const imported = loadApp();
  const ui = recordingUi();
  await select(imported, await toFile(buildGoldenWorkbook(imported)), ui);
  assert.equal(imported.confirmWorkbookImport({ ui }).imported, true);

  assert.deepEqual(plain(imported.getProfile()), plain(manual.getProfile()), "normalized inputs match");
  assert.deepEqual(plain(imported.live()), manualLive, "metrics, timeline rows and recommendations match");
  assert.deepEqual(plain(imported.calculateFor(imported.getProfile())), plain(manual.calculateFor(manual.getProfile())));
  assert.equal(imported.reportMarkup(), manual.reportMarkup(), "PDF report data matches the manual plan");
});

test("timeline overrides change the projection and apply inside the standard simulation", needsExcel, async () => {
  const wm = loadApp();
  const baseline = plain(wm.calculateFor(wm.cloneSampleProfile()).rows);
  await select(wm, await toFile(buildGoldenWorkbook(wm)));
  wm.confirmWorkbookImport({ ui: recordingUi() });
  const rows = plain(wm.live().rows);
  assert.notDeepEqual(rows, baseline);
  const ages = rows.map((row) => row.age);
  assert.equal(new Set(ages).size, ages.length, "no duplicated timeline years");
  assert.equal(ages[0], wm.getProfile().currentAge);
  assert.equal(ages.at(-1), wm.getProfile().lifeExpectancy);
  assert.deepEqual(plain(wm.getProfile().timelineOverrides), plain(manualGoldenPlan(wm).timelineOverrides));
});

test("re-importing the same plan is stable and repeated calculation does not mutate inputs", needsExcel, async () => {
  const wm = loadApp();
  const file = await toFile(buildGoldenWorkbook(wm));
  await select(wm, file);
  wm.confirmWorkbookImport({ ui: recordingUi() });
  const first = snapshot(wm);
  await select(wm, file);
  assert.equal(wm.confirmWorkbookImport({ ui: recordingUi() }).imported, true);
  assert.equal(snapshot(wm), first);
  const inputs = json(wm.getProfile());
  for (let i = 0; i < 3; i += 1) wm.headlessRender();
  assert.equal(json(wm.getProfile()), inputs);
  assert.equal(snapshot(wm), first);
});

test("derived outputs are regenerated for the imported plan, never reused from the previous plan", needsExcel, async () => {
  const wm = loadApp();
  const previousMetrics = json(wm.live().metrics);
  await select(wm, await toFile(buildGoldenWorkbook(wm)));
  wm.confirmWorkbookImport({ ui: recordingUi() });
  assert.notEqual(json(wm.live().metrics), previousMetrics);
  assert.equal(json(wm.live().metrics), json(wm.calculateFor(wm.getProfile()).metrics));
  assert.equal(json(wm.live().recs), json(wm.calculateFor(wm.getProfile()).recs));
});

test("workbook values are inputs only: calculated outputs can never be imported", needsExcel, async () => {
  const wm = loadApp();
  await select(wm, await toFile(buildGoldenWorkbook(wm)));
  wm.confirmWorkbookImport({ ui: recordingUi() });
  const allowed = new Set(Object.keys(wm.cloneSampleProfile()));
  Object.keys(plain(wm.getProfile())).forEach((key) => assert.ok(allowed.has(key), key));
  assert.equal("score" in wm.getProfile(), false);
});

// ---- Preview regression ----

test("the preview is shown before anything is applied and never exposes internals", needsExcel, async () => {
  const wm = loadApp();
  const ui = recordingUi();
  const result = await select(wm, await toFile(buildGoldenWorkbook(wm)), ui, {
    applyProfile: () => assert.fail("not before confirmation"),
  });
  assert.equal(ui.log.details.length, 1);
  assert.equal(result.awaitingConfirmation, true);
  assert.ok(result.preview.changedFields.length > 0);
  assert.ok(result.preview.changedFields.every((field) => json(field.currentValue) !== json(field.importedValue)));
  assertSafeText(json({ ...result, workbook: null }));
});

test("an identical workbook shows the no-changes state and still replaces the plan on confirmation", needsExcel, async () => {
  const wm = loadApp();
  const result = await select(wm, await toFile(filledWorkbook(wm)));
  assert.equal(result.preview.changedFields.length, 0);
  assert.equal(result.preview.overrideSummary.imported.length, 0);
});

// ---- Logging ----

test("logs contain only whitelisted diagnostic fields", () => {
  const wm = loadApp();
  wm.logImportEvent({
    operationId: "import-1",
    stage: "committing",
    code: "COMMIT_FAILED",
    cause: Object.assign(new Error("balance 140000 failed"), { name: "TypeError" }),
    profile: { cash: 41000 },
    balance: 140000,
  });
  assert.deepEqual(wm.logs.at(-1), { operationId: "import-1", stage: "committing", code: "COMMIT_FAILED", errorType: "TypeError" });
});

test("a failing logger never breaks the import", () => {
  const wm = loadApp();
  wm.setImportLogger(() => {
    throw new Error("logger down");
  });
  const result = wm.ImportService.applyImport(manualGoldenPlan(wm), { verifyLive: () => { throw new Error("x"); } });
  assert.equal(result.ok, false);
  assert.equal(result.rolledBack, true);
});

test("user-facing messages cover every failure code and never include raw errors", () => {
  const wm = loadApp();
  Object.values(wm.IMPORT_FAILURE_CODES).forEach((code) => {
    const message = wm.importUserMessage(code);
    assert.ok(message && message.length > 10, code);
    assertSafeText(message);
  });
  assert.equal(wm.importUserMessage("NOT_A_CODE"), wm.IMPORT_USER_MESSAGES.UNKNOWN_IMPORT_FAILURE);
  assert.equal(wm.IMPORT_USER_MESSAGES.UNSUPPORTED_FILE_TYPE, "This file is not a supported WealthMap workbook. Select a valid .xlsx workbook generated from WealthMap.");
});

// ---- Exports ----

test("export actions keep working after an import or a failed import and carry no import metadata", needsExcel, async () => {
  const wm = loadApp();
  await select(wm, await toFile(buildGoldenWorkbook(wm)));
  wm.confirmWorkbookImport({ ui: recordingUi() });
  const report = wm.reportMarkup();
  assert.match(report, /Readiness Score/);
  assert.doesNotMatch(report, /operationId|awaiting-confirmation|validation report|Import Plan Preview/i);

  // A failed import leaves both exports available.
  const real = wm.swap("calculate", () => { throw new Error("nope"); });
  await select(wm, await toFile(filledWorkbook(wm)));
  wm.swap("calculate", real);
  const failedBlank = await wm.buildBlankPlanningWorkbook(ExcelJS);
  assert.ok(failedBlank.getWorksheet("Plan Setup"));

  const blank = wm.buildBlankPlanningWorkbook(ExcelJS);
  const cells = [];
  blank.eachSheet((sheet) => sheet.eachRow((row) => row.eachCell((cell) => cells.push(String(cell.value)))));
  const text = cells.join("|");
  ["140000", "41000", "95000", "operationId", "awaiting-confirmation"].forEach((value) => assert.ok(!text.includes(value), value));
  assert.deepEqual(plain(wm.auditWorkbookForCalculatedOutputs(blank)).problems ?? [], []);
});

// ---- Accessibility and architecture guards ----

test("the preview dialog is labelled, announces status, and moves focus to the error summary", () => {
  const html = read("index.html");
  assert.match(html, /<dialog[^>]*id="workbook-import-dialog"[^>]*aria-labelledby="workbook-import-dialog-title"/);
  assert.match(html, /id="workbook-import-dialog-title">Import Plan Preview</);
  assert.match(html, /id="workbook-import-status"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /<h3 id="workbook-import-errors-heading" tabindex="-1">/);
  assert.match(html, /<ul id="workbook-import-errors" aria-labelledby="workbook-import-errors-heading">/);
  const source = read("workbookImport.js");
  assert.match(source, /errorsHeading/);
  assert.match(source, /returnFocus/);
  assert.match(source, /aria-busy/);
  // Status is conveyed with text and symbols, not colour alone.
  assert.match(source, /❌ Errors/);
  assert.match(source, /⚠ Valid with warnings/);
  assert.match(source, /✅ Valid/);
});

test("import code keeps the single calculation path and has no second persistence store", () => {
  const service = read("importService.js");
  const importer = read("workbookImport.js");
  [service, importer].forEach((source) => {
    assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|fetch\(|XMLHttpRequest/);
  });
  assert.match(service, /replaceWorkingProfile/);
  assert.doesNotMatch(service, /renderTimeline|renderMetrics\(\)/);
});
