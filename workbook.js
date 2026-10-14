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

// Layout arithmetic shared by worksheet generation and the field/timeline location maps so the two
// can never drift apart.
const WORKBOOK_INPUT_VALUE_COLUMN = 3;
const WORKBOOK_TIMELINE_AGE_COLUMN = 1;

function workbookInputRowNumber(entryIndex) {
  return WORKBOOK_LAYOUT.inputHeaderRow + 1 + entryIndex;
}

function workbookTimelineRowNumber(age) {
  return WORKBOOK_LAYOUT.timelineHeaderRow + 1 + age - WORKBOOK_LAYOUT.timelineMinAge;
}

function workbookTimelineColumnNumber(entryIndex) {
  return WORKBOOK_TIMELINE_AGE_COLUMN + 1 + entryIndex;
}

function workbookInputSheetNames() {
  return [WORKBOOK_SHEETS.planSetup, WORKBOOK_SHEETS.assets, WORKBOOK_SHEETS.incomeExpenses];
}

// Maps every standard input fieldId to its Value cell: { worksheet, row, column }. Derived from the
// schema; excludes timeline columns, read-only/calculated values, and instruction rows.
function buildWorkbookFieldLocationIndex(schema = buildPlanningWorkbookSchema()) {
  const index = {};
  workbookInputSheetNames().forEach((name) => {
    schema
      .filter((entry) => entry.worksheet === name)
      .forEach((entry, entryIndex) => {
        if (entry.classification !== "input") return;
        index[entry.fieldId] = {
          worksheet: name,
          row: workbookInputRowNumber(entryIndex),
          column: WORKBOOK_INPUT_VALUE_COLUMN,
        };
      });
  });
  return index;
}

// Describes the Timeline Overrides sheet: column per override field plus the age-row geometry.
function buildWorkbookTimelineOverrideMap(schema = buildPlanningWorkbookSchema()) {
  const columns = {};
  schema
    .filter((entry) => entry.worksheet === WORKBOOK_SHEETS.timeline)
    .forEach((entry, entryIndex) => {
      columns[entry.fieldId.replace("timelineOverrides.", "")] = workbookTimelineColumnNumber(entryIndex);
    });
  const columnsByFieldId = new Map(
    Object.entries(columns).map(([field, column]) => [`timelineOverrides.${field}`, column]),
  );
  return {
    worksheet: WORKBOOK_SHEETS.timeline,
    columnsByFieldId,
    headerRow: WORKBOOK_LAYOUT.timelineHeaderRow,
    ageColumn: WORKBOOK_TIMELINE_AGE_COLUMN,
    returnPercentColumn: columns.returnPercent,
    incomeColumn: columns.income,
    expensesColumn: columns.expenses,
    extraCashNeedColumn: columns.extraCashNeed,
    extraWithdrawalColumn: columns.extraWithdrawal,
    firstAgeRow: workbookTimelineRowNumber(WORKBOOK_LAYOUT.timelineMinAge),
    minAge: WORKBOOK_LAYOUT.timelineMinAge,
    maxAge: WORKBOOK_LAYOUT.timelineMaxAge,
  };
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
    const rowNumber = workbookInputRowNumber(index);
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
    const rowNumber = workbookTimelineRowNumber(age);
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

// Structure only: sheets, headings, formatting, validations, and Field IDs. Never writes values.
function createWorkbookStructure(excelApi, schema) {
  if (!excelApi) throw new Error("Workbook library unavailable.");
  const workbook = new excelApi.Workbook();
  workbook.creator = "WealthMap";
  workbook.lastModifiedBy = "WealthMap";
  workbook.title = WORKBOOK_TYPE;
  createInstructionsWorksheet(workbook);
  workbookInputSheetNames().forEach((name) =>
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

const WORKBOOK_STANDARD_EXPORT_SECTIONS = Object.freeze([
  "profile",
  "assumptions",
  "incomeAndExpenses",
  "assets",
]);

// Flattens the four standard export sections into one fieldId -> value map (never timelineOverrides).
// Own properties only; a field id present in more than one section is reported via `duplicates`
// (an array of field ids, never values) and left out of the map so it is never written.
function collectStandardExportFields(exportModel, duplicates = []) {
  const fields = Object.create(null);
  const seen = new Set();
  const repeated = new Set();
  WORKBOOK_STANDARD_EXPORT_SECTIONS.forEach((section) => {
    const values = exportModel && exportModel[section];
    if (!values || typeof values !== "object" || Array.isArray(values)) return;
    Object.entries(values).forEach(([fieldId, value]) => {
      if (seen.has(fieldId)) {
        repeated.add(fieldId);
        return;
      }
      seen.add(fieldId);
      fields[fieldId] = value;
    });
  });
  repeated.forEach((fieldId) => {
    delete fields[fieldId];
    duplicates.push(fieldId);
  });
  return fields;
}

// Returns the dropdown label for an internal select value, or undefined when it cannot be resolved.
function workbookSelectLabel(schemaEntry, internalValue) {
  const option = (schemaEntry.allowedValues || []).find((entry) => entry.value === internalValue);
  return option ? option.label : undefined;
}

// Converts an internal value to its workbook cell value. Returns { value } or { error: code };
// the error never carries the value itself. Blank (null/undefined) becomes a blank cell.
function toWorkbookExportValue(value, schemaEntry) {
  if (value === null || value === undefined) return { value: null };
  switch (schemaEntry.dataType) {
    case "text":
      return typeof value === "string" ? { value } : { error: "INVALID_EXPORT_VALUE" };
    case "select": {
      if (typeof value !== "string" && typeof value !== "number") return { error: "INVALID_EXPORT_VALUE" };
      const label = workbookSelectLabel(schemaEntry, value);
      return label === undefined ? { error: "UNRESOLVED_SELECT_VALUE" } : { value: label };
    }
    case "integer":
      return Number.isInteger(value) ? { value } : { error: "INVALID_EXPORT_VALUE" };
    case "currency":
    case "number":
    case "percent":
      // Standard percentages are decimals internally and in Excel (excelToInternalMultiplier is 1).
      return typeof value === "number" && Number.isFinite(value)
        ? { value: value / schemaEntry.excelToInternalMultiplier }
        : { error: "INVALID_EXPORT_VALUE" };
    default:
      return { error: "INVALID_EXPORT_VALUE" };
  }
}

// Writes standard (non-Timeline) export values into their Value cells. Only cell values are
// assigned, so number formats, validations and styles are untouched. Returns
// { populatedFieldIds, blankFieldIds, errors } where errors hold { code, fieldId, worksheet? } only.
function populateWorkbookInputs(
  workbook,
  exportModel,
  fieldLocationIndex = buildWorkbookFieldLocationIndex(),
  schema = buildPlanningWorkbookSchema(),
) {
  const result = { populatedFieldIds: [], blankFieldIds: [], errors: [] };
  const fail = (code, fieldId, worksheet) =>
    result.errors.push(worksheet ? { code, fieldId, worksheet } : { code, fieldId });
  const duplicates = [];
  const fields = collectStandardExportFields(exportModel, duplicates);
  duplicates.forEach((fieldId) => fail("DUPLICATE_EXPORT_FIELD", fieldId));
  const schemaById = new Map(schema.map((entry) => [entry.fieldId, entry]));

  Object.keys(fields).forEach((fieldId) => {
    if (workbookFieldIdIsProhibited(fieldId)) return fail("PROHIBITED_EXPORT_FIELD", fieldId);
    const entry = schemaById.get(fieldId);
    if (!entry || entry.classification !== "input") return fail("UNKNOWN_EXPORT_FIELD", fieldId);
    if (entry.worksheet === WORKBOOK_SHEETS.timeline) {
      return fail("TIMELINE_FIELD_IN_STANDARD_EXPORT", fieldId, entry.worksheet);
    }
    const location = Object.prototype.hasOwnProperty.call(fieldLocationIndex, fieldId)
      ? fieldLocationIndex[fieldId]
      : undefined;
    const sheet = location && workbook.getWorksheet(location.worksheet);
    if (!sheet) return fail("MISSING_WORKBOOK_LOCATION", fieldId, entry.worksheet);
    const converted = toWorkbookExportValue(fields[fieldId], entry);
    if (converted.error) return fail(converted.error, fieldId, entry.worksheet);
    sheet.getCell(location.row, location.column).value = converted.value;
    (converted.value === null ? result.blankFieldIds : result.populatedFieldIds).push(fieldId);
  });
  return result;
}

function timelineExportFieldId(field) {
  return `timelineOverrides.${field}`;
}

// Resolves age -> worksheet row by reading the generated age column (never by arithmetic), so an
// age is only writable when it maps to exactly one existing row.
function workbookTimelineRowsByAge(sheet, timelineMap) {
  const rows = new Map();
  const duplicates = new Set();
  for (let row = timelineMap.firstAgeRow; row <= sheet.rowCount; row += 1) {
    const age = sheet.getCell(row, timelineMap.ageColumn).value;
    if (typeof age !== "number") continue;
    if (rows.has(age)) duplicates.add(age);
    else rows.set(age, row);
  }
  return { rows, duplicates };
}

// Converts an internal Timeline value to Excel units using the schema multiplier
// (returnPercent: percentage points -> decimal fraction). Returns { value } or { error }.
function toTimelineWorkbookValue(value, schemaEntry) {
  const multiplier = schemaEntry.excelToInternalMultiplier ?? 1;
  if (typeof multiplier !== "number" || !Number.isFinite(multiplier) || multiplier <= 0) {
    return { error: "INVALID_TIMELINE_MULTIPLIER" };
  }
  const converted = value / multiplier;
  return Number.isFinite(converted) ? { value: converted } : { error: "INVALID_TIMELINE_VALUE" };
}

// Validates every override record first, then writes all of them; nothing is written if any record
// is invalid. Only cell values are assigned. Result: { populated, skipped, errors } with metadata
// only (age, fieldId, code), never override values.
function populateWorkbookTimelineOverrides(
  workbook,
  exportModel,
  timelineMap = buildWorkbookTimelineOverrideMap(),
  schema = buildPlanningWorkbookSchema(),
) {
  const result = { populated: [], skipped: [], errors: [] };
  const records = exportModel ? exportModel.timelineOverrides : undefined;
  if (records === undefined || records === null) return result;
  if (!Array.isArray(records)) {
    result.errors.push({ code: "INVALID_TIMELINE_EXPORT_MODEL" });
    return result;
  }
  const sheet = workbook.getWorksheet(timelineMap.worksheet);
  if (!sheet) {
    result.errors.push({ code: "MISSING_TIMELINE_AGE_ROW", worksheet: timelineMap.worksheet });
    return result;
  }
  const schemaById = new Map(schema.map((entry) => [entry.fieldId, entry]));
  const { rows, duplicates } = workbookTimelineRowsByAge(sheet, timelineMap);
  const prepared = [];
  const seenRecords = new Set();
  const seenCells = new Set();

  records.forEach((record) => {
    const fail = (code, age, fieldId) => {
      const error = { code };
      if (typeof age === "number" && Number.isFinite(age)) error.age = age;
      if (typeof fieldId === "string") error.fieldId = fieldId;
      result.errors.push(error);
    };
    if (!record || typeof record !== "object" || Array.isArray(record)) return fail("INVALID_TIMELINE_RECORD");
    const { age, field, value } = record;
    const fieldId = typeof field === "string" ? timelineExportFieldId(field) : undefined;
    if (typeof age !== "number" || !Number.isFinite(age) || !Number.isInteger(age)) {
      return fail("INVALID_TIMELINE_AGE", undefined, fieldId);
    }
    if (age < timelineMap.minAge || age > timelineMap.maxAge) {
      return fail("TIMELINE_AGE_OUT_OF_RANGE", age, fieldId);
    }
    if (!fieldId || !TIMELINE_OVERRIDE_FIELDS.some((entry) => entry.field === field)) {
      return fail("UNSUPPORTED_TIMELINE_FIELD", age, fieldId);
    }
    if (workbookFieldIdIsProhibited(fieldId)) return fail("PROHIBITED_TIMELINE_FIELD", age, fieldId);
    const entry = schemaById.get(fieldId);
    if (!entry || entry.worksheet !== WORKBOOK_SHEETS.timeline || entry.classification !== "input") {
      return fail("MISSING_TIMELINE_SCHEMA_ENTRY", age, fieldId);
    }
    const recordKey = `${age}:${fieldId}`;
    if (seenRecords.has(recordKey)) return fail("DUPLICATE_TIMELINE_OVERRIDE", age, fieldId);
    seenRecords.add(recordKey);
    if (value === null || value === undefined) {
      result.skipped.push({ age, fieldId });
      return undefined;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) return fail("INVALID_TIMELINE_VALUE", age, fieldId);
    if (typeof entry.minimum === "number" && value < entry.minimum) {
      return fail("TIMELINE_VALUE_BELOW_MINIMUM", age, fieldId);
    }
    if (duplicates.has(age)) return fail("DUPLICATE_TIMELINE_AGE_ROW", age, fieldId);
    const row = rows.get(age);
    if (row === undefined) return fail("MISSING_TIMELINE_AGE_ROW", age, fieldId);
    const column = timelineMap.columnsByFieldId.get(fieldId);
    if (column === undefined) return fail("MISSING_TIMELINE_COLUMN", age, fieldId);
    const converted = toTimelineWorkbookValue(value, entry);
    if (converted.error) return fail(converted.error, age, fieldId);
    const cellKey = `${timelineMap.worksheet}:${row}:${column}`;
    if (seenCells.has(cellKey)) return fail("DUPLICATE_TIMELINE_DESTINATION", age, fieldId);
    seenCells.add(cellKey);
    prepared.push({ age, fieldId, row, column, workbookValue: converted.value });
    return undefined;
  });

  if (result.errors.length) return result;
  prepared.forEach((write) => {
    sheet.getCell(write.row, write.column).value = write.workbookValue;
    result.populated.push({ age: write.age, fieldId: write.fieldId });
  });
  return result;
}

// Errors carry a machine-readable code and a message that never includes plan values.
function createSafeExportError(code, message = "WealthMap workbook export failed.") {
  const error = new Error(message);
  error.code = code;
  return error;
}

// Build metadata kept off the workbook itself (and out of the exported file).
const workbookPopulationResults = new WeakMap();
const workbookTimelinePopulationResults = new WeakMap();
function getWorkbookPopulationResult(workbook) {
  return workbookPopulationResults.get(workbook);
}
function getWorkbookTimelinePopulationResult(workbook) {
  return workbookTimelinePopulationResults.get(workbook);
}

function createPlanningWorkbook(options = {}) {
  const { populate = false, exportModel, excelApi = globalThis.ExcelJS } = options;
  if (populate && !exportModel) {
    throw createSafeExportError("INVALID_EXPORT_MODEL", "An export model is required to populate the workbook.");
  }
  const schema = buildPlanningWorkbookSchema();
  const workbook = createWorkbookStructure(excelApi, schema);
  if (populate) {
    const result = populateWorkbookInputs(
      workbook,
      exportModel,
      buildWorkbookFieldLocationIndex(schema),
      schema,
    );
    workbookPopulationResults.set(workbook, result);
    if (result.errors.length) {
      const codes = [...new Set(result.errors.map((error) => error.code))].join(", ");
      throw createSafeExportError("STANDARD_POPULATION_FAILED", `Workbook population failed (${result.errors.length} issue(s): ${codes}).`);
    }
    const timelineResult = populateWorkbookTimelineOverrides(
      workbook,
      exportModel,
      buildWorkbookTimelineOverrideMap(schema),
      schema,
    );
    workbookTimelinePopulationResults.set(workbook, timelineResult);
    if (timelineResult.errors.length) {
      const codes = [...new Set(timelineResult.errors.map((error) => error.code))].join(", ");
      throw createSafeExportError("TIMELINE_POPULATION_FAILED", `Workbook timeline population failed (${timelineResult.errors.length} issue(s): ${codes}).`);
    }
  }
  return workbook;
}

function buildExportWorkbook(exportModel, excelApi = globalThis.ExcelJS) {
  return createPlanningWorkbook({ populate: true, exportModel, excelApi });
}

function buildBlankPlanningWorkbook(excelApi = globalThis.ExcelJS) {
  return createPlanningWorkbook({ populate: false, excelApi });
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

const WORKBOOK_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// Shared low-level browser download used by the blank and current-plan workflows.
async function downloadExcelWorkbook(workbook, filename) {
  let buffer;
  try {
    buffer = await workbook.xlsx.writeBuffer();
  } catch {
    throw createSafeExportError("WORKBOOK_SERIALIZATION_FAILED");
  }
  const link = document.createElement("a");
  let url = null;
  try {
    url = URL.createObjectURL(new Blob([buffer], { type: WORKBOOK_MIME_TYPE }));
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
  } catch {
    throw createSafeExportError("DOWNLOAD_TRIGGER_FAILED");
  } finally {
    link.remove();
    if (url) setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

async function downloadBlankPlanningWorkbook() {
  await downloadExcelWorkbook(buildBlankPlanningWorkbook(), WORKBOOK_FILENAME);
}

// Local calendar date, independent of locale.
function workbookDateStamp(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// Deliberately independent of the plan contents (no name, balances, or status in the filename).
function currentPlanWorkbookFilename(profile, date = new Date()) {
  return `WealthMap_Current_Plan_${workbookDateStamp(date)}.xlsx`;
}

// Exports the supplied (current) plan as a populated workbook download. Throws errors that carry a
// safe `code`; messages and codes never include plan values.
// Confirms population produced no errors. Throws a safe error without plan values.
function validateWorkbookPopulationResult(workbook) {
  if (!workbook || !workbook.xlsx || typeof workbook.xlsx.writeBuffer !== "function") {
    throw createSafeExportError("INVALID_WORKBOOK_BUILD_RESULT");
  }
  const standard = getWorkbookPopulationResult(workbook);
  const timeline = getWorkbookTimelinePopulationResult(workbook);
  if (standard && standard.errors.length) throw createSafeExportError("STANDARD_POPULATION_FAILED");
  if (timeline && timeline.errors.length) throw createSafeExportError("TIMELINE_POPULATION_FAILED");
}

// Validates the plan, then exports it. Resolves { status, validation }: "downloaded", "invalid"
// (nothing was built), or "warnings" (nothing built until called again with allowWarnings).
// Throws errors that carry a safe `code`; messages and codes never include plan values.
async function downloadCurrentPlanWorkbook(profile = currentWorkingProfile(), options = {}) {
  if (!profile || typeof profile !== "object") throw createSafeExportError("MISSING_CURRENT_PROFILE");
  if (!globalThis.ExcelJS) throw createSafeExportError("WORKBOOK_LIBRARY_UNAVAILABLE");
  let exportModel;
  let validation;
  try {
    exportModel = buildPlanExportModel(profile);
    validation = validateCurrentPlanForExport(exportModel);
  } catch {
    throw createSafeExportError("EXPORT_MODEL_BUILD_FAILED");
  }
  if (!validation.isValid) return { status: "invalid", validation };
  if (validation.warnings.length && !options.allowWarnings) return { status: "warnings", validation };
  let workbook;
  try {
    workbook = buildExportWorkbook(exportModel);
  } catch (error) {
    throw error && error.code ? error : createSafeExportError("WORKBOOK_BUILD_FAILED");
  }
  validateWorkbookPopulationResult(workbook);
  await downloadExcelWorkbook(workbook, currentPlanWorkbookFilename(profile));
  return { status: "downloaded", validation };
}
