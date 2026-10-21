// Deterministic plan fixtures for export regression tests. Each call returns a fresh, plain,
// mutable profile derived from the shared sample data (data.js), so nothing is shared between tests.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const dataSource = fs.readFileSync(path.join(__dirname, "..", "..", "data.js"), "utf8");
const dataSandbox = { Object, Number, Math, JSON };
vm.createContext(dataSandbox);
vm.runInContext(`${dataSource}\nvar __clone = cloneSampleProfile;`, dataSandbox, { filename: "export-fixtures-data.js" });

function sampleProfile() {
  return JSON.parse(JSON.stringify(dataSandbox.__clone()));
}

// Retirement is one year away: the importer requires the target retirement age to be after the current age.
function retiredProfile() {
  const profile = sampleProfile();
  Object.assign(profile, {
    currentAge: 66,
    targetRetirementAge: 67,
    lifeExpectancy: 90,
    annualSalary: 0,
    otherAnnualIncome: 60000,
  });
  profile.contributionRates = { ...profile.contributionRates, fourOhOneK: 0 };
  profile.iraContributions = { traditionalIraAnnual: 0, rothIraAnnual: 0 };
  return profile;
}

function highIncomeProfile() {
  const profile = sampleProfile();
  profile.annualSalary = 650000;
  profile.otherAnnualIncome = 120000;
  return profile;
}

function highAssetProfile() {
  const profile = sampleProfile();
  Object.assign(profile.assets, {
    brokerage: 2500000,
    fourOhOneK: 3200000,
    traditionalIra: 900000,
    rothIra: 750000,
    cash: 400000,
    realEstate: 2100000,
  });
  return profile;
}

function timelineOverrideProfile() {
  const profile = sampleProfile();
  profile.timelineOverrides = {
    50: { returnPercent: 10 },
    60: { expenses: 120000 },
    75: { extraWithdrawal: 25000 },
  };
  return profile;
}

// Sets dotted paths (for example "assets.cash") on a fresh profile. Nested objects are replaced, never shared.
function withValues(profile, values) {
  Object.entries(values).forEach(([fieldId, value]) => {
    const keys = fieldId.split(".");
    const last = keys.pop();
    const parent = keys.reduce((node, key) => (node[key] = { ...(node[key] || {}) }), profile);
    parent[last] = value;
  });
  return profile;
}

// Every supported standard input differs from the sample where more than one choice exists.
function allInputsProfile() {
  return withValues(sampleProfile(), {
    name: "Jordan Lee",
    currentAge: 40,
    targetRetirementAge: 62,
    lifeExpectancy: 92,
    state: "Texas",
    filingStatus: "Single",
    expectedAnnualReturn: 0.055,
    inflationRate: 0.03,
    safeWithdrawalRate: 0.035,
    socialSecurityBenefitMode: "manual",
    socialSecurityAnnualBenefit: 36000,
    socialSecurityClaimAge: 66,
    federalStandardDeduction: 14600,
    stateIncomeTaxRate: 0.045,
    taxableGainsTaxRate: 0.2,
    preTaxWithdrawalTaxRate: 0.24,
    rothConversionStrategy: "manual",
    rothConversionAnnualAmount: 15000,
    socialSecurityStrategy: "auto",
    socialSecurityTaxablePercent: 0.5,
    rmdStartAge: 75,
    niitThreshold: 200000,
    cashReserveTargetYears: 1.5,
    irmaaIncomeThreshold: 212000,
    irmaaAnnualSurcharge: 2400,
    annualSalary: 150000,
    otherAnnualIncome: 12000,
    currentAnnualExpenses: 95000,
    retirementAnnualSpendingGoal: 85000,
    "contributionRates.fourOhOneK": 0.1,
    "employerMatch.rate": 0.75,
    "employerMatch.salaryCap": 0.04,
    "iraContributions.traditionalIraAnnual": 2000,
    "iraContributions.rothIraAnnual": 4000,
    "savingsAllocation.brokerage": 0.6,
    "savingsAllocation.cash": 0.4,
    "assets.cash": 18000,
    "assets.brokerage": 52000,
    "assets.fourOhOneK": 310000,
    "assets.traditionalIra": 88000,
    "assets.rothIra": 31000,
    "assets.realEstate": 520000,
  });
}

function automaticSocialSecurityProfile() {
  return withValues(sampleProfile(), {
    socialSecurityBenefitMode: "auto",
    socialSecurityStrategy: "manual",
    socialSecurityClaimAge: 67,
  });
}

function manualSocialSecurityProfile() {
  return withValues(sampleProfile(), {
    socialSecurityBenefitMode: "manual",
    socialSecurityAnnualBenefit: 42000,
    socialSecurityClaimAge: 70,
    socialSecurityStrategy: "manual",
  });
}

function modelRecommendedSocialSecurityProfile() {
  return withValues(sampleProfile(), { socialSecurityStrategy: "auto", socialSecurityClaimAge: 64 });
}

function autoRothConversionProfile() {
  return withValues(sampleProfile(), { rothConversionStrategy: "auto" });
}

function manualRothConversionProfile() {
  return withValues(sampleProfile(), { rothConversionStrategy: "manual", rothConversionAnnualAmount: 25000 });
}

function contributionProfile() {
  return withValues(sampleProfile(), {
    "contributionRates.fourOhOneK": 0.12,
    "employerMatch.rate": 0.6,
    "employerMatch.salaryCap": 0.05,
    "iraContributions.traditionalIraAnnual": 2500,
    "iraContributions.rothIraAnnual": 4500,
    "savingsAllocation.brokerage": 0.65,
    "savingsAllocation.cash": 0.35,
  });
}

function assetProfile() {
  return withValues(sampleProfile(), {
    "assets.cash": 11111,
    "assets.brokerage": 22222,
    "assets.fourOhOneK": 33333,
    "assets.traditionalIra": 44444,
    "assets.rothIra": 55555,
    "assets.realEstate": 66666,
  });
}

function largeValueProfile() {
  return withValues(sampleProfile(), {
    annualSalary: 25000000,
    otherAnnualIncome: 5000000,
    currentAnnualExpenses: 12000000,
    retirementAnnualSpendingGoal: 9000000,
    federalStandardDeduction: 987654321,
    niitThreshold: 123456789012,
    irmaaIncomeThreshold: 234567890123,
    "assets.cash": 111111111,
    "assets.brokerage": 222222222,
    "assets.fourOhOneK": 333333333,
    "assets.traditionalIra": 444444444,
    "assets.rothIra": 555555555,
    "assets.realEstate": 999999999999,
  });
}

function decimalProfile() {
  return withValues(sampleProfile(), {
    expectedAnnualReturn: 0.0437,
    inflationRate: 0.0283,
    safeWithdrawalRate: 0.0371,
    stateIncomeTaxRate: 0.0463,
    taxableGainsTaxRate: 0.1875,
    preTaxWithdrawalTaxRate: 0.2425,
    "employerMatch.rate": 0.6125,
    "employerMatch.salaryCap": 0.0375,
    "savingsAllocation.brokerage": 0.3333,
    "savingsAllocation.cash": 0.6667,
    cashReserveTargetYears: 1.75,
  });
}

// Zero is meaningful for these fields and must not become a default; the name is intentionally empty.
function zeroValueProfile() {
  return withValues(sampleProfile(), {
    name: "",
    otherAnnualIncome: 0,
    stateIncomeTaxRate: 0,
    taxableGainsTaxRate: 0,
    preTaxWithdrawalTaxRate: 0,
    rothConversionAnnualAmount: 0,
    socialSecurityAnnualBenefit: 0,
    irmaaAnnualSurcharge: 0,
    "iraContributions.traditionalIraAnnual": 0,
    "iraContributions.rothIraAnnual": 0,
    "assets.realEstate": 0,
  });
}

function lowBoundaryPercentProfile() {
  return withValues(sampleProfile(), {
    expectedAnnualReturn: 0,
    inflationRate: 0,
    safeWithdrawalRate: 0,
    stateIncomeTaxRate: 0,
    taxableGainsTaxRate: 0,
    preTaxWithdrawalTaxRate: 0,
    socialSecurityTaxablePercent: 0,
    "contributionRates.fourOhOneK": 0,
    "employerMatch.rate": 0,
    "employerMatch.salaryCap": 0,
    "savingsAllocation.brokerage": 0,
    "savingsAllocation.cash": 1,
  });
}

function highBoundaryPercentProfile() {
  return withValues(sampleProfile(), {
    expectedAnnualReturn: 1,
    inflationRate: 1,
    safeWithdrawalRate: 1,
    stateIncomeTaxRate: 1,
    taxableGainsTaxRate: 1,
    preTaxWithdrawalTaxRate: 1,
    socialSecurityTaxablePercent: 1,
    "contributionRates.fourOhOneK": 1,
    "iraContributions.rothIraAnnual": 0,
    "employerMatch.rate": 1,
    "employerMatch.salaryCap": 1,
    "savingsAllocation.brokerage": 1,
    "savingsAllocation.cash": 0,
  });
}

function emptyOverrideProfile() {
  const profile = sampleProfile();
  profile.timelineOverrides = {};
  return profile;
}

// Sample ages: current 45, target retirement 65, life expectancy 95.
function allOverrideTypesProfile() {
  const profile = sampleProfile();
  profile.timelineOverrides = {
    50: { returnPercent: -12.5, income: 195000, expenses: 112000, extraCashNeed: 8500 },
    67: { returnPercent: 4.75, expenses: 94000, extraWithdrawal: 18000 },
  };
  return profile;
}

function boundaryReturnOverrideProfile() {
  const profile = sampleProfile();
  profile.timelineOverrides = {
    46: { returnPercent: -100 },
    47: { returnPercent: 0 },
    48: { returnPercent: 100 },
  };
  return profile;
}

function multiAgeOverrideProfile() {
  const profile = sampleProfile();
  profile.timelineOverrides = {
    80: { extraWithdrawal: 12000, expenses: 88000 },
    46: { income: 190000, returnPercent: 3.25 },
    65: { extraWithdrawal: 5000, returnPercent: -2.5 },
    55: { extraCashNeed: 15000, expenses: 120000 },
    64: { extraCashNeed: 2000 },
    95: { returnPercent: 1.5 },
  };
  return profile;
}

// Overrides that do not apply to their year (working-only at a retired age) are dropped by export.
function inapplicableOverrideProfile() {
  const profile = sampleProfile();
  profile.timelineOverrides = { 50: { returnPercent: 6 }, 67: { income: 50000 } };
  return profile;
}

module.exports = {
  sampleProfile, retiredProfile, highIncomeProfile, highAssetProfile, timelineOverrideProfile,
  withValues, allInputsProfile, automaticSocialSecurityProfile, manualSocialSecurityProfile,
  modelRecommendedSocialSecurityProfile, autoRothConversionProfile, manualRothConversionProfile,
  contributionProfile, assetProfile, largeValueProfile, decimalProfile, zeroValueProfile,
  lowBoundaryPercentProfile, highBoundaryPercentProfile, emptyOverrideProfile, allOverrideTypesProfile,
  boundaryReturnOverrideProfile, multiAgeOverrideProfile, inapplicableOverrideProfile,
};
