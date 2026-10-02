const SAMPLE_PROFILE = Object.freeze({
  name: "Alex Morgan",
  currentAge: 45,
  targetRetirementAge: 65,
  lifeExpectancy: 95,
  state: "Florida",
  filingStatus: "Married filing jointly",
  annualSalary: 180000,
  otherAnnualIncome: 0,
  contributionRates: Object.freeze({
    fourOhOneK: 0.05,
  }),
  // Fixed annual dollar IRA contributions (replaces legacy percentage-based contributionRates
  // traditionalIra/rothIra fields; legacy profiles are migrated automatically at calculation time).
  iraContributions: Object.freeze({
    traditionalIraAnnual: 0,
    rothIraAnnual: 3000,
  }),
  // Splits Available Annual Savings (after-tax income minus current expenses minus Roth IRA
  // contribution) between a taxable brokerage account and cash; must total 100%. Replaces legacy
  // contributionRates.brokerage/cash percentages, which were applied against after-tax income
  // directly rather than against leftover available savings.
  savingsAllocation: Object.freeze({
    brokerage: 0.75,
    cash: 0.25,
  }),
  employerMatch: Object.freeze({
    rate: 0.5,
    salaryCap: 0.03,
  }),
  currentAnnualExpenses: 140000,
  retirementAnnualSpendingGoal: 100000,
  expectedAnnualReturn: 0.0375,
  inflationRate: 0.025,
  projectionBasis: "real_dollars",
  safeWithdrawalRate: 0.04,
  federalStandardDeduction: 30000,
  // Florida has no state income tax; users in a taxed state can edit this to their own rate.
  stateIncomeTaxRate: 0,
  taxableGainsTaxRate: 0.15,
  preTaxWithdrawalTaxRate: 0.22,
  // "auto" lets the model generate a recommended strategy; "manual" uses the fields below.
  rothConversionStrategy: "auto",
  rothConversionAnnualAmount: 0,
  // "manual" uses the Plan Setup Social Security Claim Age field directly; "auto" (selectable on
  // the Timeline page) instead searches for a model-recommended claiming age.
  socialSecurityStrategy: "manual",
  // "auto" automatically estimates the FRA benefit from current earnings; "manual" allows manual entry.
  socialSecurityBenefitMode: "auto",
  socialSecurityAnnualBenefit: 0,
  // Full Retirement Age (67) is the default claim age; supported range is 62-70.
  socialSecurityClaimAge: 67,
  socialSecurityTaxablePercent: 0.85,
  rmdStartAge: 73,
  irmaaIncomeThreshold: 200000,
  irmaaAnnualSurcharge: 1800,
  // Simplified NIIT MAGI threshold; the 3.8% rate itself is a fixed illustrative constant.
  niitThreshold: 250000,
  // Years of retirement spending held as a buffer to avoid selling brokerage after a down year.
  cashReserveTargetYears: 1,
  assets: Object.freeze({
    brokerage: 40000,
    fourOhOneK: 275000,
    traditionalIra: 75000,
    rothIra: 25000,
    cash: 20000,
    realEstate: 450000,
  }),
  // Per-age user adjustments layered on top of the modeled timeline; empty by default.
  timelineOverrides: Object.freeze({}),
});

const ASSET_METADATA = Object.freeze({
  brokerage: {
    label: "Taxable brokerage",
    treatment: "Taxable",
    interpretation: "Flexible withdrawals; gains may be taxable",
  },
  fourOhOneK: {
    label: "401(k)",
    treatment: "Tax-deferred",
    interpretation: "Future withdrawals may be taxable",
  },
  traditionalIra: {
    label: "Traditional IRA",
    treatment: "Tax-deferred",
    interpretation: "Future withdrawals may be taxable",
  },
  rothIra: {
    label: "Roth IRA",
    treatment: "Tax-free qualified",
    interpretation: "Tax-free retirement flexibility",
  },
  cash: {
    label: "Cash",
    treatment: "Liquid",
    interpretation: "Short-term spending reserve",
  },
  realEstate: {
    label: "Real estate",
    treatment: "Separate asset",
    interpretation: "Not automatically spendable portfolio assets",
  },
});

function cloneSampleProfile() {
  return {
    ...SAMPLE_PROFILE,
    assets: { ...SAMPLE_PROFILE.assets },
    contributionRates: { ...SAMPLE_PROFILE.contributionRates },
    iraContributions: { ...SAMPLE_PROFILE.iraContributions },
    savingsAllocation: { ...SAMPLE_PROFILE.savingsAllocation },
    employerMatch: { ...SAMPLE_PROFILE.employerMatch },
    timelineOverrides: {},
  };
}
