const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

function loadRecommendationModel() {
  const dataSource = fs.readFileSync(path.join(__dirname, "../data.js"), "utf8");
  const appSource = fs.readFileSync(path.join(__dirname, "../app.js"), "utf8");
  const sandbox = { console, Math, Number, Intl, Object, Array, JSON, Date };
  vm.createContext(sandbox);
  vm.runInContext(
    `${dataSource}\n${appSource}\nvar __wealthMap = { recommendations, recommendationGroups, recommendationSectionHeading, readinessRecommendationsCallToAction, timelineSummary, buildTimelineRows, buildTimelineMilestones, resolveEffectiveProfile, calculate, cloneSampleProfile };`,
    sandbox,
    { filename: "wealth-map-recommendations.js" },
  );
  return sandbox.__wealthMap;
}

const {
  recommendations,
  recommendationGroups,
  recommendationSectionHeading,
  readinessRecommendationsCallToAction,
  timelineSummary,
  buildTimelineRows,
  buildTimelineMilestones,
  resolveEffectiveProfile,
  calculate,
  cloneSampleProfile,
} = loadRecommendationModel();

function baseMetrics(overrides = {}) {
  return {
    timelineDepletionAge: null,
    fundingDelta: 0,
    safeSpending: 50000,
    savingsRate: 0.25,
    totalIncome: 100000,
    employeeSavings: 25000,
    financialAssets: 1000000,
    projectedRothConversion: 0,
    firstRothConversionAge: null,
    firstRothConversionAmount: 0,
    projectedRmd: 0,
    timelineIrmaaAge: null,
    ...overrides,
  };
}

function baseProfile(overrides = {}) {
  return {
    retirementAnnualSpendingGoal: 50000,
    assets: { fourOhOneK: 600000, traditionalIra: 0 },
    rothConversionStrategy: "manual",
    rothConversionAnnualAmount: 0,
    ...overrides,
  };
}

test("timeline summary exposes the amount and age of its first modeled conversion", () => {
  const summary = timelineSummary(
    [
      {
        age: 60,
        endTotal: 900000,
        isRetired: true,
        rothConversion: 12000,
        rmd: 0,
        niit: 0,
        socialSecurityTax: 0,
        irmaa: 0,
        hasOverride: false,
      },
    ],
    {},
  );

  assert.equal(summary.firstConversionAge, 60);
  assert.equal(summary.firstConversionAmount, 12000);
});

test("Roth conversion recommendation uses an existing modeled amount", () => {
  const [item] = recommendations(
    baseMetrics({
      projectedRothConversion: 12000,
      firstRothConversionAge: 60,
      firstRothConversionAmount: 12000,
    }),
    baseProfile(),
  );

  assert.equal(item.title, "Consider Roth Conversions");
  assert.match(item.recommendedAction, /\$12,000/);
  assert.match(item.currentSituation, /age 60/);
});

test("sample plan conversion metrics flow into the Roth recommendation", () => {
  const profile = cloneSampleProfile();
  const metrics = calculate(profile);
  const item = recommendations(metrics, profile).find(
    (recommendation) => recommendation.title === "Consider Roth Conversions",
  );

  assert.ok(metrics.projectedRothConversion > 0);
  assert.ok(metrics.firstRothConversionAmount > 0);
  assert.ok(item);
  assert.ok(
    item.recommendedAction.includes(money(metrics.firstRothConversionAmount)),
  );
});

test("enabled Roth strategy with no projected conversion does not invent an amount", () => {
  const [item] = recommendations(
    baseMetrics(),
    baseProfile({ rothConversionStrategy: "auto" }),
  );

  assert.equal(item.title, "Consider Roth Conversions");
  assert.match(item.currentSituation, /no projected conversion amount/i);
  assert.match(item.recommendedAction, /no conversion amount is currently modeled/i);
  assert.doesNotMatch(item.recommendedAction, /\$\d/);
});

test("RMD recommendation requires substantial tax-deferred assets and projected RMDs", () => {
  const metrics = baseMetrics({ projectedRmd: 40000 });
  const [item] = recommendations(metrics, baseProfile());
  assert.equal(item.title, "Reduce Future RMD Exposure");

  const noMaterialExposure = recommendations(
    metrics,
    baseProfile({ assets: { fourOhOneK: 400000, traditionalIra: 0 } }),
  );
  assert.equal(
    noMaterialExposure.some((recommendation) =>
      recommendation.title.includes("RMD"),
    ),
    false,
  );
});

test("Roth, RMD, savings, diversification, and IRMAA recommendations follow the requested order", () => {
  const items = recommendations(
    baseMetrics({
      savingsRate: 0.1,
      employeeSavings: 10000,
      projectedRothConversion: 12000,
      firstRothConversionAge: 60,
      firstRothConversionAmount: 12000,
      projectedRmd: 40000,
      timelineIrmaaAge: 65,
    }),
    baseProfile({ rothConversionStrategy: "auto" }),
  );

  assert.deepEqual(
    Array.from(items, (item) => item.title),
    [
      "Consider Roth Conversions",
      "Increase annual savings",
      "Review tax diversification",
      "Manage Future Medicare Surcharges",
    ],
  );
  assert.equal(items.length, 4);

  const lowerPriorityItems = recommendations(
    baseMetrics({ timelineIrmaaAge: 65 }),
    baseProfile(),
  );
  assert.deepEqual(
    Array.from(lowerPriorityItems, (item) => item.title),
    ["Review tax diversification", "Manage Future Medicare Surcharges"],
  );
  assert.match(lowerPriorityItems[0].recommendedAction, /Roth contributions or Roth conversions/);
  assert.match(lowerPriorityItems[0].whyItMatters, /taxable, tax-deferred, and Roth/);
  assert.match(lowerPriorityItems[1].currentSituation, /age 65/);
  assert.match(lowerPriorityItems[1].recommendedAction, /before Medicare enrollment/);
});

test("Roth and RMD triggers consolidate their shared conversion guidance", () => {
  const items = recommendations(
    baseMetrics({
      projectedRothConversion: 12000,
      firstRothConversionAge: 60,
      firstRothConversionAmount: 12000,
      projectedRmd: 40000,
    }),
    baseProfile({ rothConversionStrategy: "auto" }),
  );
  const rothItem = items.find((item) => item.title === "Consider Roth Conversions");

  assert.ok(rothItem);
  assert.match(rothItem.currentSituation, /\$40,000 across the modeled timeline/);
  assert.match(rothItem.recommendedAction, /projected RMD exposure/);
  assert.equal(
    items.some((item) => item.title === "Reduce Future RMD Exposure"),
    false,
  );
});

test("depletion, funding gap, and spending shortfall remain ahead of Roth recommendations", () => {
  const items = recommendations(
    baseMetrics({
      timelineDepletionAge: 80,
      fundingDelta: 100000,
      safeSpending: 40000,
      projectedRothConversion: 12000,
      firstRothConversionAge: 60,
      firstRothConversionAmount: 12000,
    }),
    baseProfile({
      retirementAnnualSpendingGoal: 50000,
      rothConversionStrategy: "auto",
    }),
  );

  assert.deepEqual(
    Array.from(items, (item) => item.title),
    [
      "Address projected portfolio depletion",
      "Address the projected funding gap",
      "Align retirement spending with the estimate",
      "Consider Roth Conversions",
      "Review tax diversification",
    ],
  );
});

test("recommendation groups keep the top three and retain every remaining item", () => {
  const items = recommendations(
    baseMetrics({
      timelineDepletionAge: 80,
      fundingDelta: 100000,
      safeSpending: 40000,
      savingsRate: 0.1,
      employeeSavings: 10000,
      projectedRothConversion: 12000,
      firstRothConversionAge: 60,
      firstRothConversionAmount: 12000,
      timelineIrmaaAge: 65,
    }),
    baseProfile({
      retirementAnnualSpendingGoal: 50000,
      rothConversionStrategy: "auto",
    }),
  );
  const groups = recommendationGroups(items);

  assert.equal(items.length, 7);
  assert.equal(groups.top.length, 3);
  assert.equal(groups.additional.length, 4);
  assert.deepEqual(
    Array.from(groups.top, (item) => item.severity),
    [100, 90, 80],
  );
  assert.equal(groups.top.length + groups.additional.length, items.length);
  assert.equal(recommendationSectionHeading(items), "Top Recommendations");
});

test("sample plan demonstrates moderate readiness and planning opportunities", () => {
  const profile = cloneSampleProfile();
  const metrics = calculate(profile);
  const items = recommendations(metrics, profile);
  const groups = recommendationGroups(items);
  const { effectiveProfile, ssPlan } = resolveEffectiveProfile(profile);
  const rows = buildTimelineRows(effectiveProfile);
  const milestones = buildTimelineMilestones(
    rows,
    effectiveProfile,
    ssPlan,
  );

  assert.ok(metrics.score >= 70 && metrics.score <= 80);
  assert.equal(metrics.status, "Slightly Behind");
  assert.ok(metrics.savingsRate >= 0.1 && metrics.savingsRate <= 0.12);
  assert.ok(metrics.safeSpending < profile.retirementAnnualSpendingGoal);
  assert.ok(
    metrics.timelineDepletionAge === null || metrics.timelineDepletionAge >= 90,
  );
  assert.ok(metrics.timelineIrmaaAge);
  assert.ok(metrics.projectedRothConversion > 0);

  const titles = new Set(items.map((item) => item.title));
  assert.ok(titles.has("Increase annual savings"));
  assert.ok(titles.has("Align retirement spending with the estimate"));
  assert.ok(titles.has("Consider Roth Conversions"));
  assert.ok(titles.has("Review tax diversification"));
  assert.ok(titles.has("Manage Future Medicare Surcharges"));
  assert.equal(groups.top.length, 3);
  assert.equal(groups.additional.length, items.length - 3);

  assert.ok(
    milestones.some((milestone) => milestone.label.includes("Retirement begins")),
  );
  assert.ok(
    milestones.some(
      (milestone) =>
        milestone.age === 67 &&
        milestone.label.includes("Social Security begins"),
    ),
  );
  assert.ok(
    milestones.some((milestone) => milestone.label.includes("Roth conversions begin")),
  );
  assert.ok(milestones.some((milestone) => milestone.label.includes("RMD start age")));
  assert.ok(rows.some((row) => row.isRetired && row.withdrawal > 0));
});

test("informational-only recommendations use the planning opportunities heading", () => {
  const items = recommendations(
    baseMetrics({ timelineIrmaaAge: 65 }),
    baseProfile(),
  );

  assert.equal(recommendationSectionHeading(items), "Planning Opportunities");
});

test("Readiness CTA counts the complete recommendation list, not only priority items", () => {
  const profile = baseProfile({ rothConversionStrategy: "auto" });
  const metrics = baseMetrics({
    timelineDepletionAge: 80,
    fundingDelta: 100000,
    safeSpending: 40000,
    savingsRate: 0.1,
    employeeSavings: 10000,
    projectedRothConversion: 12000,
    firstRothConversionAge: 60,
    firstRothConversionAmount: 12000,
    timelineIrmaaAge: 65,
  });
  const items = recommendations(metrics, profile);
  const cta = readinessRecommendationsCallToAction(metrics, items, true);

  assert.equal(cta.title, "Recommended Next Steps");
  assert.match(cta.message, /has 7 recommendations/);
  assert.equal(cta.action, "View Recommendations");
  assert.equal(cta.destination, "recommendations");
});

test("Readiness CTA shows planning opportunities or missing-plan guidance when appropriate", () => {
  const metrics = baseMetrics({ timelineIrmaaAge: 65 });
  const infoOnlyRecommendations = recommendations(metrics, baseProfile());
  const opportunitiesCta = readinessRecommendationsCallToAction(
    metrics,
    infoOnlyRecommendations,
    true,
  );
  assert.equal(opportunitiesCta.title, "Planning Opportunities");
  assert.match(opportunitiesCta.message, /strong position/i);
  assert.equal(opportunitiesCta.destination, "recommendations");

  const missingPlanCta = readinessRecommendationsCallToAction(
    null,
    [],
    false,
  );
  assert.equal(missingPlanCta.title, "Complete Your Plan");
  assert.equal(missingPlanCta.action, "Review Missing Information");
  assert.equal(missingPlanCta.destination, "profile");
});

test("recommendation severity and badges match the priority mapping", () => {
  const cases = [
    ["Address projected portfolio depletion", 100, "HIGH PRIORITY", {
      metrics: { timelineDepletionAge: 80 },
    }],
    ["Address the projected funding gap", 90, "HIGH PRIORITY", {
      metrics: { fundingDelta: 1 },
    }],
    ["Align retirement spending with the estimate", 80, "HIGH PRIORITY", {
      profile: { retirementAnnualSpendingGoal: 50001 },
    }],
    ["Consider Roth Conversions", 70, "MEDIUM PRIORITY", {
      metrics: { projectedRothConversion: 1 },
    }],
    ["Reduce Future RMD Exposure", 65, "MEDIUM PRIORITY", {
      metrics: { projectedRmd: 1 },
    }],
    ["Increase annual savings", 60, "MEDIUM PRIORITY", {
      metrics: { savingsRate: 0.1 },
    }],
    ["Review tax diversification", 40, "INFORMATIONAL", {}],
    ["Manage Future Medicare Surcharges", 30, "INFORMATIONAL", {
      metrics: { timelineIrmaaAge: 65 },
      profile: { assets: { fourOhOneK: 400000, traditionalIra: 0 } },
    }],
  ];

  for (const [title, severity, priority, overrides] of cases) {
    const [item] = recommendations(
      baseMetrics(overrides.metrics),
      baseProfile(overrides.profile),
    );
    assert.equal(item.title, title);
    assert.equal(item.severity, severity);
    assert.equal(item.priority, priority);
    assert.ok(item.currentSituation);
    assert.ok(item.recommendedAction);
    assert.ok(item.whyItMatters);
  }
});

function money(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}