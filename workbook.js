// Blank planning workbook: input inventory, workbook schema, and .xlsx generation.
// Kept separate from calculations, rendering, validation rendering, and the PDF report.
// Depends on inputConfig(), ASSET_METADATA, and TIMELINE_OVERRIDE_FIELDS (loaded earlier) and on
// the ExcelJS browser build (global `ExcelJS`) at generation time only.

const WORKBOOK_FILENAME = "WealthMap_Planning_Workbook.xlsx";
const WORKBOOK_TEMPLATE_VERSION = "1.0";
const WORKBOOK_SCHEMA_VERSION = "1.0";
const WORKBOOK_TYPE = "WealthMap Blank Planning Workbook";
const WORKBOOK_APPLICATION_NAME = "WealthMap";
const WORKBOOK_PURPOSE = "Offline planning input template";
// Labels of the identity lines written to the Instructions sheet; the importer reads the same lines.
const WORKBOOK_IDENTITY_LABELS = Object.freeze({
  application: "Application",
  type: "Workbook Type",
  purpose: "Workbook Purpose",
  templateVersion: "Template Version",
  schemaVersion: "Schema Version",
});
// Only the currently generated versions are supported; there is no migration path.
const WORKBOOK_SUPPORTED_TEMPLATE_VERSIONS = Object.freeze([WORKBOOK_TEMPLATE_VERSION]);
const WORKBOOK_SUPPORTED_SCHEMA_VERSIONS = Object.freeze([WORKBOOK_SCHEMA_VERSION]);
// Generated workbooks contain no helper sheets (dropdowns use inline validation lists).
const WORKBOOK_HELPER_SHEET_NAMES = Object.freeze([]);
// Only these classifications may appear in the blank workbook; everything else is an output.
const WORKBOOK_ALLOWED_CLASSIFICATIONS = Object.freeze(["input", "instruction", "metadata"]);
// Centralized secondary safeguard. The primary rule is the supported-input inventory allowlist.
// Identifiers are the WealthMap calculation output names (see calculate()) plus their UI aliases.
const WORKBOOK_PROHIBITED_FIELDS = Object.freeze({
  readiness: [
    "readinessScore", "readinessStatus", "score", "status",
  ],
  recommendation: ["recommendations", "recommendedRetirementAge", "recommendedClaimAge"],
  projection: [
    "projectedAssets", "requiredAssets", "fundingGap", "fundingSurplus", "fundingDelta",
    "safeSpending", "expectedRetirementAge", "yearsToTarget", "afterTaxAssets",
    "projectedRmd", "projectedNiit", "projectedSocialSecurityTax", "projectedIrmaa",
    "projectedConversionTax", "projectedRothConversion", "firstRothConversionAge",
    "firstRothConversionAmount", "rothConversionWindowEndAge", "timelineDepletionAge",
    "timelineIrmaaAge", "socialSecurityPlan",
  ],
  calculated: [
    "socialSecurityEstimatedBenefit", "financialAssets", "totalAssets", "investableAssets",
    "netWorth", "totalIncome", "grossAnnualIncome", "afterTaxIncome", "surplus", "savingsRate",
    "annualSavingsRate", "additionalAnnualSavings", "availableAnnualSavings",
    "brokerageContribution", "cashContribution", "employeeSavings", "employerFourOhOneKMatch",
    "employerMatchAmount", "totalRetirementContributions", "totalAnnualSavings",
    "currentFederalTax", "currentStateTax",
  ],
});
const WORKBOOK_PROHIBITED_FIELD_IDS = new Set(Object.values(WORKBOOK_PROHIBITED_FIELDS).flat());

function workbookFieldIdIsProhibited(fieldId) {
  return (
    typeof fieldId === "string" &&
    (WORKBOOK_PROHIBITED_FIELD_IDS.has(fieldId) ||
      WORKBOOK_PROHIBITED_FIELD_IDS.has(fieldId.split(".").pop()))
  );
}
// Secondary label check for workbook headings and field labels (never option text or descriptions).
const WORKBOOK_OUTPUT_LABEL_PATTERNS = Object.freeze({
  readiness: /readiness|health score|\bscore\b/i,
  recommendation: /recommendations?\b|recommended (retirement|claim)/i,
  projection: /projected|funding (gap|surplus)|safe spending|expected retirement age|required (retirement )?assets|assets at retirement/i,
  calculated: /\btotal\b|net worth|after-tax income|gross annual income|savings rate|disposable|\bestimated\b/i,
});
const WORKBOOK_SHEETS = Object.freeze({
  instructions: "Instructions",
  planSetup: "Plan Setup",
  assets: "Assets",
  incomeExpenses: "Income & Expenses",
  timeline: "Timeline Overrides",
});
// Fixed positions a future importer can rely on.
const WORKBOOK_LAYOUT = Object.freeze({
  inputHeaderRow: 3,
  timelineFieldIdRow: 6,
  timelineHeaderRow: 7,
  timelineMinAge: 0,
  timelineMaxAge: 120,
});
const INPUT_HEADERS = Object.freeze([
  "Section",
  "Field",
  "Value",
  "Unit / Format",
  "Description",
  "Field ID",
]);
const TIMELINE_COLUMN_HEADERS = Object.freeze({
  returnPercent: "Return Override %",
  income: "Income Override",
  expenses: "Spending Override",
  extraCashNeed: "Additional Need",
  extraWithdrawal: "Extra Withdrawal",
});

// Mirrors the required-field and whole-number rules enforced by validation.js / the age inputs.
const REQUIRED_INPUT_IDS = new Set([
  "currentAge",
  "targetRetirementAge",
  "lifeExpectancy",
  "rmdStartAge",
  "expectedAnnualReturn",
  "inflationRate",
  "retirementAnnualSpendingGoal",
]);
const INTEGER_INPUT_IDS = new Set([
  "currentAge",
  "targetRetirementAge",
  "lifeExpectancy",
  "socialSecurityClaimAge",
  "rmdStartAge",
]);
const ASSET_SHEET_ORDER = [
  "cash",
  "brokerage",
  "fourOhOneK",
  "traditionalIra",
  "rothIra",
  "realEstate",
];
const INPUT_GROUPS = [
  ["profile", "Plan Setup", "Personal Details"],
  ["assumptions", "Plan Setup", "Projection Assumptions"],
  ["basicTax", "Plan Setup", "Tax and Retirement Settings"],
  ["advancedTax", "Plan Setup", "Advanced Tax and Retirement Settings"],
  ["strategy", "Plan Setup", "Retirement Strategies"],
  ["income", "Income & Expenses", "Income"],
  ["expenses", "Income & Expenses", "Expenses"],
  ["contributionsEmployer", "Income & Expenses", "Employer-Sponsored Savings"],
  ["contributionsIra", "Income & Expenses", "IRA Contributions"],
  [
    "contributionsAdditional",
    "Income & Expenses",
    "Additional Annual Savings Allocation",
  ],
];
const READ_ONLY_INPUT_IDS = new Set(["socialSecurityEstimatedBenefit"]);

const WORKBOOK_FIELD_DESCRIPTIONS = {
  name: "Plan name shown in WealthMap. Optional.",
  state: "State of residence, entered as a state name.",
  filingStatus: "Federal tax filing status. Choose from the list.",
  projectionBasis: "All projections use real (today's) dollars.",
  expectedAnnualReturn: "Expected long-term annual portfolio return before inflation.",
  inflationRate: "Expected annual increase in the cost of living.",
  safeWithdrawalRate: "Percentage of the portfolio assumed to be withdrawable each year.",
  socialSecurityBenefitMode:
    "Choose Automatically estimate to let WealthMap estimate the benefit from current earnings, or Enter manually to use the benefit amount below.",
  socialSecurityAnnualBenefit:
    "Annual benefit at Full Retirement Age (67). Used only when the Social Security benefit mode is Enter manually.",
  socialSecurityClaimAge: "Age at which Social Security benefits begin. Allowed range is 62-70.",
  rothConversionAnnualAmount:
    "Annual Roth conversion amount. Used only when the Roth conversion strategy is Manual annual amount.",
  socialSecurityStrategy:
    "Use the claim age entered above, or let WealthMap model a recommended claiming age.",
  rothConversionStrategy:
    "Use model-generated Roth conversions, or the manual annual amount entered in Plan Setup.",
  cashReserveTargetYears: "Years of retirement spending held in cash during retirement.",
  "contributionRates.fourOhOneK": "Employee 401(k) contribution as a percentage of salary.",
  "employerMatch.rate": "Employer match as a percentage of the employee 401(k) contribution.",
  "employerMatch.salaryCap": "Maximum percentage of salary eligible for the employer match.",
  "iraContributions.traditionalIraAnnual": "Fixed annual Traditional IRA contribution (pre-tax) in dollars.",
  "iraContributions.rothIraAnnual": "Fixed annual Roth IRA contribution (after-tax) in dollars.",
  "savingsAllocation.brokerage":
    "Share of Additional Annual Savings sent to the taxable brokerage account. Brokerage and Cash allocations must total 100%.",
  "savingsAllocation.cash":
    "Share of Additional Annual Savings sent to cash. Brokerage and Cash allocations must total 100%.",
  "timelineOverrides.returnPercent":
    "Return for this age, entered as a percentage (for example 4%); cannot be below -100%. Applies to working or retired years.",
  "timelineOverrides.income": "Working-year income for this age, replacing the modeled amount.",
  "timelineOverrides.expenses": "Annual spending for this age, replacing the modeled amount. Applies to working or retired years.",
  "timelineOverrides.extraCashNeed": "Additional cash need for this working-year age.",
  "timelineOverrides.extraWithdrawal": "Extra withdrawal for this retired-year age.",
};

function workbookConditionNote(fieldId) {
  const notes = {
    socialSecurityAnnualBenefit: "Used when socialSecurityBenefitMode is manual.",
    rothConversionAnnualAmount: "Used when rothConversionStrategy is manual.",
    "timelineOverrides.income": "Applies to working years only.",
    "timelineOverrides.extraCashNeed": "Applies to working years only.",
    "timelineOverrides.extraWithdrawal": "Applies to retirement years only.",
  };
  return notes[fieldId] || null;
}

function normalizeAllowedValues(options) {
  if (!Array.isArray(options) || options.length === 0) return undefined;
  return options.map((option) =>
    Array.isArray(option)
      ? { value: option[0], label: option[1] }
      : { value: option, label: option },
  );
}

function inventoryDataType(key, type) {
  if (type === "readonly") return "text";
  if (type === "number" && INTEGER_INPUT_IDS.has(key)) return "integer";
  return type;
}

// Builds the authoritative list of values a user can edit in the application today. Read-only and
// calculated values (for example socialSecurityEstimatedBenefit) are intentionally excluded.
function buildSupportedInputInventory() {
  const config = inputConfig();
  const inventory = [];

  INPUT_GROUPS.forEach(([group, worksheet, section]) => {
    config[group].forEach(([fieldId, label, type, unit, , options]) => {
      if (type === "readonly" || READ_ONLY_INPUT_IDS.has(fieldId)) return;
      const conditionNote = workbookConditionNote(fieldId);
      inventory.push({
        fieldId,
        label,
        source: `inputConfig.${group}`,
        worksheet,
        section,
        dataType: inventoryDataType(fieldId, type),
        unit: type === "select" || type === "text" ? "" : unit,
        required: REQUIRED_INPUT_IDS.has(fieldId),
        classification: "input",
        editable: true,
        conditional: Boolean(conditionNote),
        conditionNote,
        allowedValues: normalizeAllowedValues(options),
        description: WORKBOOK_FIELD_DESCRIPTIONS[fieldId] || `${label}.`,
        excelToInternalMultiplier: 1,
      });
    });
  });

  const assetKeys = [
    ...ASSET_SHEET_ORDER.filter((key) => ASSET_METADATA[key]),
    ...Object.keys(ASSET_METADATA).filter((key) => !ASSET_SHEET_ORDER.includes(key)),
  ];
  assetKeys.forEach((key) => {
    const metadata = ASSET_METADATA[key];
    inventory.push({
      fieldId: `assets.${key}`,
      label: metadata.label,
      source: "ASSET_METADATA",
      worksheet: "Assets",
      section: "Account Balances",
      dataType: "currency",
      unit: "current balance",
      required: false,
      classification: "input",
      editable: true,
      conditional: false,
      conditionNote: null,
      allowedValues: undefined,
      description:
        key === "realEstate"
          ? "Current value. Tracked separately; not treated as part of the spendable retirement portfolio."
          : `${metadata.treatment}. ${metadata.interpretation}.`,
      excelToInternalMultiplier: 1,
    });
  });

  TIMELINE_OVERRIDE_FIELDS.forEach((entry) => {
    const fieldId = `timelineOverrides.${entry.field}`;
    const conditionNote = workbookConditionNote(fieldId);
    inventory.push({
      fieldId,
      label: entry.label,
      source: "timeline.override",
      worksheet: WORKBOOK_SHEETS.timeline,
      section: "Year-by-Year Overrides",
      dataType: entry.dataType,
      unit: entry.dataType === "percent" ? "% return for the age" : "per year",
      required: false,
      classification: "input",
      editable: true,
      conditional: Boolean(conditionNote),
      conditionNote,
      allowedValues: undefined,
      description: WORKBOOK_FIELD_DESCRIPTIONS[fieldId],
      columnHeader: TIMELINE_COLUMN_HEADERS[entry.field],
      minimum: entry.min,
      // The Timeline stores return in percentage points (5 = 5%); Excel stores 5% as 0.05.
      excelToInternalMultiplier: entry.dataType === "percent" ? 100 : 1,
    });
  });

  return inventory;
}

function workbookFormatLabel(item) {
  const unit = item.unit && item.unit !== "%" ? ` - ${item.unit}` : "";
  switch (item.dataType) {
    case "currency":
      return `Currency (USD)${unit}`;
    case "percent":
      return `Percent${unit}`;
    case "integer":
      return `Whole number${unit}`;
    case "number":
      return `Number${unit}`;
    case "select":
      return "Choose from list";
    default:
      return "Text";
  }
}

// Workbook schema shared by generation and (later) import: one entry per Value cell or timeline column.
function buildPlanningWorkbookSchema() {
  return buildSupportedInputInventory().map((item) => ({
    worksheet: item.worksheet,
    section: item.section,
    fieldId: item.fieldId,
    classification: item.classification,
    label: item.label,
    dataType: item.dataType,
    unit: item.unit,
    format: workbookFormatLabel(item),
    description: item.conditionNote
      ? `${item.description} ${item.conditionNote}`.replace(/\s+/g, " ")
      : item.description,
    allowedValues: item.allowedValues,
    required: item.required,
    columnHeader: item.columnHeader,
    minimum: item.minimum,
    excelToInternalMultiplier: item.excelToInternalMultiplier,
  }));
}

const WORKBOOK_NUMBER_FORMATS = {
  currency: '"$"#,##0.00',
  percent: "0.00%",
  integer: "0",
  number: "0.##",
  text: "@",
  select: "@",
};

function workbookStyles() {
  const thin = (argb) => ({ style: "thin", color: { argb } });
  const borders = (argb) => ({
    top: thin(argb),
    bottom: thin(argb),
    left: thin(argb),
    right: thin(argb),
  });
  return {
    title: { font: { bold: true, size: 14 } },
    header: {
      font: { bold: true },
      fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9EAF7" } },
      alignment: { wrapText: true, vertical: "middle" },
      border: borders("FFB7C9D9"),
    },
    value: {
      fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF9DB" } },
      alignment: { vertical: "middle" },
      border: borders("FFD9D3A8"),
    },
    wrap: { alignment: { wrapText: true, vertical: "top" } },
    note: { font: { italic: true, color: { argb: "FF595959" } } },
  };
}

function applyStyle(cell, style) {
  Object.assign(cell, style);
}

// Excel data validation for one Value cell, or undefined when the field is free text.
function workbookDataValidation(entry) {
  const base = { allowBlank: true, showErrorMessage: true, errorStyle: "stop" };
  if (entry.dataType === "select" && entry.allowedValues) {
    return {
      ...base,
      type: "list",
      formulae: [`"${entry.allowedValues.map((option) => option.label).join(",")}"`],
      errorTitle: "Choose a listed value",
      error: "Select one of the listed choices.",
    };
  }
  if (entry.fieldId === "socialSecurityClaimAge") {
    return {
      ...base,
      type: "whole",
      operator: "between",
      formulae: [62, 70],
      errorTitle: "Invalid claim age",
      error: "Enter a whole number from 62 to 70.",
    };
  }
  if (entry.dataType === "integer") {
    return {
      ...base,
      type: "whole",
      operator: "between",
      formulae: [0, 120],
      errorTitle: "Invalid age",
      error: "Enter a whole number from 0 to 120.",
    };
  }
  if (entry.dataType === "percent") {
    const minimum = entry.minimum != null && entry.minimum < 0 ? entry.minimum / 100 : 0;
    return minimum < 0
      ? {
          ...base,
          type: "decimal",
          operator: "greaterThanOrEqual",
          formulae: [minimum],
          errorTitle: "Invalid percentage",
          error: "Enter a percentage of -100% or higher.",
        }
      : {
          ...base,
          type: "decimal",
          operator: "between",
          formulae: [0, 1],
          errorTitle: "Invalid percentage",
          error: "Enter a percentage from 0% to 100%.",
        };
  }
  if (entry.dataType === "currency" || entry.dataType === "number") {
    return {
      ...base,
      type: "decimal",
      operator: "greaterThanOrEqual",
      formulae: [0],
      errorTitle: "Invalid amount",
      error: "Enter a value of 0 or more.",
    };
  }
  return undefined;
}

function createInstructionsWorksheet(workbook) {
  const sheet = workbook.addWorksheet(WORKBOOK_SHEETS.instructions);
  const styles = workbookStyles();
  const lines = [
    "WealthMap Planning Workbook",
    "",
    "Complete this workbook offline, then import it into WealthMap.",
    "Enter information only in the designated Value cells (shaded).",
    "Currency fields use annual amounts unless otherwise stated.",
    "Enter percentages as normal percentages, such as 5%, not 0.05.",
    "Brokerage Allocation and Cash Allocation must total 100%.",
    "Do not rename worksheets, column headings, or field identifiers.",
    "Blank optional fields use WealthMap defaults or zero where applicable.",
    "The Notes column on the Timeline Overrides sheet is optional and for your own use; it is not part of the plan.",
    "This workbook contains inputs only. WealthMap calculates all results after a completed workbook is imported.",
    `${WORKBOOK_IDENTITY_LABELS.application}: ${WORKBOOK_APPLICATION_NAME}`,
    `${WORKBOOK_IDENTITY_LABELS.type}: ${WORKBOOK_TYPE}`,
    `${WORKBOOK_IDENTITY_LABELS.purpose}: ${WORKBOOK_PURPOSE}`,
    `${WORKBOOK_IDENTITY_LABELS.templateVersion}: ${WORKBOOK_TEMPLATE_VERSION}`,
    `${WORKBOOK_IDENTITY_LABELS.schemaVersion}: ${WORKBOOK_SCHEMA_VERSION}`,
  ];
  sheet.getColumn(1).width = 90;
  lines.forEach((text, index) => {
    const cell = sheet.getCell(index + 1, 1);
    cell.value = text || null;
    cell.alignment = { wrapText: true, vertical: "top" };
  });
  applyStyle(sheet.getCell(1, 1), styles.title);
  return sheet;
}

function createInputWorksheet(workbook, name, entries) {
  const sheet = workbook.addWorksheet(name, {
    views: [{ state: "frozen", ySplit: WORKBOOK_LAYOUT.inputHeaderRow }],
  });
  const styles = workbookStyles();
  const headerRow = WORKBOOK_LAYOUT.inputHeaderRow;
  [18, 34, 20, 26, 60, 38].forEach((width, index) => {
    sheet.getColumn(index + 1).width = width;
  });
  sheet.getCell(1, 1).value = name;
  applyStyle(sheet.getCell(1, 1), styles.title);

  INPUT_HEADERS.forEach((header, index) => {
    const cell = sheet.getCell(headerRow, index + 1);
    cell.value = header;
    applyStyle(cell, styles.header);
  });

  entries.forEach((entry, index) => {
    const rowNumber = headerRow + 1 + index;
    [entry.section, entry.label, null, entry.format, entry.description, entry.fieldId].forEach(
      (value, columnIndex) => {
        const cell = sheet.getCell(rowNumber, columnIndex + 1);
        cell.value = value;
        cell.alignment = { wrapText: true, vertical: "top" };
      },
    );
    const valueCell = sheet.getCell(rowNumber, 3);
    applyStyle(valueCell, styles.value);
    valueCell.numFmt = WORKBOOK_NUMBER_FORMATS[entry.dataType] || "@";
    const validation = workbookDataValidation(entry);
    if (validation) valueCell.dataValidation = validation;
  });

  sheet.autoFilter = {
    from: { row: headerRow, column: 1 },
    to: { row: headerRow + entries.length, column: INPUT_HEADERS.length },
  };
  return sheet;
}

function createTimelineOverridesWorksheet(workbook, timelineEntries) {
  const sheet = workbook.addWorksheet(WORKBOOK_SHEETS.timeline, {
    views: [{ state: "frozen", ySplit: WORKBOOK_LAYOUT.timelineHeaderRow }],
  });
  const styles = workbookStyles();
  const notes = [
    "Leave a field blank to continue using the WealthMap model.",
    "Income Override and Additional Need apply to working years.",
    "Extra Withdrawal applies to retirement years.",
    "Return Override % and Spending Override may apply to either period.",
    "Actual applicability is determined from the ages entered in Plan Setup when the workbook is imported.",
  ];
  notes.forEach((text, index) => {
    sheet.getCell(index + 1, 1).value = text;
  });
  applyStyle(sheet.getCell(1, 1), styles.title);

  const columns = [
    { header: "Age", fieldId: null, width: 10 },
    ...timelineEntries.map((entry) => ({
      header: entry.columnHeader,
      fieldId: entry.fieldId,
      entry,
      width: 20,
    })),
    { header: "Notes", fieldId: null, width: 36 },
  ];
  sheet.getCell(WORKBOOK_LAYOUT.timelineFieldIdRow, 1).value = "Field ID";
  columns.forEach((column, index) => {
    sheet.getColumn(index + 1).width = column.width;
    const idCell = sheet.getCell(WORKBOOK_LAYOUT.timelineFieldIdRow, index + 1);
    if (column.fieldId) idCell.value = column.fieldId;
    applyStyle(idCell, styles.note);
    const headerCell = sheet.getCell(WORKBOOK_LAYOUT.timelineHeaderRow, index + 1);
    headerCell.value = column.header;
    applyStyle(headerCell, styles.header);
  });

  for (
    let age = WORKBOOK_LAYOUT.timelineMinAge;
    age <= WORKBOOK_LAYOUT.timelineMaxAge;
    age += 1
  ) {
    const rowNumber = WORKBOOK_LAYOUT.timelineHeaderRow + 1 + age - WORKBOOK_LAYOUT.timelineMinAge;
    const ageCell = sheet.getCell(rowNumber, 1);
    ageCell.value = age;
    ageCell.numFmt = "0";
    columns.forEach((column, index) => {
      if (index === 0) return;
      const cell = sheet.getCell(rowNumber, index + 1);
      applyStyle(cell, styles.value);
      if (!column.entry) return;
      cell.numFmt = WORKBOOK_NUMBER_FORMATS[column.entry.dataType];
      const validation = workbookDataValidation(column.entry);
      if (validation) cell.dataValidation = validation;
    });
  }

  sheet.autoFilter = {
    from: { row: WORKBOOK_LAYOUT.timelineHeaderRow, column: 1 },
    to: {
      row: WORKBOOK_LAYOUT.timelineHeaderRow + WORKBOOK_LAYOUT.timelineMaxAge - WORKBOOK_LAYOUT.timelineMinAge + 1,
      column: columns.length,
    },
  };
  return sheet;
}

function buildBlankPlanningWorkbook(excelApi = globalThis.ExcelJS) {
  if (!excelApi) throw new Error("Workbook library unavailable.");
  const schema = buildPlanningWorkbookSchema();
  const workbook = new excelApi.Workbook();
  workbook.creator = "WealthMap";
  workbook.lastModifiedBy = "WealthMap";
  workbook.title = WORKBOOK_TYPE;
  createInstructionsWorksheet(workbook);
  [WORKBOOK_SHEETS.planSetup, WORKBOOK_SHEETS.assets, WORKBOOK_SHEETS.incomeExpenses].forEach(
    (name) =>
      createInputWorksheet(
        workbook,
        name,
        schema.filter((entry) => entry.worksheet === name),
      ),
  );
  createTimelineOverridesWorksheet(
    workbook,
    schema.filter((entry) => entry.worksheet === WORKBOOK_SHEETS.timeline),
  );
  return workbook;
}

// Compares the supported-input inventory with the Field IDs / timeline columns actually present in a
// generated workbook. Returns arrays of problems; all arrays empty means full, unambiguous coverage.
function auditWorkbookInputCoverage(workbook, inventory = buildSupportedInputInventory()) {
  const found = [];
  const duplicates = [];
  const wrongSheet = [];
  [WORKBOOK_SHEETS.planSetup, WORKBOOK_SHEETS.assets, WORKBOOK_SHEETS.incomeExpenses].forEach(
    (name) => {
      const sheet = workbook.getWorksheet(name);
      for (let rowNumber = WORKBOOK_LAYOUT.inputHeaderRow + 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
        const fieldId = sheet.getCell(rowNumber, 6).value;
        if (!fieldId) continue;
        if (found.some((entry) => entry.fieldId === fieldId)) duplicates.push(fieldId);
        found.push({ fieldId, sheet: name });
      }
    },
  );
  const timeline = workbook.getWorksheet(WORKBOOK_SHEETS.timeline);
  for (let column = 1; column <= timeline.columnCount; column += 1) {
    const fieldId = timeline.getCell(WORKBOOK_LAYOUT.timelineFieldIdRow, column).value;
    if (!fieldId || column === 1) continue;
    if (found.some((entry) => entry.fieldId === fieldId)) duplicates.push(fieldId);
    found.push({ fieldId, sheet: WORKBOOK_SHEETS.timeline });
  }
  const foundIds = new Set(found.map((entry) => entry.fieldId));
  const inventoryIds = new Set(inventory.map((item) => item.fieldId));
  inventory.forEach((item) => {
    const location = found.find((entry) => entry.fieldId === item.fieldId);
    if (location && location.sheet !== item.worksheet) wrongSheet.push(item.fieldId);
  });
  return {
    missing: inventory.filter((item) => !foundIds.has(item.fieldId)).map((item) => item.fieldId),
    unexpected: [...foundIds].filter((id) => !inventoryIds.has(id)),
    duplicates,
    wrongSheet,
  };
}

function workbookCellText(cell) {
  const value = cell.value;
  if (value == null) return "";
  if (typeof value === "object") return value.richText ? value.richText.map((part) => part.text).join("") : "";
  return String(value);
}

function workbookCellHasFormula(cell) {
  const value = cell.value;
  return Boolean(
    cell.formula ||
      (value && typeof value === "object" && ("formula" in value || "sharedFormula" in value)),
  );
}

// Audits a generated workbook against the static input allowlist. It never reads workingProfile or
// calculation results; SAMPLE_PROFILE is read only to prove its free-text values are not embedded.
function auditWorkbookForCalculatedOutputs(workbook, options = {}) {
  const inventory = options.inventory || buildSupportedInputInventory();
  const schema = options.schema || buildPlanningWorkbookSchema();
  const sample = options.sampleProfile || (typeof SAMPLE_PROFILE !== "undefined" ? SAMPLE_PROFILE : {});
  const inventoryIds = new Set(inventory.map((item) => item.fieldId));
  const findings = {
    schemaNotInInventory: [],
    outputClassifications: [],
    prohibitedFieldIds: [],
    readOnlyFields: [],
    formulaCells: [],
    timelineOutputColumns: [],
    readiness: [],
    recommendation: [],
    projection: [],
    calculated: [],
    activePlanValues: [],
    sampleProfileValues: [],
    hiddenOutput: [],
  };
  const labelCheck = (text, where) => {
    Object.entries(WORKBOOK_OUTPUT_LABEL_PATTERNS).forEach(([category, pattern]) => {
      if (text && pattern.test(text)) findings[category].push(`${where}: ${text}`);
    });
  };

  schema.forEach((entry) => {
    if (!inventoryIds.has(entry.fieldId)) findings.schemaNotInInventory.push(entry.fieldId);
    if (!WORKBOOK_ALLOWED_CLASSIFICATIONS.includes(entry.classification)) {
      findings.outputClassifications.push(entry.fieldId);
    }
    if (workbookFieldIdIsProhibited(entry.fieldId)) {
      findings.prohibitedFieldIds.push(entry.fieldId);
    }
    if (READ_ONLY_INPUT_IDS.has(entry.fieldId)) findings.readOnlyFields.push(entry.fieldId);
    labelCheck(entry.columnHeader || entry.label, entry.fieldId);
  });

  const sampleText = [sample.name, sample.state]
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => value.trim().toLowerCase());
  const timelineHeaders = new Set(["Age", "Notes", ...Object.values(TIMELINE_COLUMN_HEADERS)]);
  const timelineIds = new Set(
    schema.filter((entry) => entry.worksheet === WORKBOOK_SHEETS.timeline).map((entry) => entry.fieldId),
  );

  workbook.worksheets.forEach((sheet) => {
    if (sheet.state && sheet.state !== "visible") findings.hiddenOutput.push(`hidden sheet: ${sheet.name}`);
    const isInput = [WORKBOOK_SHEETS.planSetup, WORKBOOK_SHEETS.assets, WORKBOOK_SHEETS.incomeExpenses].includes(sheet.name);
    const isTimeline = sheet.name === WORKBOOK_SHEETS.timeline;
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (row.hidden) findings.hiddenOutput.push(`hidden row: ${sheet.name}!${rowNumber}`);
      row.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
        const where = `${sheet.name}!${cell.address}`;
        if (workbookCellHasFormula(cell)) findings.formulaCells.push(where);
        if (cell.note) findings.hiddenOutput.push(`cell note: ${where}`);
        const text = workbookCellText(cell).trim().toLowerCase();
        if (text && sampleText.includes(text)) findings.sampleProfileValues.push(where);
        if (isInput && rowNumber > WORKBOOK_LAYOUT.inputHeaderRow && columnNumber === 3) {
          findings.activePlanValues.push(where);
        }
        if (isTimeline && rowNumber > WORKBOOK_LAYOUT.timelineHeaderRow) {
          const age = rowNumber - WORKBOOK_LAYOUT.timelineHeaderRow - 1 + WORKBOOK_LAYOUT.timelineMinAge;
          if (columnNumber === 1 ? cell.value !== age : true) findings.activePlanValues.push(where);
        }
        if (isTimeline && rowNumber === WORKBOOK_LAYOUT.timelineHeaderRow && !timelineHeaders.has(workbookCellText(cell))) {
          findings.timelineOutputColumns.push(where);
        }
        if (isTimeline && rowNumber === WORKBOOK_LAYOUT.timelineFieldIdRow && columnNumber > 1 && !timelineIds.has(workbookCellText(cell))) {
          findings.timelineOutputColumns.push(where);
        }
        if (isTimeline && rowNumber === WORKBOOK_LAYOUT.timelineHeaderRow) labelCheck(workbookCellText(cell), where);
        if (isInput && rowNumber > WORKBOOK_LAYOUT.inputHeaderRow && columnNumber === 6) {
          const id = workbookCellText(cell);
          if (!inventoryIds.has(id)) findings.schemaNotInInventory.push(`${where}: ${id}`);
          if (workbookFieldIdIsProhibited(id)) findings.prohibitedFieldIds.push(where);
        }
      });
    });
    (sheet.columns || []).forEach((column, index) => {
      if (column && column.hidden) findings.hiddenOutput.push(`hidden column: ${sheet.name}!${index + 1}`);
    });
  });

  const definedNames = workbook.definedNames && workbook.definedNames.model;
  if (Array.isArray(definedNames) && definedNames.length) {
    findings.hiddenOutput.push(`defined names: ${definedNames.length}`);
  }
  const allowedProperties = new Set(["WealthMap", WORKBOOK_TYPE]);
  ["creator", "lastModifiedBy", "title", "subject", "description", "keywords", "category", "company", "manager"].forEach(
    (key) => {
      if (workbook[key] && !allowedProperties.has(workbook[key])) findings.hiddenOutput.push(`workbook property: ${key}`);
    },
  );
  if (workbook.properties && Object.keys(workbook.properties).some((key) => key !== "date1904")) {
    findings.hiddenOutput.push("workbook custom properties");
  }

  const timelineTypes = schema.filter((entry) => entry.worksheet === WORKBOOK_SHEETS.timeline).length;
  const counts = {
    inputFieldsReviewed: schema.length - timelineTypes,
    timelineOverrideTypesReviewed: timelineTypes,
    formulaCells: findings.formulaCells.length,
    calculatedFields:
      findings.calculated.length + findings.outputClassifications.length +
      findings.prohibitedFieldIds.length + findings.readOnlyFields.length + findings.schemaNotInInventory.length,
    projectionFields: findings.projection.length + findings.timelineOutputColumns.length,
    readinessFields: findings.readiness.length,
    recommendationFields: findings.recommendation.length,
    activePlanValues: findings.activePlanValues.length,
    sampleProfileValues: findings.sampleProfileValues.length,
    hiddenOutputFields: findings.hiddenOutput.length,
  };
  const failures = Object.entries(counts).filter(([key, value]) => !key.endsWith("Reviewed") && value > 0);
  return { counts, findings, result: failures.length === 0 ? "PASS" : "FAIL" };
}

function formatCalculatedOutputAudit(audit) {
  const { counts } = audit;
  return [
    "Calculated-output workbook audit",
    `Input fields reviewed: ${counts.inputFieldsReviewed}`,
    `Timeline override types reviewed: ${counts.timelineOverrideTypesReviewed}`,
    `Formula cells found: ${counts.formulaCells}`,
    `Calculated fields found: ${counts.calculatedFields}`,
    `Projection fields found: ${counts.projectionFields}`,
    `Readiness fields found: ${counts.readinessFields}`,
    `Recommendation fields found: ${counts.recommendationFields}`,
    `Active-plan values found: ${counts.activePlanValues}`,
    `Sample-profile values found: ${counts.sampleProfileValues}`,
    `Hidden output fields found: ${counts.hiddenOutputFields}`,
    `Result: ${audit.result}`,
  ].join("\n");
}

async function downloadBlankPlanningWorkbook() {
  const workbook = buildBlankPlanningWorkbook();
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = WORKBOOK_FILENAME;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
