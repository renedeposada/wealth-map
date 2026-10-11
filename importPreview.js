// Import preview model: a pure, read-only comparison of an import candidate against the current plan.
// Everything is derived from the candidate and the supported-input inventory, so new inputs and new
// workbook versions appear in the preview without any change here. Nothing in this file touches
// application state, the DOM, or the calculation engine.
//
// ImportPreview {
//   validationResult   { valid, errors, warnings }
//   stats              { sections, fields, errors, warnings, overrides }
//   importedSections   [{ worksheet, sections: [{ title, fields: [PreviewField] }] }]   (valid imports only)
//   changedFields      [{ section, field, fieldId, currentValue, importedValue, currentDisplay, importedDisplay }]
//   overrideSummary    { imported: [OverrideRow], added, modified, removed, ... }
// }

const IMPORT_PREVIEW_EMPTY = "—";

const importPreviewCurrency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

function importPreviewNumbersEqual(a, b) {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 1e-9;
  return a === b;
}

function importPreviewPercent(fraction) {
  return `${Number((fraction * 100).toFixed(4))}%`;
}

// Displays a stored (internal) value the way the application's own inputs show it.
function formatImportPreviewValue(item, value) {
  if (value === null || value === undefined || value === "") return IMPORT_PREVIEW_EMPTY;
  if (item.dataType === "select") {
    const option = (item.allowedValues || []).find((entry) => entry.value === value);
    return option ? option.label : String(value);
  }
  if (typeof value !== "number" || !Number.isFinite(value)) return String(value);
  if (item.dataType === "currency") return importPreviewCurrency.format(value);
  if (item.dataType === "percent") return importPreviewPercent(value);
  return item.unit && item.unit !== "text" ? `${value} ${item.unit}`.trim() : String(value);
}

function importPreviewPathGet(object, fieldId) {
  return fieldId.split(".").reduce((value, key) => (value == null ? undefined : value[key]), object);
}

function importPreviewStandardItems(candidate) {
  return candidate.inventory.filter((item) => item.worksheet !== WORKBOOK_SHEETS.timeline);
}

function importPreviewOverrideFields(options) {
  return options.overrideFields || TIMELINE_OVERRIDE_FIELDS;
}

function formatImportPreviewOverride(definition, value) {
  if (definition.dataType === "percent") return `${Number(value.toFixed(4))}%`;
  return importPreviewCurrency.format(value);
}

function buildImportOverrideSummary(currentOverrides, importedOverrides, options = {}) {
  const definitions = importPreviewOverrideFields(options);
  const rows = [];
  Object.keys(importedOverrides)
    .map(Number)
    .sort((a, b) => a - b)
    .forEach((age) => {
      definitions.forEach((definition) => {
        const value = importedOverrides[age][definition.field];
        if (typeof value !== "number") return;
        rows.push({ age, field: definition.field, label: definition.label, value, display: formatImportPreviewOverride(definition, value) });
      });
    });
  const ages = (overrides) => Object.keys(overrides).map(Number);
  const sameAge = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const added = ages(importedOverrides).filter((age) => !(age in currentOverrides));
  const removed = ages(currentOverrides).filter((age) => !(age in importedOverrides));
  const modified = ages(importedOverrides).filter(
    (age) => age in currentOverrides && !sameAge(sortedOverride(currentOverrides[age]), sortedOverride(importedOverrides[age])),
  );
  return { imported: rows, added, modified, removed, count: ages(importedOverrides).length };
}

function sortedOverride(entry) {
  return Object.keys(entry)
    .sort()
    .map((key) => [key, entry[key]]);
}

function buildImportPreview(candidate, validationResult, currentProfile, options = {}) {
  const items = importPreviewStandardItems(candidate);
  const entered = items.filter((item) => candidate.values[item.fieldId] !== null && candidate.values[item.fieldId] !== undefined);
  const preview = {
    validationResult,
    stats: {
      sections: new Set(entered.map((item) => `${item.worksheet}/${item.section}`)).size,
      fields: entered.length,
      errors: validationResult.errors.length,
      warnings: validationResult.warnings.length,
      overrides: 0,
    },
    importedSections: [],
    changedFields: [],
    overrideSummary: { imported: [], added: [], modified: [], removed: [], count: 0 },
  };

  if (!validationResult.valid) {
    // Rejected values can be arbitrary text, so only counts are reported until the workbook is fixed.
    preview.stats.overrides = (candidate.overrideRows || []).filter((row) =>
      Object.values(row.values).some((value) => value !== null && value !== undefined),
    ).length;
    return preview;
  }

  const worksheets = new Map();
  items.forEach((item) => {
    const importedValue = candidate.effective[item.fieldId];
    const currentValue = importPreviewPathGet(currentProfile, item.fieldId);
    const changed = !importPreviewNumbersEqual(currentValue ?? null, importedValue ?? null) && !(currentValue == null && importedValue === "");
    const field = {
      fieldId: item.fieldId,
      label: item.label,
      currentValue,
      importedValue,
      currentDisplay: formatImportPreviewValue(item, currentValue),
      importedDisplay: formatImportPreviewValue(item, importedValue),
      changed,
      fromWorkbook: candidate.values[item.fieldId] !== null && candidate.values[item.fieldId] !== undefined,
    };
    if (!worksheets.has(item.worksheet)) worksheets.set(item.worksheet, new Map());
    const sections = worksheets.get(item.worksheet);
    if (!sections.has(item.section)) sections.set(item.section, []);
    sections.get(item.section).push(field);
    if (changed) {
      preview.changedFields.push({
        section: `${item.worksheet} › ${item.section}`,
        field: item.label,
        fieldId: item.fieldId,
        currentValue,
        importedValue,
        currentDisplay: field.currentDisplay,
        importedDisplay: field.importedDisplay,
      });
    }
  });
  worksheets.forEach((sections, worksheet) => {
    preview.importedSections.push({
      worksheet,
      sections: Array.from(sections, ([title, fields]) => ({ title, fields })),
    });
  });

  preview.overrideSummary = buildImportOverrideSummary(
    currentProfile.timelineOverrides || {},
    candidate.profile.timelineOverrides || {},
    options,
  );
  preview.stats.overrides = preview.overrideSummary.count;
  return preview;
}

// Plain-language "Plan Impact Summary" lines.
function describeImportImpact(preview) {
  const summary = preview.overrideSummary;
  const plural = (count, singular, pluralText) => `${count} ${count === 1 ? singular : pluralText}`;
  return [
    `${plural(preview.changedFields.length, "value", "values")} will change`,
    `${plural(summary.added.length, "timeline override", "timeline overrides")} will be added`,
    `${plural(summary.modified.length, "timeline override", "timeline overrides")} will be modified`,
    `${plural(summary.removed.length, "timeline override", "timeline overrides")} will be removed`,
  ];
}

const IMPORT_REPORT_FILENAME = "wealthmap-import-validation-report.txt";

function formatImportValidationReportText(result, describe = (issue) => issue.message) {
  const section = (title, items) => [`${title}:`, ...(items.length ? items.map((issue) => `- ${describe(issue)}`) : ["- None"]), ""];
  const lines = ["Import Validation Report", ""];
  if (result.fileName) lines.push(`Workbook: ${result.fileName}`, "");
  lines.push(...section("Errors", result.errors), ...section("Warnings", result.warnings));
  if (result.errors.length) lines.push("Import blocked until errors are resolved.");
  return `${lines.join("\n").trimEnd()}\n`;
}
