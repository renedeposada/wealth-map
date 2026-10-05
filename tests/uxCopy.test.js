const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const indexHtml = fs.readFileSync(
  path.join(__dirname, "../index.html"),
  "utf8",
);
const appJs = fs.readFileSync(path.join(__dirname, "../app.js"), "utf8");
const stylesCss = fs.readFileSync(path.join(__dirname, "../styles.css"), "utf8");

const GLOBAL_DISCLAIMER =
  "WealthMap is an educational retirement planning tool, not a tax, legal, or investment advisor. Consult qualified professionals before making important financial decisions.";

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

test("the Social Security claim-age migration notice is removed", () => {
  assert.ok(!indexHtml.includes("moved to Plan Setup"));
  assert.ok(
    !indexHtml.includes(
      "Set your Social Security claim age directly on the Plan Setup page",
    ),
  );
});

test("boundary and organizational notice panels are removed", () => {
  assert.ok(!indexHtml.includes("Prototype boundary"));
  assert.ok(!appJs.includes("Not modeled in prototype."));
});

test("the global disclaimer appears exactly once in the primary experience", () => {
  assert.equal(countOccurrences(indexHtml, GLOBAL_DISCLAIMER), 1);
});

test("the global disclaimer lives in the footer, not an alert/warning panel", () => {
  const footerMatch = indexHtml.match(
    /<footer class="app-footer">([^<]*)<\/footer>/,
  );
  assert.ok(footerMatch);
  assert.equal(footerMatch[1], GLOBAL_DISCLAIMER);
});

test("the disclaimer is not repeated on individual pages or cards", () => {
  assert.ok(!indexHtml.includes("not financial, tax, or legal advice."));
  assert.ok(!appJs.includes("not financial, tax, or legal advice."));
});

test("recommendation cards explain the situation, action, and rationale", () => {
  assert.ok(appJs.includes("<strong>Current Situation:</strong> ${item.currentSituation}"));
  assert.ok(appJs.includes("<strong>Recommended Action:</strong> ${item.recommendedAction}"));
  assert.ok(appJs.includes("<strong>Why It Matters:</strong> ${item.whyItMatters}"));
  assert.ok(appJs.includes("0.2 * metrics.totalIncome - metrics.employeeSavings"));
  assert.ok(appJs.includes("metrics.fundingDelta"));
  assert.ok(appJs.includes("profile.retirementAnnualSpendingGoal - metrics.safeSpending"));
  assert.ok(appJs.includes("taxDeferred / metrics.financialAssets"));
  assert.ok(appJs.includes("timelineDepletionAge"));
  assert.ok(appJs.includes("timelineIrmaaAge"));
});

test("expected annual return accepts hundredth-percent precision", () => {
  assert.match(
    appJs,
    /key === "expectedAnnualReturn"\s*\?\s*"0\.01"\s*:\s*"0\.1"/,
  );
});

test("Readiness explains the existing score with a progressive, accessible disclosure", () => {
  assert.ok(indexHtml.includes('id="score-summary" aria-live="polite"'));
  assert.ok(indexHtml.includes('id="score-factor-disclosure"'));
  assert.ok(indexHtml.includes("What's impacting your score?"));
  assert.ok(indexHtml.includes('id="score-factor-overview" aria-label="Score factor overview"'));
  assert.ok(indexHtml.includes('id="score-factors-help-button"'));
  assert.ok(indexHtml.includes("These factors explain the existing Readiness Score."));
  assert.ok(indexHtml.includes("Your Readiness Score summarizes how well your projected assets, income, savings, and retirement spending support your plan through the selected planning period."));
  assert.ok(appJs.includes("renderReadinessScoreFactors(null)"));
  assert.ok(appJs.includes("statusOrder[left.status] - statusOrder[right.status]"));
});

test("Readiness links to recommendations and the page separates top and additional items", () => {
  assert.ok(indexHtml.includes('id="readiness-recommendations-cta"') || indexHtml.includes('aria-labelledby="readiness-recommendations-title"'));
  assert.ok(indexHtml.includes('id="readiness-recommendations-button"'));
  assert.ok(indexHtml.includes('data-page="recommendations">View Recommendations</button>'));
  assert.ok(indexHtml.includes("Top Recommendations"));
  assert.ok(indexHtml.includes('<details class="additional-opportunities" id="additional-opportunities" hidden>'));
  assert.ok(indexHtml.includes("Additional Opportunities"));
  assert.ok(appJs.includes("items.slice(0, 3)"));
  assert.ok(appJs.includes("items.slice(3)"));
  assert.ok(appJs.includes("Your plan has ${items.length} recommendation"));
  assert.ok(indexHtml.includes('aria-controls="additional-recommendation-list" aria-expanded="false"'));
  assert.ok(appJs.includes('setAttribute("aria-expanded", String(event.currentTarget.open))'));
});

test("Readiness exports an executive report using existing plan outputs", () => {
  const reportSource = appJs.slice(appJs.indexOf("function planReportMarkup()"), appJs.indexOf("function openPlanReport()"));
  assert.ok(indexHtml.includes('id="export-plan-pdf"'));
  assert.ok(indexHtml.includes('id="plan-report-dialog"'));
  assert.ok(indexHtml.includes('id="print-plan-report"'));
  assert.ok(appJs.includes("recommendationGroups(currentRecommendationItems).top"));
  assert.ok(appJs.includes("buildTimelineMilestones("));
  assert.ok(appJs.includes("function reportCheckpointRows("));
  assert.ok(appJs.includes("function reportPortfolio("));
  assert.ok(appJs.includes("Executive Summary"));
  assert.ok(appJs.includes("Plan Snapshot"));
  assert.ok(appJs.includes("Portfolio Outlook"));
  assert.ok(appJs.includes("Retirement Journey"));
  assert.ok(appJs.includes("Planning Assumptions"));
  assert.ok(appJs.includes("Current Net Worth"));
  assert.ok(appJs.includes("function reportFileTitle("));
  assert.equal(countOccurrences(reportSource, 'reportMetric("Readiness Score"'), 1);
  assert.equal(countOccurrences(reportSource, 'reportMetric("Readiness Status"'), 1);
  assert.ok(appJs.includes('row.endBalances'));
  assert.ok(appJs.includes('buildTimelineMilestones('));
  assert.ok(indexHtml.includes("Turn off Headers and footers"));
  assert.ok(appJs.includes("None projected through life expectancy"));
  assert.ok(appJs.includes("This report is based on user-provided assumptions and planning inputs."));
  assert.match(stylesCss, /@media print\s*\{/);
  assert.ok(stylesCss.includes(".report-page:last-child"));
});

test("required plan setup validation standby message is preserved", () => {
  assert.ok(
    indexHtml.includes(
      "Projections are paused until required plan inputs are valid.",
    ),
  );
});

test("model-generated strategy labels remain understandable", () => {
  assert.ok(appJs.includes("Model-recommended"));
  assert.ok(appJs.includes("Social Security Strategy"));
  assert.ok(
    appJs.includes(
      "allow WealthMap to evaluate multiple claiming ages and recommend the option that best supports the current plan",
    ),
  );
  assert.ok(appJs.includes("Roth Conversion Strategy"));
});

test("contextual strategy tooltips remain keyboard accessible buttons", () => {
  assert.ok(appJs.includes('id="ss-strategy-help-button"'));
  assert.ok(appJs.includes('id="roth-strategy-help-button"'));
  assert.ok(appJs.includes('aria-label="About the Social Security strategy"'));
  assert.ok(appJs.includes('aria-label="About the Roth conversion strategy"'));
});

test("metric help buttons are wired through delegated, keyboard-triggerable click handling", () => {
  assert.ok(appJs.includes('closest(".metric-help-button")'));
});

test("page navigation updates the browser hash so back and forward navigation works", () => {
  assert.ok(appJs.includes("location.hash"));
  assert.ok(appJs.includes("hashchange"));
  assert.ok(appJs.includes("showPage(getPageFromHash") || appJs.includes("showPage(getPageFromHash()"));
});

test("withdrawal detail has a contextual explanatory tooltip for the retirement withdrawal sequence", () => {
  assert.ok(indexHtml.includes('id="timeline-withdrawal-sequence-help-button"'));
  assert.ok(
    indexHtml.includes(
      'aria-controls="timeline-withdrawal-sequence-help" aria-label="About Withdrawal Sequence"',
    ),
  );
  assert.ok(
    indexHtml.includes(
      'id="timeline-withdrawal-sequence-help" role="tooltip" data-help-button-id="timeline-withdrawal-sequence-help-button" hidden',
    ),
  );
  assert.ok(indexHtml.includes("Shows how retirement withdrawals are funded."));
  assert.ok(indexHtml.includes("Cash, Brokerage, Tax-Deferred Accounts, and Roth Accounts"));
  assert.ok(indexHtml.includes("RMDs are shown separately."));
});

test("additional annual savings explains the brokerage and cash allocation", () => {
  assert.ok(indexHtml.includes("Additional Annual Savings"));
  assert.ok(!indexHtml.includes("Available Annual Savings"));
  assert.ok(indexHtml.includes('id="additional-annual-savings-help-button"'));
  assert.ok(
    indexHtml.includes(
      'aria-controls="additional-annual-savings-help" aria-label="About Additional Annual Savings"',
    ),
  );
  assert.ok(
    indexHtml.includes(
      "Money remaining after estimated taxes, current expenses, and retirement account contributions. WealthMap allocates this amount between Brokerage and Cash based on your selected percentages.",
    ),
  );
  assert.ok(
    indexHtml.includes(
      'Additional Annual Savings: <strong id="available-annual-savings">$0</strong>',
    ),
  );
  assert.ok(
    indexHtml.includes(
      'Brokerage: <strong id="brokerage-contribution-amount">$0</strong>',
    ),
  );
  assert.ok(appJs.includes('"% of Additional Annual Savings"'));
  assert.ok(
    appJs.includes(
      "Percentage of Additional Annual Savings allocated to a taxable brokerage account.",
    ),
  );
  assert.ok(
    appJs.includes(
      "Percentage of Additional Annual Savings allocated to cash reserves.",
    ),
  );
});

test("savings strategy has an accessible explanation of allocation choices", () => {
  assert.ok(indexHtml.includes('aria-label="Savings Strategy"'));
  assert.ok(indexHtml.includes('id="savings-strategy-help-button"'));
  assert.ok(
    indexHtml.includes(
      'aria-controls="savings-strategy-help" aria-label="About Savings Strategy"',
    ),
  );
  assert.ok(
    indexHtml.includes(
      "Controls how income is allocated toward retirement accounts, employer-sponsored plans, brokerage investments, and cash savings.",
    ),
  );
  assert.ok(
    indexHtml.includes(
      "Changes made here directly affect retirement projections, readiness calculations, and long-term wealth accumulation.",
    ),
  );
});

test("after-tax income has an accessible planning-estimate tooltip", () => {
  assert.ok(indexHtml.includes('id="after-tax-income-help-button"'));
  assert.ok(
    indexHtml.includes(
      'aria-controls="after-tax-income-help" aria-label="About After-Tax Income"',
    ),
  );
  assert.ok(
    indexHtml.includes(
      "Estimated income remaining after federal taxes, state taxes, and pre-tax retirement contributions.",
    ),
  );
  assert.ok(
    indexHtml.includes(
      "This amount is used to fund current expenses, Roth IRA contributions, and Additional Annual Savings.",
    ),
  );
  assert.ok(
    indexHtml.includes(
      "This is a planning estimate based on the tax assumptions configured in your plan.",
    ),
  );
});

test("additional annual savings KPI has an accessible explanation", () => {
  assert.ok(
    indexHtml.includes('id="additional-annual-savings-summary-help-button"'),
  );
  assert.ok(
    indexHtml.includes(
      'aria-controls="additional-annual-savings-summary-help" aria-label="About Additional Annual Savings"',
    ),
  );
  assert.ok(
    indexHtml.includes(
      "Money remaining after estimated taxes, current expenses, and retirement account contributions.",
    ),
  );
  assert.ok(
    indexHtml.includes(
      "WealthMap allocates this amount between Brokerage and Cash based on your selected allocation percentages.",
    ),
  );
  assert.ok(
    indexHtml.includes(
      "Additional Annual Savings represents non-retirement savings that remain available outside retirement accounts.",
    ),
  );
});

test("annual savings rate has an accessible explanatory tooltip", () => {
  assert.ok(indexHtml.includes('id="annual-savings-rate-help-button"'));
  assert.ok(
    indexHtml.includes(
      'aria-controls="annual-savings-rate-help" aria-label="About Annual Savings Rate"',
    ),
  );
  assert.ok(
    indexHtml.includes(
      'id="annual-savings-rate-help" role="tooltip" data-help-button-id="annual-savings-rate-help-button" hidden',
    ),
  );
  assert.ok(
    indexHtml.includes(
      "Your retirement account contributions and Additional Annual Savings, divided by gross annual income. WealthMap uses 20% as its savings-rate benchmark for retirement readiness.",
    ),
  );
});

test("total retirement contributions has an accessible explanation of retirement savings", () => {
  assert.ok(indexHtml.includes("Total Retirement Contributions"));
  assert.ok(!indexHtml.includes("Your Annual Savings"));
  assert.ok(
    indexHtml.includes('id="total-retirement-contributions-help-button"'),
  );
  assert.ok(
    indexHtml.includes(
      'aria-controls="total-retirement-contributions-help" aria-label="About Total Retirement Contributions"',
    ),
  );
  assert.ok(
    indexHtml.includes(
      'id="total-retirement-contributions-help" role="tooltip" data-help-button-id="total-retirement-contributions-help-button" hidden',
    ),
  );
  assert.ok(
    indexHtml.includes(
      "The total amount contributed each year to retirement accounts, including employee contributions and employer matching contributions.",
    ),
  );
  assert.ok(indexHtml.includes("<li>401(k) Contributions</li>"));
  assert.ok(indexHtml.includes("<li>Traditional IRA Contributions</li>"));
  assert.ok(indexHtml.includes("<li>Roth IRA Contributions</li>"));
  assert.ok(indexHtml.includes("<li>Employer Match</li>"));
  assert.ok(
    indexHtml.includes(
      "These contributions are intended to support your long-term retirement goals.",
    ),
  );
  assert.ok(indexHtml.includes('id="retirement-contributions"'));
});

test("total annual savings has an accessible explanation of all contributions", () => {
  assert.ok(indexHtml.includes("Total Annual Savings"));
  assert.ok(!indexHtml.includes("Total retirement contributions"));
  assert.ok(indexHtml.includes('id="total-annual-savings-help-button"'));
  assert.ok(
    indexHtml.includes(
      'aria-controls="total-annual-savings-help" aria-label="About Total Annual Savings"',
    ),
  );
  assert.ok(
    indexHtml.includes(
      'id="total-annual-savings-help" role="tooltip" data-help-button-id="total-annual-savings-help-button" hidden',
    ),
  );
  assert.ok(
    indexHtml.includes(
      "The total amount saved each year across retirement accounts, employer matching contributions, brokerage investments, and cash savings.",
    ),
  );
  assert.ok(
    indexHtml.includes(
      "This includes 401(k), Traditional IRA, Roth IRA, Employer Match, Brokerage Contributions, and Cash Contributions.",
    ),
  );
  assert.ok(
    indexHtml.includes(
      "This metric helps you understand how much of your annual income is being directed toward your long-term financial goals.",
    ),
  );
  assert.ok(indexHtml.includes('id="total-annual-savings"'));
  assert.ok(indexHtml.includes('id="available-annual-savings-summary"'));
});

test("the redundant after-tax annual surplus metric is removed from Income and Expenses", () => {
  assert.ok(!indexHtml.includes("After-tax annual surplus"));
  assert.ok(!indexHtml.includes('id="annual-surplus"'));
  assert.ok(!appJs.includes('setText("#annual-surplus"'));
});

test("no blank notice-panel section remains where removed content used to be", () => {
  assert.ok(!indexHtml.includes('<section class="notice-panel">'));
});

test("the cash reserve field uses its renamed user-facing label", () => {
  assert.ok(appJs.includes('"Cash Reserve (Years of Spending)"'));
  assert.ok(!appJs.includes("Retirement cash reserve target"));
  assert.ok(!indexHtml.includes("Retirement cash reserve target"));
});

test("the cash reserve field keeps its internal field key and unit text", () => {
  assert.ok(appJs.includes('"cashReserveTargetYears"'));
  assert.ok(appJs.includes('"years of spending"'));
});

test("plan setup fields with contextual help reuse the metric-help pattern with keyboard-accessible icons", () => {
  assert.ok(appJs.includes("const PLAN_SETUP_FIELD_HELP"));
  assert.ok(
    appJs.includes('helpButton.className = "info-button metric-help-button"'),
  );
  assert.ok(
    appJs.includes('helpButton.setAttribute("aria-expanded", "false")'),
  );
  assert.ok(
    appJs.includes(
      'helpButton.setAttribute("aria-controls", `${helpSlug}-help`)',
    ),
  );
  assert.ok(
    appJs.includes(
      'helpButton.setAttribute("aria-label", `About ${fieldHelp.title}`)',
    ),
  );
  assert.ok(appJs.includes('helpPanel.setAttribute("role", "tooltip")'));
  assert.ok(appJs.includes("helpPanel.dataset.helpButtonId = helpButton.id"));
  assert.ok(appJs.includes("helpPanel.hidden = true"));
});

test("plan setup contextual help covers the required fields with concise, user-focused tooltip text", () => {
  const expectedHelp = {
    "Safe Withdrawal Rate":
      "The percentage of your retirement portfolio that can be withdrawn annually to help support retirement spending. Higher rates require fewer assets but may increase the risk of running out of money later in retirement.",
    "Social Security Annual Benefit":
      "Annual Social Security benefit at Full Retirement Age (67). If Automatic Estimate is selected, WealthMap estimates this value from your earnings. Claim Age adjustments are applied separately.",
    "Social Security Claim Age":
      "The age at which Social Security benefits begin. Claiming earlier reduces benefits. Claiming later increases benefits.",
    "Expected Annual Return":
      "Expected long-term annual portfolio growth before inflation. WealthMap converts this assumption into a real return using your inflation rate.",
    "Inflation Rate":
      "Expected annual increase in the cost of living. WealthMap uses this assumption to express projections in today's purchasing power.",
    "Retirement Spending Goal":
      "Target annual spending during retirement expressed in today's dollars. This value is used throughout readiness, timeline, and retirement asset calculations.",
    "Traditional IRA Annual Contribution":
      "Annual contribution to a Traditional IRA. Contributions are treated as pre-tax retirement savings in the model.",
    "Roth IRA Annual Contribution":
      "Annual contribution to a Roth IRA. Contributions are made with after-tax dollars and can grow tax-free in the model.",
    "Cash Reserve (Years of Spending)":
      "Sets how many years of retirement spending the model aims to keep in cash. In positive-return years, available brokerage assets may be moved to cash to refill this reserve, helping reduce the need to sell investments during market declines.",
    "Pre-Tax Withdrawal Tax Rate":
      "Estimated tax rate applied to future withdrawals from tax-deferred retirement accounts such as 401(k)s and Traditional IRAs.",
    "RMD Start Age":
      "Age at which Required Minimum Distributions (RMDs) begin from eligible tax-deferred retirement accounts.",
    "Taxable Gains Tax Rate":
      "Estimated tax rate applied to investment gains generated within taxable brokerage accounts.",
    "IRMAA Income Threshold":
      "Income level above which Medicare income-related monthly adjustment amounts (IRMAA) may apply.",
    "Annual IRMAA Surcharge":
      "Estimated annual Medicare surcharge applied when income exceeds the IRMAA threshold.",
    "Annual Roth Conversion":
      "Annual amount converted from tax-deferred retirement accounts into Roth accounts when using the manual Roth conversion strategy.",
  };
  Object.entries(expectedHelp).forEach(([title, text]) => {
    assert.ok(
      appJs.includes(`title: "${title}"`),
      `missing help title: ${title}`,
    );
    assert.ok(appJs.includes(text), `missing help text for: ${title}`);
  });
});

test("other assets tooltip informs the user that real estate is shown separately from the retirement portfolio", () => {
  assert.ok(
    indexHtml.includes('id="other-assets-help"') &&
      indexHtml.includes(
        "Real estate is shown separately from the retirement portfolio.",
      ),
  );
});
