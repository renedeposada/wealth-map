const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const assert = require("node:assert/strict");

function loadModel() {
  const dataSrc = fs.readFileSync(path.join(__dirname, "../data.js"), "utf8");
  const appSrc = fs.readFileSync(path.join(__dirname, "../app.js"), "utf8");
  const exportSnippet = `
var __wealthMap = {
  calculate: calculate,
  buildTimelineRows: buildTimelineRows,
  timelineSummary: timelineSummary,
  benefitForClaimAge: benefitForClaimAge,
  estimatedSocialSecurityFraBenefit: estimatedSocialSecurityFraBenefit,
  recommendedSocialSecurityClaimAge: recommendedSocialSecurityClaimAge,
  socialSecurityClaimingSchedule: socialSecurityClaimingSchedule,
  resolveSocialSecurityPlan: resolveSocialSecurityPlan,
  resolveEffectiveProfile: resolveEffectiveProfile,
  migrateSocialSecurityProfile: migrateSocialSecurityProfile,
  cloneSampleProfile: cloneSampleProfile,
  inputConfig: inputConfig,
  SAMPLE_PROFILE: SAMPLE_PROFILE,
  SOCIAL_SECURITY_FULL_RETIREMENT_AGE: SOCIAL_SECURITY_FULL_RETIREMENT_AGE,
};`;
  const sandbox = { console, Math, Number, Intl, Object, Array, JSON, Date };
  vm.createContext(sandbox);
  vm.runInContext(dataSrc + "\n" + appSrc + "\n" + exportSnippet, sandbox, {
    filename: "wealth-map-model.js",
  });
  return sandbox.__wealthMap;
}

const {
  calculate,
  buildTimelineRows,
  timelineSummary,
  benefitForClaimAge,
  estimatedSocialSecurityFraBenefit,
  resolveSocialSecurityPlan,
  resolveEffectiveProfile,
  migrateSocialSecurityProfile,
  cloneSampleProfile,
  inputConfig,
  SAMPLE_PROFILE,
  SOCIAL_SECURITY_FULL_RETIREMENT_AGE,
} = loadModel();

const appJs = fs.readFileSync(path.join(__dirname, "../app.js"), "utf8");
const indexHtml = fs.readFileSync(
  path.join(__dirname, "../index.html"),
  "utf8",
);

test("new plans default to automatic estimation", () => {
  assert.equal(SAMPLE_PROFILE.socialSecurityBenefitMode, "auto");
  const fresh = cloneSampleProfile();
  assert.equal(fresh.socialSecurityBenefitMode, "auto");
  const plan = resolveSocialSecurityPlan(fresh);
  assert.equal(plan.benefitMode, "auto");
  assert.equal(plan.source, "auto");
});

test("reset restores automatic estimation", () => {
  const custom = {
    ...cloneSampleProfile(),
    socialSecurityBenefitMode: "manual",
    socialSecurityAnnualBenefit: 20000,
  };
  assert.equal(custom.socialSecurityBenefitMode, "manual");
  const reset = cloneSampleProfile();
  assert.equal(reset.socialSecurityBenefitMode, "auto");
  const plan = resolveSocialSecurityPlan(reset);
  assert.equal(plan.benefitMode, "auto");
  assert.equal(plan.fraBenefit, 63000); // 35% of $180k rounded to $500
});

test("the estimate appears instead of $0 for new users", () => {
  const profile = cloneSampleProfile();
  const plan = resolveSocialSecurityPlan(profile);
  assert.ok(plan.fraBenefit > 0);
  assert.equal(plan.fraBenefit, 63000);
  const metrics = calculate(profile);
  assert.equal(metrics.socialSecurityPlan.fraBenefit, 63000);
});

test("the estimate updates when salary changes and never produces a negative benefit", () => {
  const profile100k = { ...cloneSampleProfile(), annualSalary: 100000 };
  assert.equal(estimatedSocialSecurityFraBenefit(profile100k), 35000);

  const profile200k = { ...cloneSampleProfile(), annualSalary: 200000 };
  assert.equal(estimatedSocialSecurityFraBenefit(profile200k), 70000);

  const profileZero = { ...cloneSampleProfile(), annualSalary: 0 };
  assert.equal(estimatedSocialSecurityFraBenefit(profileZero), 0);

  const profileNegative = { ...cloneSampleProfile(), annualSalary: -50000 };
  assert.equal(estimatedSocialSecurityFraBenefit(profileNegative), 0);
});

test("automatic estimates cannot be edited directly (configured as readonly in Plan Setup)", () => {
  const config = inputConfig();
  const estimatedField = config.basicTax.find(
    (field) => field[0] === "socialSecurityEstimatedBenefit",
  );
  assert.ok(estimatedField);
  assert.equal(estimatedField[2], "readonly");
  assert.equal(
    estimatedField[1],
    "Estimated annual benefit at Full Retirement Age",
  );
  assert.match(
    estimatedField[3],
    /Estimated from your current earnings for retirement planning\. For greater accuracy, use the benefit estimate from your Social Security statement\./,
  );
});

test("manual mode enables benefit entry and overrides automatic estimates", () => {
  const manualProfile = {
    ...cloneSampleProfile(),
    socialSecurityBenefitMode: "manual",
    socialSecurityAnnualBenefit: 30000,
  };
  const plan = resolveSocialSecurityPlan(manualProfile);
  assert.equal(plan.benefitMode, "manual");
  assert.equal(plan.fraBenefit, 30000);
  assert.equal(plan.annualBenefit, 30000); // at claimAge 67
});

test("manual values are preserved when switching modes", () => {
  const profile = {
    ...cloneSampleProfile(),
    socialSecurityBenefitMode: "manual",
    socialSecurityAnnualBenefit: 28500,
  };
  // User temporarily switches to auto
  profile.socialSecurityBenefitMode = "auto";
  const planAuto = resolveSocialSecurityPlan(profile);
  assert.equal(planAuto.benefitMode, "auto");
  assert.equal(planAuto.fraBenefit, 63000);
  assert.equal(profile.socialSecurityAnnualBenefit, 28500); // preserved

  // User switches back to manual
  profile.socialSecurityBenefitMode = "manual";
  const planManual = resolveSocialSecurityPlan(profile);
  assert.equal(planManual.benefitMode, "manual");
  assert.equal(planManual.fraBenefit, 28500);
});

test("claim-age adjustments work with both benefit modes", () => {
  // Automatic benefit mode with claim ages 62, 67, 70
  const auto62 = resolveSocialSecurityPlan({
    ...cloneSampleProfile(),
    socialSecurityBenefitMode: "auto",
    socialSecurityClaimAge: 62,
  });
  const auto67 = resolveSocialSecurityPlan({
    ...cloneSampleProfile(),
    socialSecurityBenefitMode: "auto",
    socialSecurityClaimAge: 67,
  });
  const auto70 = resolveSocialSecurityPlan({
    ...cloneSampleProfile(),
    socialSecurityBenefitMode: "auto",
    socialSecurityClaimAge: 70,
  });
  assert.equal(auto67.annualBenefit, 63000);
  assert.ok(auto62.annualBenefit < auto67.annualBenefit);
  assert.ok(auto70.annualBenefit > auto67.annualBenefit);

  // Manual benefit mode with claim ages 62, 67, 70
  const manual62 = resolveSocialSecurityPlan({
    ...cloneSampleProfile(),
    socialSecurityBenefitMode: "manual",
    socialSecurityAnnualBenefit: 24000,
    socialSecurityClaimAge: 62,
  });
  const manual67 = resolveSocialSecurityPlan({
    ...cloneSampleProfile(),
    socialSecurityBenefitMode: "manual",
    socialSecurityAnnualBenefit: 24000,
    socialSecurityClaimAge: 67,
  });
  const manual70 = resolveSocialSecurityPlan({
    ...cloneSampleProfile(),
    socialSecurityBenefitMode: "manual",
    socialSecurityAnnualBenefit: 24000,
    socialSecurityClaimAge: 70,
  });
  assert.equal(manual67.annualBenefit, 24000);
  assert.ok(manual62.annualBenefit < 24000);
  assert.ok(manual70.annualBenefit > 24000);
});

test("Social Security begins only at the effective claim age in both modes", () => {
  const autoProfile = {
    ...cloneSampleProfile(),
    currentAge: 60,
    targetRetirementAge: 62,
    lifeExpectancy: 85,
    socialSecurityBenefitMode: "auto",
    socialSecurityClaimAge: 65,
  };
  const { effectiveProfile } = resolveEffectiveProfile(autoProfile);
  const rows = buildTimelineRows(effectiveProfile);

  const beforeClaim = rows.filter((r) => r.isRetired && r.age < 65);
  const atClaimAndAfter = rows.filter((r) => r.isRetired && r.age >= 65);

  assert.ok(beforeClaim.length > 0);
  beforeClaim.forEach((r) => {
    assert.equal(r.socialSecurityGrossBenefit, 0);
    assert.equal(r.socialSecurityTax, 0);
  });

  assert.ok(atClaimAndAfter.length > 0);
  atClaimAndAfter.forEach((r) => {
    assert.ok(r.socialSecurityGrossBenefit > 0);
  });
});

test("Readiness and Timeline results use the same effective benefit", () => {
  const profile = {
    ...cloneSampleProfile(),
    currentAge: 55,
    targetRetirementAge: 65,
    lifeExpectancy: 85,
    stateIncomeTaxRate: 0.05,
    socialSecurityBenefitMode: "auto",
    socialSecurityClaimAge: 68,
  };
  const metrics = calculate(profile);
  const { effectiveProfile } = resolveEffectiveProfile(profile);
  const rows = buildTimelineRows(effectiveProfile);
  const timelineTaxSum = rows.reduce((acc, r) => acc + r.socialSecurityTax, 0);

  assert.equal(metrics.projectedSocialSecurityTax, timelineTaxSum);
  assert.equal(
    metrics.socialSecurityPlan.annualBenefit,
    effectiveProfile.socialSecurityAnnualBenefit,
  );
  const ssRow = rows.find((r) => r.socialSecurityGrossBenefit > 0);
  assert.ok(ssRow);
  assert.equal(
    ssRow.socialSecurityGrossBenefit,
    metrics.socialSecurityPlan.annualBenefit,
  );
});

test("Social Security tax and IRMAA calculations use the effective benefit", () => {
  const profile = {
    ...cloneSampleProfile(),
    currentAge: 60,
    targetRetirementAge: 65,
    lifeExpectancy: 85,
    stateIncomeTaxRate: 0.044,
    socialSecurityBenefitMode: "auto",
    socialSecurityTaxablePercent: 0.85,
    irmaaIncomeThreshold: 100000,
    irmaaAnnualSurcharge: 1200,
  };
  const metrics = calculate(profile);
  assert.ok(metrics.projectedSocialSecurityTax > 0);
});

test("existing manual profiles retain their saved values during migration", () => {
  // Legacy profile saved with a meaningful custom benefit and no socialSecurityBenefitMode
  const legacySaved = {
    annualSalary: 150000,
    socialSecurityAnnualBenefit: 28000,
    socialSecurityClaimAge: 66,
  };
  const migrated = migrateSocialSecurityProfile(legacySaved);
  assert.equal(migrated.socialSecurityBenefitMode, "manual");
  assert.equal(migrated.socialSecurityAnnualBenefit, 28000);

  const plan = resolveSocialSecurityPlan(legacySaved);
  assert.equal(plan.benefitMode, "manual");
  assert.equal(plan.fraBenefit, 28000);
  assert.equal(plan.claimAge, 66);
});

test("legacy profiles with no meaningful benefit migrate to automatic estimation", () => {
  // Legacy profile saved with default $0 benefit and no socialSecurityBenefitMode
  const legacyDefault = {
    annualSalary: 120000,
    socialSecurityAnnualBenefit: 0,
  };
  const migrated = migrateSocialSecurityProfile(legacyDefault);
  assert.equal(migrated.socialSecurityBenefitMode, "auto");

  const plan = resolveSocialSecurityPlan(legacyDefault);
  assert.equal(plan.benefitMode, "auto");
  assert.equal(plan.fraBenefit, 42000); // 35% of $120k
});

test("no duplicate or conflicting Social Security strategy controls remain", () => {
  const config = inputConfig();
  // Plan Setup contains benefit mode and claim age
  const basicKeys = config.basicTax.map((f) => f[0]);
  assert.ok(basicKeys.includes("socialSecurityBenefitMode"));
  assert.ok(basicKeys.includes("socialSecurityEstimatedBenefit"));
  assert.ok(basicKeys.includes("socialSecurityAnnualBenefit"));
  assert.ok(basicKeys.includes("socialSecurityClaimAge"));

  // Timeline strategy contains only claim strategy (distinguished from benefit mode)
  const strategyKeys = config.strategy.map((f) => f[0]);
  assert.ok(strategyKeys.includes("socialSecurityStrategy"));
  const ssStrategyField = config.strategy.find(
    (f) => f[0] === "socialSecurityStrategy",
  );
  assert.equal(ssStrategyField[1], "Social Security claim strategy");
});
