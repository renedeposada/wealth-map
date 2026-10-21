// Round-trip regression suite: the real export and import code, joined at the serialized-workbook boundary.
// Failure messages carry only safe metadata (field ids, ages, codes); plan values are never printed.
const test = require("node:test");
const assert = require("node:assert/strict");
const fixtures = require("./helpers/exportFixtures");
const { needsExcel, app, plain, roundTripProfile, diagnostics } = require("./helpers/roundTripHarness");

const TOLERANCE = app.ROUND_TRIP_TOLERANCE;
const inventory = plain(app.buildSupportedInputInventory());
const standardItems = inventory.filter((item) => item.worksheet !== app.WORKBOOK_SHEETS.timeline);
const locations = plain(app.buildWorkbookFieldLocationIndex());
const timelineMap = app.buildWorkbookTimelineOverrideMap();
const pathGet = (object, fieldId) => fieldId.split(".").reduce((node, key) => (node == null ? undefined : node[key]), object);
const close = (a, b) => Math.abs(a - b) < TOLERANCE;

function assertCleanRoundTrip(result) {
  const note = diagnostics(result);
  assert.equal(result.exportValidation.isValid, true, note);
  assert.equal(result.structuralValidation.isValid, true, note);
  assert.equal(result.importValidation.valid, true, note);
  assert.ok(result.candidate && result.candidate.profile, "candidate profile exists");
  assert.equal(result.comparison.success, true, note);
  assert.equal(result.comparison.validationErrors.length, 0, note);
  assert.equal(result.comparison.differences.length, 0, note);
}

async function cleanRoundTrip(profile, options) {
  const result = await roundTripProfile(profile, options);
  assertCleanRoundTrip(result);
  return result;
}

const valueCellOf = (workbook, fieldId) => {
  const location = locations[fieldId];
  return workbook.getWorksheet(location.worksheet).getCell(location.row, location.column);
};
const timelineCellOf = (workbook, age, field) =>
  workbook.getWorksheet(app.WORKBOOK_SHEETS.timeline).getCell(app.workbookTimelineRowNumber(age), timelineMap.columnsByFieldId.get(`timelineOverrides.${field}`));
const overridesOf = (result) => plain(result.candidate.profile.timelineOverrides);

// ---- Harness sanity (no workbook needed) ----

test("tolerance constant and comparison use the shared Step 7 rules", () => {
  assert.equal(TOLERANCE, 0.000001);
  const original = { currentAge: 50 };
  assert.deepEqual(plain(app.compareProfiles(original, { currentAge: 50 + TOLERANCE / 10 })), []);
  assert.equal(plain(app.compareProfiles(original, { currentAge: 50 + TOLERANCE * 10 })).length, 1);
});

// ---- 1. Baseline ----

test("1. default sample profile round-trips through serialized bytes", needsExcel, async () => {
  const result = await cleanRoundTrip(fixtures.sampleProfile());
  assert.ok(result.buffer.length > 0);
  assert.equal(app.validateExportImportRoundTrip(fixtures.sampleProfile()).success, true);
});

// ---- 2. All standard inputs ----

test("2. every supported standard input survives with a non-default value", needsExcel, async () => {
  const profile = fixtures.allInputsProfile();
  const sample = fixtures.sampleProfile();
  const unchangeable = standardItems
    .filter((item) => item.dataType !== "select" || item.allowedValues.length > 1)
    .filter((item) => pathGet(profile, item.fieldId) === pathGet(sample, item.fieldId))
    .map((item) => item.fieldId);
  assert.deepEqual(unchangeable, [], "fixture leaves these inputs at their sample value");
  const result = await cleanRoundTrip(profile);
  standardItems.forEach((item) => {
    const expected = pathGet(profile, item.fieldId);
    const actual = pathGet(result.candidate.profile, item.fieldId);
    const same = typeof expected === "number" ? close(expected, actual) : expected === actual;
    assert.ok(same, `${item.fieldId} survives`);
  });
});

// ---- 3 / 4 / 14 / 15. Timeline overrides ----

test("3. every Timeline override type survives, with return percentages in percentage points", needsExcel, async () => {
  const profile = fixtures.allOverrideTypesProfile();
  const result = await cleanRoundTrip(profile);
  assert.equal(result.exportModel.timelineOverrides.length, 7);
  assert.equal(timelineCellOf(result.parsed, 50, "returnPercent").value, -0.125, "Excel stores a fraction");
  assert.ok(close(overridesOf(result)[50].returnPercent, -12.5), "profile keeps percentage points");
  Object.entries(profile.timelineOverrides).forEach(([age, fields]) =>
    Object.entries(fields).forEach(([field, value]) =>
      assert.ok(close(overridesOf(result)[age][field], value), `override ${age}.${field} survives`),
    ),
  );
  assert.deepEqual(
    plain([...new Set(Object.values(overridesOf(result)).flatMap((fields) => Object.keys(fields)))].sort()),
    plain(app.TIMELINE_OVERRIDE_FIELDS.map((entry) => entry.field).sort()),
  );
});

test("4. boundary percentages 0 and 100% survive in standard fields", needsExcel, async () => {
  for (const make of [fixtures.lowBoundaryPercentProfile, fixtures.highBoundaryPercentProfile]) {
    const profile = make();
    const result = await cleanRoundTrip(profile);
    standardItems
      .filter((item) => item.dataType === "percent")
      .forEach((item) => {
        assert.ok(close(pathGet(profile, item.fieldId), pathGet(result.candidate.profile, item.fieldId)), `${item.fieldId} keeps its decimal fraction`);
      });
  }
});

test("4. Timeline returns of -100, 0 and 100 survive in percentage points", needsExcel, async () => {
  const result = await cleanRoundTrip(fixtures.boundaryReturnOverrideProfile());
  assert.equal(timelineCellOf(result.parsed, 46, "returnPercent").value, -1);
  assert.equal(timelineCellOf(result.parsed, 47, "returnPercent").value, 0);
  assert.equal(timelineCellOf(result.parsed, 48, "returnPercent").value, 1);
  assert.deepEqual([overridesOf(result)[46].returnPercent, overridesOf(result)[47].returnPercent, overridesOf(result)[48].returnPercent], [-100, 0, 100]);
});

test("14. empty Timeline overrides stay empty", needsExcel, async () => {
  const result = await cleanRoundTrip(fixtures.emptyOverrideProfile());
  assert.equal(result.exportModel.timelineOverrides.length, 0);
  assert.deepEqual(overridesOf(result), {});
});

test("15. multiple overrides at several ages survive, independent of record or property order", needsExcel, async () => {
  const profile = fixtures.multiAgeOverrideProfile();
  const result = await cleanRoundTrip(profile);
  const keys = plain(result.exportModel.timelineOverrides).map((record) => `${record.age}:${record.field}`);
  assert.equal(new Set(keys).size, keys.length, "no duplicate age-field records");
  assert.deepEqual(Object.keys(overridesOf(result)).map(Number).sort((a, b) => a - b), [46, 55, 64, 65, 80, 95]);
  const reversed = await cleanRoundTrip(fixtures.multiAgeOverrideProfile(), {
    mutateModel: (model) => model.timelineOverrides.reverse(),
  });
  assert.deepEqual(overridesOf(reversed), overridesOf(result));
});

test("inapplicable overrides are not exported or treated as round-trip inputs", needsExcel, async () => {
  const result = await cleanRoundTrip(fixtures.inapplicableOverrideProfile());
  assert.deepEqual(plain(result.exportModel.timelineOverrides).map((r) => `${r.age}:${r.field}`), ["50:returnPercent"]);
  assert.deepEqual(Object.keys(overridesOf(result)), ["50"]);
});

// ---- 5. Zero and blank semantics ----

test("5. zero stays zero and an empty name stays an empty string", needsExcel, async () => {
  const profile = fixtures.zeroValueProfile();
  const result = await cleanRoundTrip(profile);
  const imported = result.candidate.profile;
  assert.equal(imported.name, "");
  [
    "otherAnnualIncome", "stateIncomeTaxRate", "taxableGainsTaxRate", "preTaxWithdrawalTaxRate", "rothConversionAnnualAmount",
    "socialSecurityAnnualBenefit", "irmaaAnnualSurcharge", "iraContributions.traditionalIraAnnual", "iraContributions.rothIraAnnual",
    "assets.realEstate",
  ].forEach((fieldId) => assert.strictEqual(pathGet(imported, fieldId), 0, `${fieldId} stays 0`));
});

// ---- 6-13. Input families ----

test("6. Social Security automatic mode survives and exports no estimate", needsExcel, async () => {
  const result = await cleanRoundTrip(fixtures.automaticSocialSecurityProfile());
  const imported = result.candidate.profile;
  assert.equal(imported.socialSecurityBenefitMode, "auto");
  assert.equal(imported.socialSecurityStrategy, "manual");
  assert.equal(imported.socialSecurityClaimAge, 67);
  assert.equal(imported.socialSecurityAnnualBenefit, 0);
  assert.ok(!standardItems.some((item) => item.fieldId === "socialSecurityEstimatedBenefit"));
});

test("7. Social Security manual mode survives, with labels in Excel and internal values in the profile", needsExcel, async () => {
  const result = await cleanRoundTrip(fixtures.manualSocialSecurityProfile());
  const imported = result.candidate.profile;
  assert.equal(imported.socialSecurityBenefitMode, "manual");
  assert.equal(imported.socialSecurityAnnualBenefit, 42000);
  assert.equal(imported.socialSecurityClaimAge, 70);
  assert.equal(imported.socialSecurityStrategy, "manual");
  const schema = plain(app.buildPlanningWorkbookSchema());
  const label = (fieldId, value) => schema.find((e) => e.fieldId === fieldId).allowedValues.find((o) => o.value === value).label;
  assert.equal(valueCellOf(result.parsed, "socialSecurityBenefitMode").value, label("socialSecurityBenefitMode", "manual"));
  assert.equal(valueCellOf(result.parsed, "socialSecurityStrategy").value, label("socialSecurityStrategy", "manual"));
});

test("8. model-recommended Social Security strategy survives", needsExcel, async () => {
  const result = await cleanRoundTrip(fixtures.modelRecommendedSocialSecurityProfile());
  assert.equal(result.candidate.profile.socialSecurityStrategy, "auto");
  assert.equal(result.candidate.profile.socialSecurityClaimAge, 64);
});

test("9. automatic and manual Roth conversion strategies survive", needsExcel, async () => {
  const auto = await cleanRoundTrip(fixtures.autoRothConversionProfile());
  assert.equal(auto.candidate.profile.rothConversionStrategy, "auto");
  const manual = await cleanRoundTrip(fixtures.manualRothConversionProfile());
  assert.equal(manual.candidate.profile.rothConversionStrategy, "manual");
  assert.equal(manual.candidate.profile.rothConversionAnnualAmount, 25000);
});

test("10. contribution and allocation settings survive", needsExcel, async () => {
  const profile = fixtures.contributionProfile();
  assert.ok(Math.abs(profile.savingsAllocation.brokerage + profile.savingsAllocation.cash - 1) < TOLERANCE);
  const result = await cleanRoundTrip(profile);
  [
    "contributionRates.fourOhOneK", "employerMatch.rate", "employerMatch.salaryCap", "iraContributions.traditionalIraAnnual",
    "iraContributions.rothIraAnnual", "savingsAllocation.brokerage", "savingsAllocation.cash",
  ].forEach((fieldId) => assert.ok(close(pathGet(profile, fieldId), pathGet(result.candidate.profile, fieldId)), fieldId));
});

test("11. distinct asset balances return to the correct fields", needsExcel, async () => {
  const profile = fixtures.assetProfile();
  const result = await cleanRoundTrip(profile);
  assert.deepEqual(plain(result.candidate.profile.assets), plain(profile.assets));
});

test("12. large values stay finite numbers within tolerance", needsExcel, async () => {
  const profile = fixtures.largeValueProfile();
  const result = await cleanRoundTrip(profile);
  standardItems
    .filter((item) => ["currency", "number"].includes(item.dataType))
    .forEach((item) => {
      const imported = pathGet(result.candidate.profile, item.fieldId);
      assert.equal(typeof imported, "number", `${item.fieldId} stays numeric`);
      assert.ok(Number.isFinite(imported), `${item.fieldId} stays finite`);
      assert.ok(close(imported, pathGet(profile, item.fieldId)), `${item.fieldId} keeps precision`);
    });
});

test("13. decimal values stay within tolerance", needsExcel, async () => {
  await cleanRoundTrip(fixtures.decimalProfile());
});

// ---- 16-19. Intentional mismatches ----

test("16. a changed standard field is reported", needsExcel, async () => {
  const result = await cleanRoundTrip(fixtures.sampleProfile());
  result.candidate.profile.annualSalary += 1;
  const comparison = result.recompare();
  assert.equal(comparison.success, false);
  assert.equal(comparison.differences.length, 1);
  assert.equal(comparison.differences[0].type, "changed");
  assert.equal(comparison.differences[0].fieldId, "annualSalary");
});

test("17. a missing standard field is reported, not defaulted", needsExcel, async () => {
  const result = await cleanRoundTrip(fixtures.sampleProfile());
  delete result.candidate.profile.assets.rothIra;
  const comparison = result.recompare();
  assert.equal(comparison.success, false);
  assert.deepEqual(comparison.differences.map((d) => [d.type, d.fieldId]), [["missing", "assets.rothIra"]]);
});

test("18. a changed Timeline override is reported with its age and field", needsExcel, async () => {
  const result = await cleanRoundTrip(fixtures.allOverrideTypesProfile());
  result.candidate.profile.timelineOverrides[67].extraWithdrawal += 1;
  const comparison = result.recompare();
  assert.equal(comparison.success, false);
  assert.deepEqual(comparison.differences.map((d) => [d.type, d.fieldId]), [["changed", "timelineOverrides.67.extraWithdrawal"]]);
});

test("19. missing Timeline overrides are distinguished from changed ones", needsExcel, async () => {
  const fieldMissing = await cleanRoundTrip(fixtures.allOverrideTypesProfile());
  delete fieldMissing.candidate.profile.timelineOverrides[50].income;
  assert.deepEqual(fieldMissing.recompare().differences.map((d) => [d.type, d.fieldId]), [["missing", "timelineOverrides.50.income"]]);

  const ageMissing = await cleanRoundTrip(fixtures.allOverrideTypesProfile());
  delete ageMissing.candidate.profile.timelineOverrides[67];
  const differences = ageMissing.recompare().differences;
  assert.equal(differences.length, 3);
  assert.ok(differences.every((d) => d.type === "missing" && d.fieldId.startsWith("timelineOverrides.67.")));
});

// ---- 20-23. Validation failures ----

test("20. invalid imported values fail import validation and stop before comparison", needsExcel, async () => {
  const cases = {
    returnAboveHundredPercent: (wb) => (valueCellOf(wb, "expectedAnnualReturn").value = 1.5),
    invalidFilingStatus: (wb) => (valueCellOf(wb, "filingStatus").value = "Not a status"),
    retirementBeforeCurrentAge: (wb) => (valueCellOf(wb, "targetRetirementAge").value = 30),
    allocationNotHundredPercent: (wb) => {
      valueCellOf(wb, "savingsAllocation.brokerage").value = 0.5;
      valueCellOf(wb, "savingsAllocation.cash").value = 0.4;
    },
  };
  for (const [name, mutateWorkbook] of Object.entries(cases)) {
    const result = await roundTripProfile(fixtures.sampleProfile(), { mutateWorkbook });
    assert.equal(result.structuralValidation.isValid, true, name);
    assert.equal(result.importValidation.valid, false, name);
    assert.equal(result.comparison.success, false, name);
    assert.ok(result.comparison.validationErrors.length > 0, name);
    assert.equal(result.comparison.differences.length, 0, `${name} does not compare an untrusted profile`);
  }
});

function findRow(sheet, predicate) {
  for (let row = 1; row <= sheet.rowCount; row += 1) if (predicate(sheet.getCell(row, 1).value)) return row;
  return 0;
}

test("21. structural corruption fails structural validation and builds no candidate", needsExcel, async () => {
  const sheets = app.WORKBOOK_SHEETS;
  const labels = app.WORKBOOK_IDENTITY_LABELS;
  const cases = {
    removedWorksheet: [(wb) => wb.removeWorksheet(wb.getWorksheet(sheets.assets).id), "MISSING_WORKSHEET"],
    renamedWorksheet: [(wb) => (wb.getWorksheet(sheets.assets).name = "Asset Balances"), "MISSING_WORKSHEET"],
    removedFieldId: [
      (wb) => {
        const { worksheet, row } = locations.currentAge;
        const sheet = wb.getWorksheet(worksheet);
        for (let column = 1; column <= sheet.columnCount; column += 1) {
          if (sheet.getCell(row, column).value === "currentAge") sheet.getCell(row, column).value = null;
        }
      },
      "MISSING_REQUIRED_FIELD_ID",
    ],
    changedTimelineFieldId: [
      (wb) => {
        const column = timelineMap.columnsByFieldId.get("timelineOverrides.income");
        wb.getWorksheet(sheets.timeline).getCell(app.WORKBOOK_LAYOUT.timelineFieldIdRow, column).value = "timelineOverrides.unknown";
      },
      "INVALID_TIMELINE_STRUCTURE",
    ],
    removedIdentity: [
      (wb) => {
        const sheet = wb.getWorksheet(sheets.instructions);
        const row = findRow(sheet, (v) => typeof v === "string" && v.startsWith(`${labels.application}:`));
        sheet.getCell(row, 1).value = null;
      },
      "INVALID_WORKBOOK_TYPE",
    ],
  };
  for (const [name, [mutateWorkbook, code]] of Object.entries(cases)) {
    const result = await roundTripProfile(fixtures.allOverrideTypesProfile(), { mutateWorkbook });
    assert.equal(result.structuralValidation.isValid, false, name);
    assert.ok(result.structuralValidation.errors.some((e) => e.code === code), `${name} reports ${code}`);
    assert.equal(result.candidate, null, `${name} builds no candidate`);
    assert.equal(result.comparison.success, false, name);
    assert.ok(result.comparison.validationErrors.length > 0, name);
  }
});

test("22. formulas in importable cells are rejected", needsExcel, async () => {
  const standard = await roundTripProfile(fixtures.sampleProfile(), {
    mutateWorkbook: (wb) => (valueCellOf(wb, "annualSalary").value = { formula: "1+1", result: 2 }),
  });
  assert.equal(standard.structuralValidation.isValid, false);
  assert.ok(standard.structuralValidation.errors.some((e) => e.code === "FORMULA_IN_IMPORTABLE_CELL" && e.fieldId === "annualSalary"));
  assert.equal(standard.candidate, null);

  const timeline = await roundTripProfile(fixtures.allOverrideTypesProfile(), {
    mutateWorkbook: (wb) => (timelineCellOf(wb, 50, "expenses").value = { formula: "1+1", result: 2 }),
  });
  assert.equal(timeline.structuralValidation.isValid, false);
  assert.ok(timeline.structuralValidation.errors.some((e) => e.code === "FORMULA_IN_IMPORTABLE_CELL"));
  assert.equal(timeline.candidate, null);
});

test("23. current template and schema versions round-trip; unsupported versions are rejected", needsExcel, async () => {
  const current = await cleanRoundTrip(fixtures.sampleProfile());
  const sheet = current.parsed.getWorksheet(app.WORKBOOK_SHEETS.instructions);
  const text = [];
  sheet.eachRow((row) => text.push(String(row.getCell(1).value)));
  assert.ok(text.includes(`${app.WORKBOOK_IDENTITY_LABELS.templateVersion}: ${app.WORKBOOK_TEMPLATE_VERSION}`));
  assert.ok(text.includes(`${app.WORKBOOK_IDENTITY_LABELS.schemaVersion}: ${app.WORKBOOK_SCHEMA_VERSION}`));

  const cases = [
    ["templateVersion", "UNSUPPORTED_TEMPLATE_VERSION"],
    ["schemaVersion", "UNSUPPORTED_SCHEMA_VERSION"],
  ];
  for (const [key, code] of cases) {
    const result = await roundTripProfile(fixtures.sampleProfile(), {
      mutateWorkbook: (wb) => {
        const instructions = wb.getWorksheet(app.WORKBOOK_SHEETS.instructions);
        const row = findRow(instructions, (v) => typeof v === "string" && v.startsWith(`${app.WORKBOOK_IDENTITY_LABELS[key]}:`));
        instructions.getCell(row, 1).value = `${app.WORKBOOK_IDENTITY_LABELS[key]}: 99.0`;
      },
    });
    assert.equal(result.structuralValidation.isValid, false, key);
    assert.ok(result.structuralValidation.errors.some((e) => e.code === code), `${key} reports ${code}`);
    assert.equal(result.candidate, null, key);
  }
});

// ---- 24. Select labels ----

test("24. every select option exports its label and imports its internal value", needsExcel, async () => {
  const selects = plain(app.buildPlanningWorkbookSchema()).filter((entry) => entry.dataType === "select");
  assert.ok(["filingStatus", "projectionBasis", "socialSecurityBenefitMode", "socialSecurityStrategy", "rothConversionStrategy"].every((id) => selects.some((s) => s.fieldId === id)));
  for (const entry of selects) {
    for (const option of entry.allowedValues) {
      const profile = fixtures.withValues(fixtures.sampleProfile(), { [entry.fieldId]: option.value });
      const result = await cleanRoundTrip(profile);
      assert.equal(valueCellOf(result.parsed, entry.fieldId).value, option.label, `${entry.fieldId} label in Excel`);
      assert.equal(pathGet(result.candidate.profile, entry.fieldId), option.value, `${entry.fieldId} internal value`);
    }
  }
});

// ---- 25. Inventory-driven coverage ----

for (const item of standardItems) {
  test(`25. ${item.fieldId} is exported, mapped, imported and compared`, needsExcel, async () => {
    const result = await cleanRoundTrip(fixtures.allInputsProfile());
    const sections = ["profile", "assumptions", "incomeAndExpenses", "assets"];
    const occurrences = sections.filter((section) => item.fieldId in result.exportModel[section]).length;
    assert.equal(occurrences, 1, "exactly one export model entry");
    assert.ok(locations[item.fieldId], "workbook destination");
    assert.ok(item.fieldId in result.candidate.values, "present in the import candidate");
    assert.notEqual(result.candidate.effective[item.fieldId], undefined, "effective imported value");

    const imported = result.candidate.profile;
    const keys = item.fieldId.split(".");
    const last = keys.pop();
    const parent = keys.reduce((node, key) => node[key], imported);
    parent[last] = typeof parent[last] === "number" ? parent[last] + 1 : `${parent[last]}x`;
    const differences = result.recompare().differences;
    assert.deepEqual(differences.map((d) => [d.type, d.fieldId]), [["changed", item.fieldId]], "included in the comparison");
  });
}

for (const definition of app.TIMELINE_OVERRIDE_FIELDS) {
  test(`25. Timeline field ${definition.field} has one column and survives`, needsExcel, async () => {
    const columns = [...timelineMap.columnsByFieldId.entries()].filter(([id]) => id === `timelineOverrides.${definition.field}`);
    assert.equal(columns.length, 1);
    const sharedColumn = [...timelineMap.columnsByFieldId.values()].filter((column) => column === columns[0][1]);
    assert.equal(sharedColumn.length, 1, "column is not shared");
    const age = definition.period === "retired" ? 67 : 50;
    const value = definition.field === "returnPercent" ? 4.5 : 1234;
    const profile = fixtures.sampleProfile();
    profile.timelineOverrides = { [age]: { [definition.field]: value } };
    const result = await cleanRoundTrip(profile);
    assert.ok(close(overridesOf(result)[age][definition.field], value));
  });
}

// ---- 26. No calculated outputs ----

test("26. calculated outputs never become round-trip inputs", needsExcel, async () => {
  const result = await cleanRoundTrip(fixtures.allOverrideTypesProfile());
  const audit = plain(app.auditWorkbookForCalculatedOutputs(result.workbook));
  // A populated workbook legitimately holds the plan's own values, so only the output counters must be zero.
  ["formulaCells", "calculatedFields", "projectionFields", "readinessFields", "recommendationFields", "hiddenOutputFields"].forEach(
    (key) => assert.equal(audit.counts[key], 0, key),
  );

  const prohibited = Object.values(plain(app.WORKBOOK_PROHIBITED_FIELDS)).flat();
  assert.ok(prohibited.length > 0);
  [
    "readinessScore", "score", "status", "projectedAssets", "requiredAssets", "fundingGap", "safeSpending", "recommendations",
    "expectedRetirementAge", "projectedRmd", "projectedNiit", "projectedIrmaa", "projectedSocialSecurityTax", "socialSecurityEstimatedBenefit",
  ].forEach((id) => assert.ok(app.workbookFieldIdIsProhibited(id), `${id} is a shared prohibited field`));

  const comparedIds = [...inventory.map((item) => item.fieldId), ...Object.keys(result.candidate.values), ...Object.keys(result.candidate.effective)];
  assert.deepEqual(comparedIds.filter((id) => app.workbookFieldIdIsProhibited(id)), []);
  const exportedIds = ["profile", "assumptions", "incomeAndExpenses", "assets"].flatMap((section) => Object.keys(result.exportModel[section]));
  assert.deepEqual(exportedIds.filter((id) => app.workbookFieldIdIsProhibited(id)), []);
});
