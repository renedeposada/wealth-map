// Workbook import validation: field, cross-field, Timeline, and Timeline-override rules.
// Pure functions over a normalized import candidate (see buildImportCandidate in workbookImport.js);
// they never touch workingProfile, the DOM, or the calculation engine, so they can run before any
// state mutation. Rules are small functions in IMPORT_VALIDATION_RULES and are easy to extend.
// Depends on buildSupportedInputInventory() (workbook.js), TIMELINE_OVERRIDE_FIELDS and the
// optional PlanSetupValidation (validation.js).
//
// Candidate shape:
//   inventory   supported-input inventory items
//   values      fieldId -> normalized cell value (number | string | other raw) or null when blank
//   effective   fieldId -> value used by the plan (blank optional fields resolved to defaults)
//   locations   fieldId -> { worksheet, row, column }
//   overrideRows [{ row, age, values: { overrideField: rawValue } }]   (return in Excel fraction scale)
//   profile     plan profile assembled from `effective` (used only for the final Plan Setup check)

const IMPORT_AGE_LIMITS = Object.freeze({ currentMin: 18, currentMax: 100 });
const IMPORT_ALLOCATION_TOLERANCE = 0.001;
const IMPORT_SECTION_TIMELINE = "Timeline";
const IMPORT_SECTION_OVERRIDES = "Timeline Overrides";

function createImportValidationResult(issues = []) {
  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");
  return { valid: errors.length === 0, errors, warnings };
}

function importIssue(severity, section, field, message, extra = {}) {
  const issue = { severity, section, message };
  if (field) issue.field = field;
  Object.keys(extra).forEach((key) => {
    if (extra[key] != null) issue[key] = extra[key];
  });
  return issue;
}

function importIsFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function importLabelOf(candidate, fieldId) {
  const item = candidate.inventory.find((entry) => entry.fieldId === fieldId);
  return item ? item.label : fieldId;
}

function importFieldIssue(candidate, severity, fieldId, message) {
  const item = candidate.inventory.find((entry) => entry.fieldId === fieldId);
  const location = (candidate.locations && candidate.locations[fieldId]) || {};
  return importIssue(severity, item ? item.worksheet : "Plan Setup", item ? item.label : fieldId, message, {
    fieldId,
    worksheet: location.worksheet,
    row: location.row,
    column: location.column,
  });
}

// A numeric effective value, or null when it is missing or not a valid number.
function importNumber(candidate, fieldId) {
  const value = candidate.effective ? candidate.effective[fieldId] : null;
  return importIsFiniteNumber(value) ? value : null;
}

function importIsBlank(candidate, fieldId) {
  const value = candidate.values[fieldId];
  return value === null || value === undefined;
}

function importAllowedLabels(item) {
  return (item.allowedValues || []).map((option) => option.label);
}

// Required, type, and range rules for every supported standard input, one field at a time.
function validateImportFields(candidate) {
  const issues = [];
  candidate.inventory
    .filter((item) => item.worksheet !== WORKBOOK_SHEETS.timeline)
    .forEach((item) => {
      const value = candidate.values[item.fieldId];
      const add = (message) => issues.push(importFieldIssue(candidate, "error", item.fieldId, message));
      if (importIsBlank(candidate, item.fieldId)) {
        if (item.required) add(`${item.label} is required.`);
        return;
      }
      switch (item.dataType) {
        case "select":
          if (!importAllowedLabels(item).includes(value)) {
            add(`${item.label} must be one of: ${importAllowedLabels(item).join(", ")}.`);
          }
          break;
        case "text":
          if (typeof value !== "string") add(`${item.label} must be text.`);
          break;
        default: {
          if (!importIsFiniteNumber(value)) {
            add(`${item.label} must be a valid number.`);
          } else if (value < 0) {
            add(`${item.label} cannot be negative.`);
          } else if (item.dataType === "percent" && value > 1) {
            add(`${item.label} cannot exceed 100%.`);
          } else if (item.dataType === "integer" && !Number.isInteger(value)) {
            add(`${item.label} must be a whole number.`);
          }
        }
      }
    });
  return issues;
}

// Returns the validated age triple, or nulls for any age that is missing or invalid.
function importAges(candidate) {
  return {
    current: importNumber(candidate, "currentAge"),
    target: importNumber(candidate, "targetRetirementAge"),
    life: importNumber(candidate, "lifeExpectancy"),
  };
}

function validateImportAges(candidate) {
  const issues = [];
  const { current, target, life } = importAges(candidate);
  const add = (fieldId, message) => issues.push(importFieldIssue(candidate, "error", fieldId, message));
  if (current !== null && (current < IMPORT_AGE_LIMITS.currentMin || current > IMPORT_AGE_LIMITS.currentMax)) {
    add("currentAge", `Current age must be between ${IMPORT_AGE_LIMITS.currentMin} and ${IMPORT_AGE_LIMITS.currentMax}.`);
  }
  if (current !== null && target !== null && target <= current) {
    add("targetRetirementAge", "Target retirement age must be greater than current age.");
  }
  if (target !== null && life !== null && target > life) {
    add("targetRetirementAge", "Target retirement age cannot exceed life expectancy.");
  }
  if (target !== null && life !== null && target === life) {
    add("lifeExpectancy", "Retirement duration must be greater than zero; life expectancy must be later than the target retirement age.");
  }
  if (current !== null && life !== null && life <= current) {
    add("lifeExpectancy", "Life expectancy must be greater than current age.");
  }
  return issues;
}

function validateImportSavings(candidate) {
  const issues = [];
  const salary = importNumber(candidate, "annualSalary");
  const other = importNumber(candidate, "otherAnnualIncome");
  const rate = importNumber(candidate, "contributionRates.fourOhOneK");
  const traditional = importNumber(candidate, "iraContributions.traditionalIraAnnual");
  const roth = importNumber(candidate, "iraContributions.rothIraAnnual");
  const expenses = importNumber(candidate, "currentAnnualExpenses");
  if (expenses === 0) {
    issues.push(importFieldIssue(candidate, "warning", "currentAnnualExpenses", "Annual expenses are zero. Retirement projections may be unrealistic."));
  }
  if ([salary, other, rate, traditional, roth].some((value) => value === null)) return issues;
  const income = salary + other;
  // Employer match is added on top of the employee's own contribution, so it never competes with
  // income; only employee 401(k) and IRA contributions are funded from the user's income.
  const funded = salary * rate + traditional + roth;
  if (funded > income + 1e-9) {
    issues.push(importFieldIssue(candidate, "error", "contributionRates.fourOhOneK", "Annual savings cannot exceed annual income: 401(k), Traditional IRA, and Roth IRA contributions together are larger than salary plus other income."));
  }
  return issues;
}

function validateImportAllocation(candidate) {
  const brokerageBlank = importIsBlank(candidate, "savingsAllocation.brokerage");
  const cashBlank = importIsBlank(candidate, "savingsAllocation.cash");
  if (brokerageBlank && cashBlank) return [];
  const brokerage = brokerageBlank ? 0 : candidate.values["savingsAllocation.brokerage"];
  const cash = cashBlank ? 0 : candidate.values["savingsAllocation.cash"];
  if (!importIsFiniteNumber(brokerage) || !importIsFiniteNumber(cash)) return [];
  if (Math.abs(brokerage + cash - 1) > IMPORT_ALLOCATION_TOLERANCE + 1e-9) {
    return [importFieldIssue(candidate, "error", "savingsAllocation.brokerage", "Investment allocation must total 100%: Brokerage Allocation and Cash Allocation together must equal 100%.")];
  }
  return [];
}

function validateImportSocialSecurity(candidate) {
  const issues = [];
  if (!importIsBlank(candidate, "socialSecurityClaimAge")) {
    const age = candidate.values.socialSecurityClaimAge;
    if (importIsFiniteNumber(age) && (age < 62 || age > 70)) {
      issues.push(importFieldIssue(candidate, "error", "socialSecurityClaimAge", "Social Security claim age must be between 62 and 70."));
    }
  }
  const mode = candidate.effective.socialSecurityBenefitMode;
  const benefit = importNumber(candidate, "socialSecurityAnnualBenefit");
  if (mode === "manual" && (benefit === null || benefit === 0)) {
    issues.push(importFieldIssue(candidate, "warning", "socialSecurityAnnualBenefit", "Social Security benefit is set to Enter manually but no annual benefit was entered, so it will be treated as $0."));
  }
  return issues;
}

function validateImportTimeline(candidate) {
  const issues = [];
  const { current, target, life } = importAges(candidate);
  const add = (field, message) => issues.push(importIssue("error", IMPORT_SECTION_TIMELINE, field, message));
  if (current === null || life === null) return issues;
  if (current >= life) {
    add("Current age / Life expectancy", "The simulation timeline must start before it ends (current age must be less than life expectancy).");
    return issues;
  }
  if (life - current <= 0) add("Timeline length", "The simulation timeline must span at least one year.");
  if (target !== null && (target < current || target > life)) {
    add("Target retirement age", "Target retirement age falls outside the simulation timeline.");
  }
  return issues;
}

function importOverrideApplies(field, age, targetAge) {
  const definition = TIMELINE_OVERRIDE_FIELDS.find((entry) => entry.field === field);
  if (!definition) return false;
  if (definition.period === "any") return true;
  return definition.period === "working" ? age < targetAge : age >= targetAge;
}

function importOverrideRowHasValues(row) {
  return Object.values(row.values).some((value) => value !== null && value !== undefined);
}

function validateImportOverrides(candidate) {
  const issues = [];
  const { current, target, life } = importAges(candidate);
  const timelineKnown = current !== null && life !== null && current < life;
  const rows = (candidate.overrideRows || []).filter(importOverrideRowHasValues);
  const countByAge = new Map();
  rows.forEach((row) => {
    if (Number.isInteger(row.age)) countByAge.set(row.age, (countByAge.get(row.age) || 0) + 1);
  });
  const reportedDuplicates = new Set();

  rows.forEach((row) => {
    const where = { worksheet: WORKBOOK_SHEETS.timeline, row: row.row };
    const add = (severity, message, field = null) =>
      issues.push(importIssue(severity, IMPORT_SECTION_OVERRIDES, field, message, where));
    if (!Number.isInteger(row.age)) {
      add("error", `Row ${row.row}: Age must be a whole number for an override to be used.`, "Age");
      return;
    }
    if (countByAge.get(row.age) > 1) {
      if (!reportedDuplicates.has(row.age)) {
        reportedDuplicates.add(row.age);
        add("error", `Multiple timeline overrides exist for age ${row.age}.`, "Age");
      }
      return;
    }
    if (timelineKnown && (row.age < current || row.age > life)) {
      add("error", `Override age ${row.age} is outside the timeline range (${current}-${life}).`, "Age");
      return;
    }
    TIMELINE_OVERRIDE_FIELDS.forEach((definition) => {
      const value = row.values[definition.field];
      if (value === null || value === undefined) return;
      const label = `${definition.label} for age ${row.age}`;
      if (!importIsFiniteNumber(value)) {
        add("error", `${label} must be a valid number.`, definition.label);
        return;
      }
      const minimum = definition.field === "returnPercent" ? -1 : 0;
      if (value < minimum) {
        add("error", definition.field === "returnPercent" ? `${label} cannot be below -100%.` : `${label} cannot be negative.`, definition.label);
        return;
      }
      if (target !== null && timelineKnown && !importOverrideApplies(definition.field, row.age, target)) {
        const when = definition.period === "working" ? "after retirement age" : "before retirement age";
        add("warning", `${definition.label} for age ${row.age} is set ${when}. It does not apply to that year, so it will be ignored. Please verify this is intentional.`, definition.label);
      }
    });
  });
  return issues;
}

// Re-runs the application's own Plan Setup validation so an imported plan can never be one the app
// would refuse to accept. Only used when the rules above found no errors, to avoid duplicate messages.
function validateImportAgainstPlanSetup(candidate, validator = typeof PlanSetupValidation !== "undefined" ? PlanSetupValidation : null) {
  if (!validator || !candidate.profile) return [];
  const result = validator.validatePlanSetup(candidate.profile);
  const issue = (severity) => (entry) =>
    importIssue(severity, "Plan Setup", entry.field ? importLabelOf(candidate, entry.field) : null, entry.message, { fieldId: entry.field });
  return [...result.blockingErrors.map(issue("error")), ...result.warnings.map(issue("warning"))];
}

function validateImportDefaults(candidate) {
  const names = (candidate.defaulted || []).map((fieldId) => importLabelOf(candidate, fieldId));
  if (names.length === 0) return [];
  return [importIssue("warning", "Plan Setup", null, `${names.length} optional setting(s) were left blank and will use WealthMap defaults or zero: ${names.join(", ")}.`)];
}

// Ordered, extensible rule list. Each rule receives the candidate and returns ValidationIssue[].
const IMPORT_VALIDATION_RULES = [
  validateImportFields,
  validateImportAges,
  validateImportSavings,
  validateImportAllocation,
  validateImportSocialSecurity,
  validateImportTimeline,
  validateImportOverrides,
  validateImportDefaults,
];

function validateImportCandidate(candidate, options = {}) {
  const rules = options.rules || IMPORT_VALIDATION_RULES;
  const issues = rules.flatMap((rule) => rule(candidate));
  if (!issues.some((issue) => issue.severity === "error")) {
    issues.push(...validateImportAgainstPlanSetup(candidate, options.planSetupValidator));
  }
  return createImportValidationResult(issues);
}

function formatImportValidationReport(result) {
  const lines = ["Import Validation Results", ""];
  [["Errors", result.errors], ["Warnings", result.warnings]].forEach(([title, items]) => {
    if (items.length === 0) return;
    lines.push(`${title} (${items.length})`, "--------------");
    items.forEach((issue) => lines.push(`• ${issue.message}`));
    lines.push("");
  });
  if (!result.valid) lines.push("Import blocked until errors are resolved.");
  return lines.join("\n");
}
