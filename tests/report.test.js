const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");

const dataSource = fs.readFileSync(path.join(__dirname, "../data.js"), "utf8");
const appSource = fs.readFileSync(path.join(__dirname, "../app.js"), "utf8");

function loadReportModel() {
  const sandbox = { console, Math, Number, Intl, Object, Array, JSON, Date };
  vm.createContext(sandbox);
  vm.runInContext(
    `${dataSource}\n${appSource}\nvar __wealthMapReport = {
      buildTimelineRows,
      reportCheckpointRows,
      reportPortfolio,
      cloneSampleProfile,
      resolveEffectiveProfile,
      render(profile) {
        workingProfile = profile;
        lastValidProjection = calculate(profile);
        const resolved = resolveEffectiveProfile(profile);
        currentTimelineProfile = resolved.effectiveProfile;
        currentSocialSecurityPlan = resolved.ssPlan;
        currentTimelineRows = buildTimelineRows(resolved.effectiveProfile);
        currentRecommendationItems = [];
        return {
          markup: planReportMarkup(),
          rows: currentTimelineRows,
          profile: resolved.effectiveProfile,
          ssPlan: resolved.ssPlan,
        };
      },
    };`,
    sandbox,
    { filename: "wealth-map-report.js" },
  );
  return sandbox.__wealthMapReport;
}

test("sample report renders unique readiness metrics and populated timeline details", () => {
  const reportModel = loadReportModel();
  const profile = reportModel.cloneSampleProfile();
  const { markup, rows } = reportModel.render(profile);

  assert.equal((markup.match(/Readiness Score/g) || []).length, 1);
  assert.equal((markup.match(/Readiness Status/g) || []).length, 1);
  assert.equal((markup.match(/class="report-page(?:\s|")/g) || []).length, 3);
  assert.match(markup, /Portfolio Outlook/);
  assert.match(markup, /Core Assumptions/);
  assert.match(markup, /Total retirement portfolio/);
  assert.match(markup, /Tax-deferred/);
  assert.match(markup, /Today&#39;s dollars \(real\)/);
  assert.doesNotMatch(markup, /undefined|null|NaN|\[object Object\]/);

  const retirementRow = rows.find((row) => row.age === profile.targetRetirementAge);
  const portfolio = reportModel.reportPortfolio(retirementRow);
  const bucketTotal = portfolio.taxDeferred + portfolio.roth + portfolio.brokerage + portfolio.cash;
  assert.ok(Math.abs(portfolio.total - bucketTotal) < 0.01);
});

test("portfolio outlook merges events at the same age and sorts checkpoints", () => {
  const reportModel = loadReportModel();
  const profile = reportModel.cloneSampleProfile();
  profile.socialSecurityClaimAge = profile.targetRetirementAge;
  profile.rmdStartAge = profile.targetRetirementAge;
  const resolved = reportModel.resolveEffectiveProfile(profile);
  const rows = reportModel.buildTimelineRows(resolved.effectiveProfile);
  const checkpoints = reportModel.reportCheckpointRows(
    rows,
    resolved.effectiveProfile,
    resolved.ssPlan,
    null,
  );
  const retirementCheckpoint = checkpoints.find(
    (checkpoint) => checkpoint.age === profile.targetRetirementAge,
  );

  const checkpointAges = Array.from(checkpoints, (checkpoint) => checkpoint.age);
  assert.deepEqual(
    checkpointAges,
    [...new Set(checkpointAges)].sort((a, b) => a - b),
  );
  assert.match(retirementCheckpoint.labels.join(" "), /Planned retirement/);
  assert.match(retirementCheckpoint.labels.join(" "), /Social Security claim/);
  assert.match(retirementCheckpoint.labels.join(" "), /RMD start/);
});

test("report handles no depletion with Roth conversions and IRMAA disabled", () => {
  const reportModel = loadReportModel();
  const profile = reportModel.cloneSampleProfile();
  profile.assets.brokerage = 10000000;
  profile.retirementAnnualSpendingGoal = 40000;
  profile.rothConversionStrategy = "manual";
  profile.rothConversionAnnualAmount = 0;
  profile.irmaaAnnualSurcharge = 0;
  const { markup } = reportModel.render(profile);

  assert.match(markup, /No projected asset depletion identified\./);
  assert.doesNotMatch(markup, /Projected depletion|Roth conversions begin|First IRMAA year/);
  assert.doesNotMatch(markup, /<span>Roth conversion strategy<\/span>/);
});