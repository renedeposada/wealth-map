const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

function loadReadinessModel() {
  const dataSource = fs.readFileSync(path.join(__dirname, "../data.js"), "utf8");
  const appSource = fs.readFileSync(path.join(__dirname, "../app.js"), "utf8");
  const sandbox = { console, Math, Number, Intl, Object, Array, JSON, Date };
  vm.createContext(sandbox);
  vm.runInContext(
    `${dataSource}\n${appSource}\nvar __wealthMap = { readinessScoreFactors, readinessScoreSummary, calculate, cloneSampleProfile };`,
    sandbox,
    { filename: "wealth-map-readiness-factors.js" },
  );
  return sandbox.__wealthMap;
}

const {
  readinessScoreFactors,
  readinessScoreSummary,
  calculate,
  cloneSampleProfile,
} = loadReadinessModel();

function metrics(overrides = {}) {
  return {
    status: "On Track",
    score: 85,
    timelineDepletionAge: null,
    fundingDelta: -10000,
    expectedRetirementAge: 65,
    savingsRate: 0.2,
    totalIncome: 100000,
    safeSpending: 70000,
    ...overrides,
  };
}

function profile(overrides = {}) {
  const base = cloneSampleProfile();
  return {
    ...base,
    targetRetirementAge: 65,
    lifeExpectancy: 90,
    retirementAnnualSpendingGoal: 65000,
    ...overrides,
  };
}

test("score factors describe only existing score drivers and relevant spending context", () => {
  const plan = profile();
  const scoreMetrics = calculate(plan);
  const factors = readinessScoreFactors(scoreMetrics, plan);

  assert.deepEqual(
    Array.from(factors, (factor) => factor.name),
    [
      "Portfolio Sustainability",
      "Funding Position",
      "Retirement Spending",
      "Retirement Income Coverage & Timing",
      "Savings Rate",
    ],
  );
  assert.ok(factors.every((factor) => factor.status));
  assert.ok(factors.every((factor) => factor.currentResult));
  assert.ok(factors.every((factor) => factor.explanation));
  assert.ok(
    factors.every(
      (factor) =>
        !/Roth|tax diversification|RMD|IRMAA/i.test(
          `${factor.name} ${factor.explanation}`,
        ),
    ),
  );
  assert.match(factors[2].explanation, /not a separate score input/);
});

test("critical factors sort first while preserving factor order within each status", () => {
  const factors = readinessScoreFactors(
    metrics({
      status: "Major Shortfall",
      timelineDepletionAge: 84,
      fundingDelta: 180000,
      expectedRetirementAge: null,
      savingsRate: 0.1,
      safeSpending: 60000,
    }),
    profile({ retirementAnnualSpendingGoal: 80000 }),
  );

  assert.deepEqual(
    Array.from(factors, (factor) => [factor.name, factor.status]),
    [
      ["Portfolio Sustainability", "Critical"],
      ["Funding Position", "Critical"],
      ["Retirement Income Coverage & Timing", "Critical"],
      ["Retirement Spending", "Needs Attention"],
      ["Savings Rate", "Needs Attention"],
    ],
  );
});

test("positive plan factors use the current funding, safe-spending, timing, and savings thresholds", () => {
  const factors = readinessScoreFactors(
    metrics({
      fundingDelta: 0,
      expectedRetirementAge: 64,
      savingsRate: 0.2,
      safeSpending: 70000,
    }),
    profile({ retirementAnnualSpendingGoal: 70000 }),
  );

  assert.ok(factors.every((factor) => factor.status === "Positive"));
  assert.match(factors[1].currentResult, /No funding gap/);
  assert.match(factors[3].currentResult, /Expected retirement age 64/);
  assert.match(factors[4].currentResult, /20%; target 20%/);
});

test("summary reflects factor states and avoids a strong-score claim when attention is needed", () => {
  const plan = profile();
  const factorList = readinessScoreFactors(
    metrics({ savingsRate: 0.1 }),
    plan,
  );
  const summary = readinessScoreSummary(
    metrics({ status: "Slightly Behind", savingsRate: 0.1 }),
    factorList,
  );

  assert.match(summary, /savings rate/i);
  assert.match(
    readinessScoreSummary(metrics(), readinessScoreFactors(metrics(), plan)),
    /sustainable spending, sufficient projected assets, and no projected funding gap/i,
  );
  assert.match(readinessScoreSummary(null, []), /unavailable/i);
});
