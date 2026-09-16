const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
const percentFormatter = new Intl.NumberFormat("en-US", {
  style: "percent",
  maximumFractionDigits: 1,
});

let workingProfile = cloneSampleProfile();
let currentPage = "readiness";
let lastValidProjection = null;
let currentValidationState = {
  blockingErrors: [],
  warnings: [],
  isValid: true,
};

const pageTitles = {
  readiness: ["READINESS", "Retirement Readiness"],
  profile: ["PLAN SETUP", "Plan Setup"],
  assets: ["ASSETS", "Assets"],
  cashflow: ["CASH FLOW", "Income & Expenses"],
  timeline: ["TIMELINE", "Wealth Timeline"],
  recommendations: ["RECOMMENDATIONS", "Recommendations"],
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const setText = (selector, value) => {
  const element = $(selector);
  if (element) element.textContent = String(value);
};
const setWidth = (selector, value) => {
  const element = $(selector);
  if (element) element.style.width = value;
};
const money = (value) =>
  currencyFormatter.format(Number.isFinite(value) ? value : 0);
const percent = (value) =>
  percentFormatter.format(Number.isFinite(value) ? value : 0);
const numberValue = (value) =>
  Number.isFinite(Number(value)) ? Number(value) : 0;
// Rounds away binary floating-point artifacts (e.g. 0.044 * 100 -> 4.4, never 4.4000000000000004).
const roundTo = (value, decimals) => {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
};

// IRS Uniform Lifetime Table divisors (illustrative, ages 72-100+).
const RMD_DIVISOR_TABLE = {
  72: 27.4,
  73: 26.5,
  74: 25.5,
  75: 24.6,
  76: 23.7,
  77: 22.9,
  78: 22,
  79: 21.1,
  80: 20.2,
  81: 19.4,
  82: 18.5,
  83: 17.7,
  84: 16.8,
  85: 16,
  86: 15.2,
  87: 14.4,
  88: 13.7,
  89: 12.9,
  90: 12.2,
  91: 11.5,
  92: 10.8,
  93: 10.1,
  94: 9.5,
  95: 8.9,
  96: 8.4,
  97: 7.8,
  98: 7.3,
  99: 6.8,
  100: 6.4,
};
const NIIT_RATE = 0.038;
const SOCIAL_SECURITY_FULL_RETIREMENT_AGE = 67;

function rmdDivisor(age) {
  const roundedAge = Math.round(age);
  if (roundedAge <= 72) return RMD_DIVISOR_TABLE[72];
  if (roundedAge >= 100) return RMD_DIVISOR_TABLE[100];
  return RMD_DIVISOR_TABLE[roundedAge] ?? RMD_DIVISOR_TABLE[72];
}

function requiredMinimumDistribution(profile, preTaxBalance, age) {
  if (age < profile.rmdStartAge || preTaxBalance <= 0) return 0;
  const divisor = rmdDivisor(age);
  return divisor > 0 ? preTaxBalance / divisor : 0;
}

// Simplified NIIT: 3.8% of the lesser of investment gain or MAGI over the threshold.
function netInvestmentIncomeTax(profile, ordinaryIncome, investmentGain) {
  if (investmentGain <= 0) return 0;
  const magiOverage = Math.max(
    0,
    ordinaryIncome + investmentGain - profile.niitThreshold,
  );
  return Math.min(investmentGain, magiOverage) * NIIT_RATE;
}

// Taxes annual brokerage gains once (taxable-gains rate + NIIT) instead of compounding pre-tax.
function applyBrokerageGrowth(profile, brokerage, realReturn, ordinaryIncome) {
  if (realReturn <= 0 || brokerage <= 0) {
    return { balance: brokerage * (1 + realReturn), gainsTax: 0, niit: 0 };
  }
  const gain = brokerage * realReturn;
  const gainsTax = gain * profile.taxableGainsTaxRate;
  const niit = netInvestmentIncomeTax(profile, ordinaryIncome, gain);
  return { balance: brokerage + gain - gainsTax - niit, gainsTax, niit };
}

const ILLUSTRATIVE_FEDERAL_BRACKETS = {
  Single: [
    [11925, 0.1],
    [48475, 0.12],
    [103350, 0.22],
    [197300, 0.24],
    [250525, 0.32],
    [626350, 0.35],
    [Infinity, 0.37],
  ],
  "Married filing jointly": [
    [23850, 0.1],
    [96950, 0.12],
    [206700, 0.22],
    [394600, 0.24],
    [501050, 0.32],
    [751600, 0.35],
    [Infinity, 0.37],
  ],
  "Head of household": [
    [17000, 0.1],
    [64850, 0.12],
    [103350, 0.22],
    [197300, 0.24],
    [250500, 0.32],
    [626350, 0.35],
    [Infinity, 0.37],
  ],
};

function progressiveFederalTax(profile, income) {
  const taxableIncome = Math.max(0, income - profile.federalStandardDeduction);
  const brackets =
    ILLUSTRATIVE_FEDERAL_BRACKETS[profile.filingStatus] ||
    ILLUSTRATIVE_FEDERAL_BRACKETS.Single;
  let tax = 0;
  let lowerBound = 0;
  for (const [upperBound, rate] of brackets) {
    const amountInBracket = Math.max(
      0,
      Math.min(taxableIncome, upperBound) - lowerBound,
    );
    tax += amountInBracket * rate;
    lowerBound = upperBound;
    if (taxableIncome <= upperBound) break;
  }
  return tax;
}

function ordinaryIncomeTax(profile, ordinaryIncome) {
  return (
    progressiveFederalTax(profile, ordinaryIncome) +
    Math.max(0, ordinaryIncome) * profile.stateIncomeTaxRate
  );
}

function realAnnualReturn(profile) {
  return (1 + profile.expectedAnnualReturn) / (1 + profile.inflationRate) - 1;
}

function contributionRate(profile, key) {
  return Math.min(1, Math.max(0, numberValue(profile.contributionRates[key])));
}

function iraContributionAmount(profile, key) {
  const source = profile.iraContributions;
  return Math.max(0, numberValue(source ? source[key] : 0));
}

// Normalizes Brokerage/Cash allocation shares so they always split available savings 100%,
// defensively guarding the calculation engine even if a caller supplies shares that don't sum
// to 1 (validation blocks that in the UI, but this keeps the math safe for any raw profile).
function normalizedSavingsAllocation(profile) {
  const allocation = profile.savingsAllocation || {};
  const brokerageRaw = Math.max(0, numberValue(allocation.brokerage));
  const cashRaw = Math.max(0, numberValue(allocation.cash));
  const total = brokerageRaw + cashRaw;
  if (total <= 0) return { brokerage: 0.5, cash: 0.5 };
  return { brokerage: brokerageRaw / total, cash: cashRaw / total };
}

// Converts legacy percentage-based Traditional/Roth IRA contributionRates into fixed annual
// dollar amounts using the profile's own income and tax assumptions, preserving the user's
// approximate original savings intent. No-ops for profiles that already use iraContributions.
function migrateLegacyIraContributions(rawProfile) {
  const legacyRates = rawProfile && rawProfile.contributionRates;
  const hasLegacyIra =
    legacyRates &&
    (numberValue(legacyRates.traditionalIra) > 0 ||
      numberValue(legacyRates.rothIra) > 0);
  const hasNewIra =
    rawProfile.iraContributions &&
    (numberValue(rawProfile.iraContributions.traditionalIraAnnual) > 0 ||
      numberValue(rawProfile.iraContributions.rothIraAnnual) > 0);

  if (!hasLegacyIra || hasNewIra) {
    return rawProfile.iraContributions
      ? rawProfile
      : {
          ...rawProfile,
          iraContributions: { traditionalIraAnnual: 0, rothIraAnnual: 0 },
        };
  }

  const salary = Math.max(0, numberValue(rawProfile.annualSalary));
  const otherIncome = Math.max(0, numberValue(rawProfile.otherAnnualIncome));
  const earnedIncome = salary + otherIncome;
  const employeeFourOhOneK =
    salary * Math.min(1, Math.max(0, numberValue(legacyRates.fourOhOneK)));
  const traditionalIraRate = Math.min(
    1,
    Math.max(0, numberValue(legacyRates.traditionalIra)),
  );
  const traditionalIraAnnual = earnedIncome * traditionalIraRate;
  const taxableIncome = Math.max(
    0,
    earnedIncome - employeeFourOhOneK - traditionalIraAnnual,
  );
  const afterTaxIncome = Math.max(
    0,
    taxableIncome - ordinaryIncomeTax(rawProfile, taxableIncome),
  );
  const rothIraRate = Math.min(
    1,
    Math.max(0, numberValue(legacyRates.rothIra)),
  );
  const rothIraAnnual = afterTaxIncome * rothIraRate;

  const migratedContributionRates = { ...legacyRates };
  delete migratedContributionRates.traditionalIra;
  delete migratedContributionRates.rothIra;

  return {
    ...rawProfile,
    contributionRates: migratedContributionRates,
    iraContributions: {
      traditionalIraAnnual: Math.round(traditionalIraAnnual),
      rothIraAnnual: Math.round(rothIraAnnual),
    },
  };
}

// Converts legacy percentage-of-income Brokerage/Cash contributionRates into a Brokerage/Cash
// savingsAllocation split (shares of Available Annual Savings), preserving the user's
// approximate original balance between the two. No-ops for profiles that already use
// savingsAllocation.
function migrateLegacySavingsAllocation(rawProfile) {
  const legacyRates = rawProfile && rawProfile.contributionRates;
  const hasLegacyAllocation =
    legacyRates &&
    (numberValue(legacyRates.brokerage) > 0 ||
      numberValue(legacyRates.cash) > 0);
  const hasNewAllocation =
    rawProfile.savingsAllocation &&
    (numberValue(rawProfile.savingsAllocation.brokerage) > 0 ||
      numberValue(rawProfile.savingsAllocation.cash) > 0);

  if (!hasLegacyAllocation || hasNewAllocation) {
    return rawProfile.savingsAllocation
      ? rawProfile
      : { ...rawProfile, savingsAllocation: { brokerage: 0.75, cash: 0.25 } };
  }

  const legacyBrokerage = Math.max(0, numberValue(legacyRates.brokerage));
  const legacyCash = Math.max(0, numberValue(legacyRates.cash));
  const legacyTotal = legacyBrokerage + legacyCash;
  const brokerageShare = legacyTotal > 0 ? legacyBrokerage / legacyTotal : 0.75;
  const cashShare = legacyTotal > 0 ? legacyCash / legacyTotal : 0.25;

  const migratedContributionRates = { ...legacyRates };
  delete migratedContributionRates.brokerage;
  delete migratedContributionRates.cash;

  return {
    ...rawProfile,
    contributionRates: migratedContributionRates,
    savingsAllocation: {
      brokerage: roundTo(brokerageShare, 4),
      cash: roundTo(cashShare, 4),
    },
  };
}

function calculateContributions(profile, salaryOverride, otherIncomeOverride) {
  const salaryInput =
    salaryOverride != null ? salaryOverride : profile.annualSalary;
  const otherIncomeInput =
    otherIncomeOverride != null
      ? otherIncomeOverride
      : profile.otherAnnualIncome;
  const earnedIncome = Math.max(
    0,
    numberValue(salaryInput) + numberValue(otherIncomeInput),
  );
  const salary = Math.max(0, numberValue(salaryInput));
  const employeeFourOhOneK = salary * contributionRate(profile, "fourOhOneK");
  const traditionalIra = iraContributionAmount(profile, "traditionalIraAnnual");
  const employeePreTaxContributions = employeeFourOhOneK + traditionalIra;
  const taxableIncome = Math.max(0, earnedIncome - employeePreTaxContributions);
  const currentFederalTax = progressiveFederalTax(profile, taxableIncome);
  const currentStateTax = taxableIncome * profile.stateIncomeTaxRate;
  const afterTaxIncome = Math.max(
    0,
    taxableIncome - currentFederalTax - currentStateTax,
  );
  const rothIra = iraContributionAmount(profile, "rothIraAnnual");
  // Available Annual Savings = after-tax income minus current expenses minus the Roth IRA
  // contribution; it can never go negative, so Brokerage/Cash allocations never create
  // additional negative cash flow.
  const availableAnnualSavings = Math.max(
    0,
    afterTaxIncome - numberValue(profile.currentAnnualExpenses) - rothIra,
  );
  const savingsAllocation = normalizedSavingsAllocation(profile);
  const brokerage = availableAnnualSavings * savingsAllocation.brokerage;
  const cash = availableAnnualSavings * savingsAllocation.cash;
  const employeePostTaxContributions = rothIra + brokerage + cash;
  const matchRate = Math.min(
    1,
    Math.max(0, numberValue(profile.employerMatch.rate)),
  );
  const matchCap = Math.min(
    1,
    Math.max(0, numberValue(profile.employerMatch.salaryCap)),
  );
  const employerFourOhOneKMatch = Math.min(
    employeeFourOhOneK * matchRate,
    salary * matchCap,
  );
  const employeeSavings =
    employeePreTaxContributions + employeePostTaxContributions;
  const totalRetirementContributions =
    employeeFourOhOneK + traditionalIra + rothIra + employerFourOhOneKMatch;
  const totalAnnualSavings = totalRetirementContributions + brokerage + cash;

  return {
    earnedIncome,
    taxableIncome,
    currentFederalTax,
    currentStateTax,
    afterTaxIncome,
    employeeFourOhOneK,
    traditionalIra,
    rothIra,
    availableAnnualSavings,
    brokerage,
    cash,
    employeePreTaxContributions,
    employeePostTaxContributions,
    employeeSavings,
    employerFourOhOneKMatch,
    totalRetirementContributions,
    totalAnnualSavings,
  };
}

function projectPortfolio(profile, years) {
  const starting = profile.assets;
  const returnRate = realAnnualReturn(profile);
  const contributions = calculateContributions(profile);
  let brokerage = starting.brokerage;
  let preTax = starting.fourOhOneK + starting.traditionalIra;
  let roth = starting.rothIra;
  let cash = starting.cash;
  let conversionTax = 0;
  const baseTax = ordinaryIncomeTax(profile, contributions.taxableIncome);

  for (let year = 0; year < years; year += 1) {
    const growth = applyBrokerageGrowth(
      profile,
      brokerage,
      returnRate,
      contributions.taxableIncome,
    );
    brokerage = growth.balance;
    preTax *= 1 + returnRate;
    roth *= 1 + returnRate;
    cash += contributions.cash;
    brokerage += contributions.brokerage;
    preTax +=
      contributions.employeeFourOhOneK +
      contributions.employerFourOhOneKMatch +
      contributions.traditionalIra;
    roth += contributions.rothIra;

    const conversion = recommendedRothConversionAmount(
      profile,
      false,
      profile.currentAge + year,
      contributions.taxableIncome,
      preTax,
    );
    if (conversion > 0) {
      const taxOnConversion = Math.max(
        0,
        ordinaryIncomeTax(profile, contributions.taxableIncome + conversion) -
          baseTax,
      );
      preTax -= conversion;
      roth += conversion;
      brokerage = Math.max(0, brokerage - taxOnConversion);
      conversionTax += taxOnConversion;
    }
  }

  return {
    brokerage,
    preTax,
    roth,
    cash,
    conversionTax,
    afterTaxAssets:
      brokerage + roth + cash + preTax * (1 - profile.preTaxWithdrawalTaxRate),
  };
}

function retirementNeed(profile, portfolio, age) {
  const taxableSocialSecurity =
    profile.socialSecurityAnnualBenefit * profile.socialSecurityTaxablePercent;
  const socialSecurityTax = Math.max(
    0,
    ordinaryIncomeTax(profile, taxableSocialSecurity) -
      ordinaryIncomeTax(profile, 0),
  );
  const netSocialSecurity = Math.max(
    0,
    profile.socialSecurityAnnualBenefit - socialSecurityTax,
  );
  const rmd = requiredMinimumDistribution(profile, portfolio.preTax, age);
  const retirementTax = ordinaryIncomeTax(profile, taxableSocialSecurity + rmd);
  const irmaa =
    taxableSocialSecurity + rmd > profile.irmaaIncomeThreshold
      ? profile.irmaaAnnualSurcharge
      : 0;
  const spendingFromPortfolio = Math.max(
    0,
    profile.retirementAnnualSpendingGoal - netSocialSecurity,
  );
  const grossPortfolioSpending =
    profile.preTaxWithdrawalTaxRate < 1
      ? spendingFromPortfolio / (1 - profile.preTaxWithdrawalTaxRate)
      : Infinity;
  const requiredAssets =
    profile.safeWithdrawalRate > 0
      ? (grossPortfolioSpending + irmaa) / profile.safeWithdrawalRate
      : Infinity;
  return {
    requiredAssets,
    rmd,
    irmaa,
    socialSecurityTax,
    netSocialSecurity,
    retirementTax,
  };
}

// Illustrative SSA early/delayed claiming reduction, assuming fraBenefit is the full retirement
// age (67) benefit. Single-filer only; no spousal benefit modeling.
function benefitForClaimAge(fraBenefit, claimAge) {
  if (claimAge < SOCIAL_SECURITY_FULL_RETIREMENT_AGE) {
    const monthsEarly = (SOCIAL_SECURITY_FULL_RETIREMENT_AGE - claimAge) * 12;
    const reduction =
      Math.min(monthsEarly, 36) * (5 / 9 / 100) +
      Math.max(monthsEarly - 36, 0) * (5 / 12 / 100);
    return Math.max(0, fraBenefit * (1 - reduction));
  }
  if (claimAge > SOCIAL_SECURITY_FULL_RETIREMENT_AGE) {
    const monthsLate = (claimAge - SOCIAL_SECURITY_FULL_RETIREMENT_AGE) * 12;
    return Math.max(0, fraBenefit * (1 + monthsLate * (2 / 3 / 100)));
  }
  return Math.max(0, fraBenefit);
}

function socialSecurityClaimingSchedule(fraBenefit) {
  const schedule = [];
  for (let claimAge = 62; claimAge <= 70; claimAge += 1) {
    schedule.push({
      claimAge,
      annualBenefit: benefitForClaimAge(fraBenefit, claimAge),
    });
  }
  return schedule;
}

// Illustrative replacement-rate estimate for Social Security benefit at Full Retirement Age.
function estimatedSocialSecurityFraBenefit(profile) {
  return Math.max(
    0,
    Math.round((numberValue(profile?.annualSalary) * 0.35) / 500) * 500,
  );
}

// Migrates legacy profiles without an explicit socialSecurityBenefitMode:
// Preserves meaningful user-entered benefits (>0) by setting manual mode;
// defaults/migrates empty or $0 legacy benefits to auto mode.
function migrateSocialSecurityProfile(rawProfile) {
  if (!rawProfile || typeof rawProfile !== "object") return rawProfile;
  const benefitMode = rawProfile.socialSecurityBenefitMode;
  if (benefitMode === "manual" || benefitMode === "auto") {
    return rawProfile;
  }
  const annualBenefit = numberValue(rawProfile.socialSecurityAnnualBenefit);
  const isMeaningfulBenefit =
    Number.isFinite(annualBenefit) && annualBenefit > 0;
  return {
    ...rawProfile,
    socialSecurityBenefitMode: isMeaningfulBenefit ? "manual" : "auto",
  };
}

// Searches claim ages 62-70 with the shared timeline engine and picks the one that keeps the
// plan solvent longest (or, among solvent ages, leaves the most assets at life expectancy).
function recommendedSocialSecurityClaimAge(profile, fraBenefit) {
  let best = null;
  for (let claimAge = 62; claimAge <= 70; claimAge += 1) {
    const trialProfile = {
      ...profile,
      socialSecurityStrategy: "manual",
      socialSecurityBenefitMode: "manual",
      socialSecurityAnnualBenefit: benefitForClaimAge(fraBenefit, claimAge),
      socialSecurityClaimAge: claimAge,
    };
    const summary = timelineSummary(
      buildTimelineRows(trialProfile),
      trialProfile,
    );
    const candidate = {
      claimAge,
      depletionAge: summary.depletionAge,
      finalAssets: summary.finalAssets,
    };
    const candidateBeatsBest =
      !best ||
      (candidate.depletionAge == null && best.depletionAge != null) ||
      (candidate.depletionAge == null &&
        best.depletionAge == null &&
        candidate.finalAssets > best.finalAssets) ||
      (candidate.depletionAge != null &&
        best.depletionAge != null &&
        candidate.depletionAge > best.depletionAge);
    if (candidateBeatsBest) best = candidate;
  }
  return best ? best.claimAge : SOCIAL_SECURITY_FULL_RETIREMENT_AGE;
}

// Resolves the Social Security plan into concrete numbers:
// 1. Benefit source (auto estimate vs manual entry) determines the FRA benefit.
// 2. Claim-age source (model-recommended vs Plan Setup selection) determines the effective claim age.
// 3. The claim-age adjustment logic calculates the annual benefit at the chosen claim age.
function resolveSocialSecurityPlan(rawProfile) {
  const profile = migrateSocialSecurityProfile(rawProfile) || rawProfile;
  const isManual = profile.socialSecurityBenefitMode === "manual";
  const fraBenefit = isManual
    ? Math.max(0, numberValue(profile.socialSecurityAnnualBenefit))
    : estimatedSocialSecurityFraBenefit(profile);

  const claimStrategy =
    profile.socialSecurityStrategy === "auto" ? "auto" : "manual";
  const claimAge =
    claimStrategy === "auto"
      ? recommendedSocialSecurityClaimAge(profile, fraBenefit)
      : Math.min(
          70,
          Math.max(
            62,
            Math.round(numberValue(profile.socialSecurityClaimAge)) ||
              SOCIAL_SECURITY_FULL_RETIREMENT_AGE,
          ),
        );

  return {
    source: isManual ? "manual" : "auto",
    benefitMode: isManual ? "manual" : "auto",
    claimStrategy,
    fraBenefit,
    claimAge,
    annualBenefit: benefitForClaimAge(fraBenefit, claimAge),
  };
}

// Collapses the Social Security strategy into concrete manual-equivalent fields so the timeline
// engine never has to re-run the claim-age search recursively.
function resolveEffectiveProfile(rawProfile) {
  const profile = migrateSocialSecurityProfile(rawProfile) || rawProfile;
  const ssPlan = resolveSocialSecurityPlan(profile);
  return {
    effectiveProfile: {
      ...profile,
      socialSecurityBenefitMode: ssPlan.benefitMode,
      socialSecurityStrategy: "manual",
      // The engine always runs on the claim-age-adjusted benefit, never the raw FRA amount.
      socialSecurityAnnualBenefit: ssPlan.annualBenefit,
      socialSecurityClaimAge: ssPlan.claimAge,
    },
    ssPlan,
  };
}

// Illustrative Roth-conversion bracket-fill ceiling (top of the 22% federal bracket).
function rothConversionCeiling(profile) {
  const brackets =
    ILLUSTRATIVE_FEDERAL_BRACKETS[profile.filingStatus] ||
    ILLUSTRATIVE_FEDERAL_BRACKETS.Single;
  const target = brackets.find(([, rate]) => rate === 0.22);
  return target ? target[0] : brackets[0][0];
}

// Model-generated Roth conversion amount for a given year. Manual strategy uses the editable
// annual amount every year. Auto strategy only converts during the classic pre-RMD window
// (retirement through the year before RMDs start), filling headroom up to an illustrative 22%
// federal bracket ceiling, limited by the available pre-tax balance.
function recommendedRothConversionAmount(
  profile,
  isRetired,
  age,
  baselineOrdinaryIncome,
  availablePreTax,
) {
  if (profile.rothConversionStrategy !== "auto") {
    return Math.min(
      Math.max(0, availablePreTax),
      Math.max(0, numberValue(profile.rothConversionAnnualAmount)),
    );
  }
  if (!isRetired || age >= profile.rmdStartAge) return 0;
  const ceiling = rothConversionCeiling(profile);
  const headroom = Math.max(
    0,
    ceiling -
      Math.max(0, baselineOrdinaryIncome - profile.federalStandardDeduction),
  );
  return Math.min(Math.max(0, availablePreTax), headroom);
}

function calculate(rawProfile) {
  // Migrate legacy percentage-based IRA contribution profiles, then legacy percentage-of-income
  // Brokerage/Cash contribution rates, before anything else runs, so every downstream
  // calculation sees only the current fixed/allocation-based fields.
  const migratedProfile = migrateLegacySavingsAllocation(
    migrateLegacyIraContributions(rawProfile),
  );
  // Resolve model-generated strategies (currently Social Security claiming) once, up front, so
  // every downstream calculation shares the same concrete assumptions as the Timeline.
  const { effectiveProfile: profile, ssPlan } =
    resolveEffectiveProfile(migratedProfile);
  const assets = profile.assets;
  const financialAssets =
    assets.brokerage +
    assets.fourOhOneK +
    assets.traditionalIra +
    assets.rothIra +
    assets.cash;
  const totalAssets = financialAssets + assets.realEstate;
  const contributions = calculateContributions(profile);
  const totalIncome = contributions.earnedIncome;
  const surplus =
    contributions.afterTaxIncome -
    contributions.employeePostTaxContributions -
    profile.currentAnnualExpenses;
  const savingsRate =
    totalIncome > 0 ? contributions.employeeSavings / totalIncome : 0;
  const yearsToTarget = Math.max(
    0,
    profile.targetRetirementAge - profile.currentAge,
  );
  const portfolio = projectPortfolio(profile, yearsToTarget);
  const timelineRows = buildTimelineRows(profile);
  const timeline = timelineSummary(timelineRows, profile);
  const targetRow = timelineRows.find(
    (row) => row.age === Math.round(numberValue(profile.targetRetirementAge)),
  );
  const projectedRetirementBalances = targetRow
    ? targetRow.startBalances
    : {
        brokerage: portfolio.brokerage,
        preTax: portfolio.preTax,
        roth: portfolio.roth,
        cash: portfolio.cash,
      };
  const projectedAssets = afterTaxAssetsFromBalances(
    profile,
    projectedRetirementBalances,
  );
  const requiredAssets = requiredRetirementAssets(
    profile,
    projectedRetirementBalances,
  );
  const fundingDelta = requiredAssets - projectedAssets;
  const expectedRetirementAge = findExpectedRetirementAge(profile);
  const savingsComponent = Math.min(1, Math.max(0, savingsRate / 0.2));
  const fundingComponent =
    requiredAssets > 0
      ? Math.min(1, Math.max(0, projectedAssets / requiredAssets))
      : 1;
  const timingComponent =
    expectedRetirementAge === null
      ? 0
      : expectedRetirementAge <= profile.targetRetirementAge
        ? 1
        : Math.max(
            0,
            1 -
              (expectedRetirementAge - profile.targetRetirementAge) /
                Math.max(
                  1,
                  profile.lifeExpectancy - profile.targetRetirementAge,
                ),
          );
  // A depletion year is already reflected in the horizon-based funding comparison;
  // retain a separate penalty so the score also communicates how early it occurs.
  const sustainabilityPenalty =
    timeline.depletionAge != null
      ? Math.min(
          20,
          ((profile.lifeExpectancy - timeline.depletionAge) /
            Math.max(1, profile.lifeExpectancy - profile.targetRetirementAge)) *
            20,
        )
      : 0;
  const score = Math.round(
    Math.max(
      0,
      Math.min(
        100,
        fundingComponent * 60 +
          savingsComponent * 25 +
          timingComponent * 15 -
          sustainabilityPenalty,
      ),
    ),
  );
  const status =
    score >= 80
      ? "On Track"
      : score >= 50
        ? "Slightly Behind"
        : "Major Shortfall";

  return {
    financialAssets,
    totalAssets,
    totalIncome,
    afterTaxIncome: contributions.afterTaxIncome,
    surplus,
    savingsRate,
    availableAnnualSavings: contributions.availableAnnualSavings,
    brokerageContribution: contributions.brokerage,
    cashContribution: contributions.cash,
    employeeSavings: contributions.employeeSavings,
    employerFourOhOneKMatch: contributions.employerFourOhOneKMatch,
    totalRetirementContributions: contributions.totalRetirementContributions,
    totalAnnualSavings: contributions.totalAnnualSavings,
    yearsToTarget,
    projectedAssets,
    requiredAssets,
    fundingDelta,
    expectedRetirementAge,
    score,
    status,
    safeSpending: sustainableAnnualSpending(profile),
    currentFederalTax: contributions.currentFederalTax,
    currentStateTax: contributions.currentStateTax,
    projectedConversionTax: portfolio.conversionTax,
    projectedRmd: timeline.cumulativeRmd,
    projectedNiit: timeline.cumulativeNiit,
    projectedSocialSecurityTax: timeline.cumulativeSocialSecurityTax,
    projectedIrmaa: timeline.cumulativeIrmaa,
    afterTaxAssets: projectedAssets,
    timelineDepletionAge: timeline.depletionAge,
    timelineIrmaaAge: timeline.firstIrmaaAge,
    socialSecurityPlan: ssPlan,
    rothConversionWindowEndAge: profile.rmdStartAge,
  };
}

function projectAssets(profile, years) {
  return projectPortfolio(profile, years).afterTaxAssets;
}

function findExpectedRetirementAge(profile) {
  for (let age = profile.currentAge; age <= profile.lifeExpectancy; age += 1) {
    const portfolio = projectPortfolio(profile, age - profile.currentAge);
    const balances = {
      brokerage: portfolio.brokerage,
      preTax: portfolio.preTax,
      roth: portfolio.roth,
      cash: portfolio.cash,
    };
    const ageProfile = { ...profile, targetRetirementAge: age };
    const requiredAssets = requiredRetirementAssets(ageProfile, balances);
    if (afterTaxAssetsFromBalances(profile, balances) >= requiredAssets)
      return age;
  }
  return null;
}

function timelineOverrideIsAllowed(profile, age, field) {
  const startAge = Math.round(numberValue(profile.currentAge));
  const endAge = Math.round(numberValue(profile.lifeExpectancy));
  if (age < startAge || age > endAge) return false;
  const isRetired = age >= numberValue(profile.targetRetirementAge);
  if (field === "returnPercent" || field === "expenses") return true;
  if (field === "income" || field === "extraCashNeed") return !isRetired;
  if (field === "extraWithdrawal" || field === "withdrawal") return isRetired;
  return false;
}

function timelineOverrideFor(profile, age) {
  const stored = (profile.timelineOverrides && profile.timelineOverrides[age]) || {};
  return Object.fromEntries(
    Object.entries(stored).filter(([field, value]) => {
      const minimum = field === "returnPercent" ? -100 : 0;
      return (
        timelineOverrideIsAllowed(profile, age, field) &&
        Number.isFinite(Number(value)) &&
        Number(value) >= minimum
      );
    }),
  );
}

function setTimelineOverride(age, field, rawValue) {
  const overrides = workingProfile.timelineOverrides;
  if (!Number.isInteger(age) || !timelineOverrideIsAllowed(workingProfile, age, field)) return;
  const existing = { ...timelineOverrideFor(workingProfile, age) };
  if (rawValue === "" || rawValue === null || rawValue === undefined) {
    delete existing[field];
  } else {
    const value = Number(rawValue);
    const minimum = field === "returnPercent" ? -100 : 0;
    if (!Number.isFinite(value) || value < minimum) return;
    existing[field] = value;
  }
  if (Object.keys(existing).length === 0) {
    delete overrides[age];
  } else {
    overrides[age] = existing;
  }
}

function clearTimelineOverride(age) {
  delete workingProfile.timelineOverrides[age];
}

function clearAllTimelineOverrides() {
  workingProfile.timelineOverrides = {};
}

// Builds one editable row per age from today through life expectancy: accumulation while
// working, then withdrawal-funded decumulation once the target retirement age is reached.
function buildTimelineRows(profile) {
  const rows = [];
  const startAge = Math.round(numberValue(profile.currentAge));
  const endAge = Math.round(numberValue(profile.lifeExpectancy));
  if (
    !Number.isFinite(startAge) ||
    !Number.isFinite(endAge) ||
    endAge < startAge
  ) {
    return rows;
  }

  let brokerage = profile.assets.brokerage;
  let preTax = profile.assets.fourOhOneK + profile.assets.traditionalIra;
  let roth = profile.assets.rothIra;
  let cash = profile.assets.cash;

  for (let age = startAge; age <= endAge; age += 1) {
    const override = timelineOverrideFor(profile, age);
    const isRetired = age >= profile.targetRetirementAge;
    const startBalances = { brokerage, preTax, roth, cash };
    const startTotal = brokerage + preTax + roth + cash;

    const defaultReturnPercent = profile.expectedAnnualReturn * 100;
    const returnPercent =
      override.returnPercent != null
        ? numberValue(override.returnPercent)
        : defaultReturnPercent;
    const nominalReturn = returnPercent / 100;
    const realReturn = Math.max(
      -0.99,
      (1 + nominalReturn) / (1 + profile.inflationRate) - 1,
    );

    const defaultIncome = isRetired
      ? null
      : profile.annualSalary + profile.otherAnnualIncome;
    const salaryForYear = isRetired
      ? 0
      : override.income != null
        ? numberValue(override.income)
        : profile.annualSalary;

    const defaultExpenses = isRetired
      ? profile.retirementAnnualSpendingGoal
      : profile.currentAnnualExpenses;
    const expenses =
      override.expenses != null
        ? Math.max(0, numberValue(override.expenses))
        : defaultExpenses;
    const extraCashNeed = !isRetired
      ? Math.max(0, numberValue(override.extraCashNeed))
      : 0;
    const extraWithdrawal =
      override.extraWithdrawal != null
        ? Math.max(0, numberValue(override.extraWithdrawal))
        : 0;
    const withdrawalOverride = isRetired && override.withdrawal != null
      ? Math.max(0, numberValue(override.withdrawal))
      : null;

    let contribution = 0;
    let contributionDetails = null;
    let withdrawal = 0;
    let rmd = 0;
    let niit = 0;
    let rowSocialSecurityTax = 0;
    let rowIrmaa = 0;
    let rowConversion = 0;
    let rowConversionTax = 0;
    let rowWithdrawalSources = null;
    let rowSocialSecurityGross = 0;
    let rowSpending = 0;
    let rowNetCashFlow = 0;
    let rowPortfolioWithdrawal = 0;
    let rowUnmetCashNeed = 0;
    let rowUnmetSpendingNeed = 0;
    let rowUnmetWithdrawalNeed = 0;
    let rowRequestedWithdrawal = null;
    let rowDiscretionaryRequestedWithdrawal = 0;
    let income = defaultIncome;

    if (!isRetired) {
      const contributions = calculateContributions(
        profile,
        salaryForYear,
        profile.otherAnnualIncome,
      );
      contributionDetails = { ...contributions };
      const growth = applyBrokerageGrowth(
        profile,
        brokerage,
        realReturn,
        contributions.taxableIncome,
      );
      brokerage = growth.balance;
      niit = growth.niit;
      preTax *= 1 + realReturn;
      roth *= 1 + realReturn;

      income = salaryForYear + profile.otherAnnualIncome;
      cash += contributions.cash;
      brokerage += contributions.brokerage;
      preTax +=
        contributions.employeeFourOhOneK +
        contributions.employerFourOhOneKMatch +
        contributions.traditionalIra;
      roth += contributions.rothIra;
      contribution =
        contributions.employeeSavings + contributions.employerFourOhOneKMatch;
      rowSpending = expenses + extraCashNeed;

      const conversion = recommendedRothConversionAmount(
        profile,
        false,
        age,
        contributions.taxableIncome,
        preTax,
      );
      if (conversion > 0) {
        const baseTax = ordinaryIncomeTax(profile, contributions.taxableIncome);
        const taxOnConversion = Math.max(
          0,
          ordinaryIncomeTax(profile, contributions.taxableIncome + conversion) -
            baseTax,
        );
        preTax -= conversion;
        roth += conversion;
        brokerage = Math.max(0, brokerage - taxOnConversion);
      }
      rowConversion = conversion;
      rowNetCashFlow =
        contributions.afterTaxIncome -
        contributions.employeePostTaxContributions -
        expenses -
        extraCashNeed;

      const workingCashNeed = Math.max(
        0,
        expenses +
          extraCashNeed +
          contributions.employeePostTaxContributions -
          contributions.afterTaxIncome,
      );
      let remainingWorkingNeed = workingCashNeed;
      const fromCash = Math.min(cash, remainingWorkingNeed);
      cash -= fromCash;
      remainingWorkingNeed -= fromCash;
      const fromBrokerage = Math.min(brokerage, remainingWorkingNeed);
      brokerage -= fromBrokerage;
      remainingWorkingNeed -= fromBrokerage;
      const fromPreTax = Math.min(preTax, remainingWorkingNeed);
      preTax -= fromPreTax;
      remainingWorkingNeed -= fromPreTax;
      const fromRoth = Math.min(roth, remainingWorkingNeed);
      roth -= fromRoth;
      remainingWorkingNeed -= fromRoth;
      rowPortfolioWithdrawal =
        fromCash + fromBrokerage + fromPreTax + fromRoth;
      rowUnmetCashNeed = remainingWorkingNeed;
      rowWithdrawalSources = {
        cash: fromCash,
        brokerage: fromBrokerage,
        preTax: fromPreTax,
        roth: fromRoth,
        rmd: 0,
      };
    } else {
      const ssActive = age >= numberValue(profile.socialSecurityClaimAge);
      const taxableSocialSecurity = ssActive
        ? profile.socialSecurityAnnualBenefit *
          profile.socialSecurityTaxablePercent
        : 0;
      const socialSecurityTax = Math.max(
        0,
        ordinaryIncomeTax(profile, taxableSocialSecurity) -
          ordinaryIncomeTax(profile, 0),
      );
      const netSocialSecurity = ssActive
        ? Math.max(0, profile.socialSecurityAnnualBenefit - socialSecurityTax)
        : 0;
      rowSocialSecurityTax = socialSecurityTax;
      rowSocialSecurityGross = ssActive
        ? profile.socialSecurityAnnualBenefit
        : 0;
      income = netSocialSecurity;

      // RMD is based on the prior year-end pre-tax balance, before this year's growth.
      rmd = requiredMinimumDistribution(profile, preTax, age);
      const irmaa =
        taxableSocialSecurity + rmd > profile.irmaaIncomeThreshold
          ? profile.irmaaAnnualSurcharge
          : 0;

      const growth = applyBrokerageGrowth(
        profile,
        brokerage,
        realReturn,
        taxableSocialSecurity + rmd,
      );
      brokerage = growth.balance;
      niit = growth.niit;
      preTax *= 1 + realReturn;
      roth *= 1 + realReturn;

      // RMD is a forced distribution; only the balance remaining after it is available to convert.
      const preTaxAfterRmd = Math.max(0, preTax - rmd);
      const conversion = recommendedRothConversionAmount(
        profile,
        true,
        age,
        taxableSocialSecurity + rmd,
        preTaxAfterRmd,
      );
      let conversionTax = 0;
      if (conversion > 0) {
        const baseTax = ordinaryIncomeTax(profile, taxableSocialSecurity + rmd);
        conversionTax = Math.max(
          0,
          ordinaryIncomeTax(profile, taxableSocialSecurity + rmd + conversion) -
            baseTax,
        );
        preTax = preTaxAfterRmd - conversion;
        roth += conversion;
        brokerage = Math.max(0, brokerage - conversionTax);
      } else {
        preTax = preTaxAfterRmd;
      }
      rowConversion = conversion;
      rowConversionTax = conversionTax;

      const spendingGoal = expenses;
      const naturalRemaining = Math.max(
        0,
        spendingGoal + extraWithdrawal + irmaa - netSocialSecurity - rmd,
      );
      const requestedWithdrawal = withdrawalOverride ?? naturalRemaining + rmd;
      const requestedDiscretionaryWithdrawal = Math.max(
        0,
        requestedWithdrawal - rmd,
      );
      let remaining = requestedDiscretionaryWithdrawal;
      rowRequestedWithdrawal = requestedWithdrawal;
      rowDiscretionaryRequestedWithdrawal = requestedDiscretionaryWithdrawal;

      const fromCash = Math.min(cash, remaining);
      cash -= fromCash;
      remaining -= fromCash;

      const fromBrokerage = Math.min(brokerage, remaining);
      brokerage -= fromBrokerage;
      remaining -= fromBrokerage;

      let fromPreTaxGross = 0;
      if (remaining > 0 && profile.preTaxWithdrawalTaxRate < 1) {
        const grossNeeded = remaining / (1 - profile.preTaxWithdrawalTaxRate);
        fromPreTaxGross = Math.min(preTax, grossNeeded);
        preTax -= fromPreTaxGross;
        remaining -= fromPreTaxGross * (1 - profile.preTaxWithdrawalTaxRate);
      }

      const fromRoth = Math.min(roth, Math.max(0, remaining));
      roth -= fromRoth;
      remaining = Math.max(0, remaining - fromRoth);

      withdrawal = fromCash + fromBrokerage + fromPreTaxGross + fromRoth + rmd;
      const fundedDiscretionaryWithdrawal =
        fromCash +
        fromBrokerage +
        fromPreTaxGross * (1 - profile.preTaxWithdrawalTaxRate) +
        fromRoth;
      rowPortfolioWithdrawal = withdrawal;
      rowUnmetCashNeed = Math.max(0, remaining);
      rowUnmetWithdrawalNeed = rowUnmetCashNeed;
      rowUnmetSpendingNeed = Math.max(
        0,
        naturalRemaining - fundedDiscretionaryWithdrawal,
      );
      rowIrmaa = irmaa;
      rowWithdrawalSources = {
        cash: fromCash,
        brokerage: fromBrokerage,
        preTax: fromPreTaxGross,
        roth: fromRoth,
        rmd,
      };
      rowSpending = spendingGoal + extraWithdrawal;
      rowNetCashFlow =
        netSocialSecurity +
        -(spendingGoal + extraWithdrawal + irmaa) -
        rowConversionTax;

      // Sequence-of-returns guard: refill the cash reserve from brokerage only in up years.
      const targetCashBuffer =
        Math.max(0, numberValue(profile.cashReserveTargetYears)) * spendingGoal;
      if (realReturn > 0 && cash < targetCashBuffer && brokerage > 0) {
        const sweep = Math.min(brokerage, targetCashBuffer - cash);
        brokerage -= sweep;
        cash += sweep;
      }
    }

    brokerage = Math.max(0, brokerage);
    preTax = Math.max(0, preTax);
    roth = Math.max(0, roth);
    cash = Math.max(0, cash);
    const endBalances = { brokerage, preTax, roth, cash };
    const endTotal = brokerage + preTax + roth + cash;

    rows.push({
      age,
      isRetired,
      returnPercent,
      defaultReturnPercent,
      income,
      defaultIncome,
      expenses,
      defaultExpenses,
      extraCashNeed,
      extraWithdrawal,
      contribution,
      contributionDetails,
      withdrawal,
      actualWithdrawal: withdrawal,
      withdrawalOverride,
      mandatoryRmd: rmd,
      requestedWithdrawal: rowRequestedWithdrawal,
      discretionaryRequestedWithdrawal: rowDiscretionaryRequestedWithdrawal,
      portfolioWithdrawal: rowPortfolioWithdrawal,
      unmetCashNeed: rowUnmetCashNeed,
      unmetSpendingNeed: rowUnmetSpendingNeed,
      unmetWithdrawalNeed: rowUnmetWithdrawalNeed,
      rmd,
      niit,
      socialSecurityTax: rowSocialSecurityTax,
      socialSecurityGrossBenefit: rowSocialSecurityGross,
      irmaa: rowIrmaa,
      rothConversion: rowConversion,
      rothConversionTax: rowConversionTax,
      withdrawalSources: rowWithdrawalSources,
      spending: rowSpending,
      householdNetCashFlow: rowNetCashFlow,
      netCashFlow: rowNetCashFlow,
      portfolioCashFlow: rowPortfolioWithdrawal,
      startTotal,
      startBalances,
      endBalances,
      endTotal,
      endingAssets: endTotal,
      overrides: override,
      hasOverride: Object.keys(override).length > 0,
    });
  }

  return rows;
}

function timelineSummary(rows, profile) {
  if (!rows.length) {
    return {
      finalAssets: 0,
      depletionAge: null,
      overriddenYears: 0,
      firstIrmaaAge: null,
      cumulativeRmd: 0,
      cumulativeNiit: 0,
      cumulativeSocialSecurityTax: 0,
      cumulativeIrmaa: 0,
      cumulativeRothConversion: 0,
      cumulativeRothConversionTax: 0,
      firstConversionAge: null,
      lastConversionAge: null,
    };
  }
  const finalAssets = rows[rows.length - 1].endTotal;
  const depletionRow = rows.find((row) => row.isRetired && row.endTotal <= 0);
  const irmaaRow = rows.find((row) => row.isRetired && row.irmaa > 0);
  const conversionRows = rows.filter((row) => row.rothConversion > 0);
  return {
    finalAssets,
    depletionAge: depletionRow ? depletionRow.age : null,
    overriddenYears: rows.filter((row) => row.hasOverride).length,
    firstIrmaaAge: irmaaRow ? irmaaRow.age : null,
    cumulativeRmd: rows.reduce((total, row) => total + row.rmd, 0),
    cumulativeNiit: rows.reduce((total, row) => total + row.niit, 0),
    cumulativeSocialSecurityTax: rows.reduce(
      (total, row) => total + row.socialSecurityTax,
      0,
    ),
    cumulativeIrmaa: rows.reduce((total, row) => total + row.irmaa, 0),
    cumulativeRothConversion: rows.reduce(
      (total, row) => total + row.rothConversion,
      0,
    ),
    cumulativeRothConversionTax: rows.reduce(
      (total, row) => total + row.rothConversionTax,
      0,
    ),
    firstConversionAge: conversionRows.length ? conversionRows[0].age : null,
    lastConversionAge: conversionRows.length
      ? conversionRows[conversionRows.length - 1].age
      : null,
  };
}

function afterTaxAssetsFromBalances(profile, balances) {
  return (
    balances.brokerage +
    balances.roth +
    balances.cash +
    balances.preTax * (1 - profile.preTaxWithdrawalTaxRate)
  );
}

function requiredRetirementAssets(profile, startingBalances) {
  const balanceTotal =
    startingBalances.brokerage +
    startingBalances.preTax +
    startingBalances.roth +
    startingBalances.cash;
  const allocation =
    balanceTotal > 0
      ? startingBalances
      : { brokerage: 0, preTax: 0, roth: 0, cash: 1 };
  const targetAge = Math.round(numberValue(profile.targetRetirementAge));
  const retirementProfile = (scale) => ({
    ...profile,
    currentAge: targetAge,
    assets: {
      brokerage: allocation.brokerage * scale,
      fourOhOneK: allocation.preTax * scale,
      traditionalIra: 0,
      rothIra: allocation.roth * scale,
      cash: allocation.cash * scale,
      realEstate: 0,
    },
  });
  const isSustainable = (scale) =>
    timelineSummary(
      buildTimelineRows(retirementProfile(scale)),
      retirementProfile(scale),
    ).depletionAge == null;

  let high = 1;
  while (!isSustainable(high) && high < 1048576) high *= 2;
  if (!isSustainable(high)) return Infinity;

  let low = 0;
  for (let iteration = 0; iteration < 40; iteration += 1) {
    const middle = (low + high) / 2;
    if (isSustainable(middle)) high = middle;
    else low = middle;
  }
  return afterTaxAssetsFromBalances(profile, {
    brokerage: allocation.brokerage * high,
    preTax: allocation.preTax * high,
    roth: allocation.roth * high,
    cash: allocation.cash * high,
  });
}

function sustainableAnnualSpending(profile) {
  const isSustainable = (spendingGoal) => {
    const spendingProfile = {
      ...profile,
      retirementAnnualSpendingGoal: spendingGoal,
    };
    const rows = buildTimelineRows(spendingProfile);
    return timelineSummary(rows, spendingProfile).depletionAge == null;
  };

  if (!isSustainable(0)) return 0;

  let high = Math.max(1000, numberValue(profile.retirementAnnualSpendingGoal));
  while (isSustainable(high) && high < 1048576) high *= 2;
  if (isSustainable(high)) return high;

  let low = 0;
  for (let iteration = 0; iteration < 40; iteration += 1) {
    const middle = (low + high) / 2;
    if (isSustainable(middle)) low = middle;
    else high = middle;
  }
  return low;
}

function inputConfig() {
  return {
    profile: [
      ["name", "Name", "text", "", "Alex Morgan"],
      ["currentAge", "Current age", "number", "years", 45],
      ["targetRetirementAge", "Target retirement age", "number", "years", 65],
      ["lifeExpectancy", "Life expectancy", "number", "years", 90],
    ],
    assumptions: [
      [
        "expectedAnnualReturn",
        "Expected annual return (nominal)",
        "percent",
        "%",
        5,
      ],
      ["inflationRate", "Inflation rate", "percent", "%", 2.5],
      ["safeWithdrawalRate", "Safe withdrawal rate", "percent", "%", 4],
      [
        "projectionBasis",
        "Projection basis",
        "select",
        "",
        "real_dollars",
        [["real_dollars", "Real dollars"]],
      ],
    ],
    basicTax: [
      ["state", "State", "text", "", "Florida"],
      [
        "filingStatus",
        "Tax filing status",
        "select",
        "",
        "Married filing jointly",
        ["Single", "Married filing jointly", "Head of household"],
      ],
      [
        "socialSecurityBenefitMode",
        "Social Security benefit",
        "select",
        "",
        "auto",
        [
          ["auto", "Automatically estimate"],
          ["manual", "Enter manually"],
        ],
      ],
      [
        "socialSecurityEstimatedBenefit",
        "Estimated annual benefit at Full Retirement Age",
        "readonly",
        "Estimated from your current earnings for retirement planning. For greater accuracy, use the benefit estimate from your Social Security statement.",
        0,
      ],
      [
        "socialSecurityAnnualBenefit",
        "Annual Benefit at Full Retirement Age",
        "currency",
        "per year, assumed at Full Retirement Age (67)",
        0,
      ],
      [
        "socialSecurityClaimAge",
        "Social Security claim age",
        "number",
        "years, 62-70 (default 67)",
        67,
      ],
    ],
    advancedTax: [
      [
        "federalStandardDeduction",
        "Federal standard deduction",
        "currency",
        "per year",
        30000,
      ],
      ["stateIncomeTaxRate", "State income tax rate", "percent", "%", 0],
      ["taxableGainsTaxRate", "Taxable gains tax rate", "percent", "%", 15],
      [
        "preTaxWithdrawalTaxRate",
        "Pre-tax withdrawal tax rate",
        "percent",
        "%",
        22,
      ],
      [
        "rothConversionAnnualAmount",
        "Annual Roth conversion",
        "currency",
        "per year (manual strategy only)",
        0,
      ],
      [
        "socialSecurityTaxablePercent",
        "Social Security taxable percentage",
        "percent",
        "%",
        85,
      ],
      ["rmdStartAge", "RMD start age", "number", "years", 73],
      [
        "niitThreshold",
        "Net investment income tax (NIIT) MAGI threshold",
        "currency",
        "per year",
        250000,
      ],
      [
        "cashReserveTargetYears",
        "Cash Reserve (Years of Spending)",
        "number",
        "years of spending",
        1,
      ],
      [
        "irmaaIncomeThreshold",
        "IRMAA income threshold",
        "currency",
        "per year",
        200000,
      ],
      [
        "irmaaAnnualSurcharge",
        "Annual IRMAA surcharge",
        "currency",
        "per year",
        0,
      ],
    ],
    // Rendered on the Timeline page: lets users override the model-generated Roth conversion
    // strategy, and choose whether Social Security uses the claim age set on Plan Setup or a
    // model-recommended claim age, without duplicating fields already on the Profile page.
    strategy: [
      [
        "socialSecurityStrategy",
        "Social Security claim strategy",
        "select",
        "",
        "manual",
        [
          ["manual", "Use claim age from Plan Setup"],
          ["auto", "Model-recommended claiming age"],
        ],
      ],
      [
        "rothConversionStrategy",
        "Roth conversion strategy",
        "select",
        "",
        "auto",
        [
          ["auto", "Model-recommended conversions"],
          ["manual", "Manual annual amount"],
        ],
      ],
    ],
    income: [
      ["annualSalary", "Annual salary", "currency", "per year", 150000],
      ["otherAnnualIncome", "Other annual income", "currency", "per year", 0],
    ],
    expenses: [
      [
        "currentAnnualExpenses",
        "Current annual expenses",
        "currency",
        "per year",
        85000,
      ],
      [
        "retirementAnnualSpendingGoal",
        "Retirement spending goal",
        "currency",
        "per year",
        75000,
      ],
    ],
    // Grouped into Employer-Sponsored, IRA Contributions, and Additional Savings so the
    // fixed-dollar IRA fields are not confused with the percentage-of-income contribution rates.
    contributionsEmployer: [
      [
        "contributionRates.fourOhOneK",
        "Employee 401(k) contribution",
        "percent",
        "% of salary",
        10,
      ],
      [
        "employerMatch.rate",
        "Employer match rate",
        "percent",
        "% of employee 401(k) contribution",
        50,
      ],
      [
        "employerMatch.salaryCap",
        "Employer match cap",
        "percent",
        "% of salary",
        3,
      ],
    ],
    contributionsIra: [
      [
        "iraContributions.traditionalIraAnnual",
        "Traditional IRA annual contribution",
        "currency",
        "per year, pre-tax",
        3000,
      ],
      [
        "iraContributions.rothIraAnnual",
        "Roth IRA annual contribution",
        "currency",
        "per year, after-tax",
        6000,
      ],
    ],
    contributionsAdditional: [
      [
        "savingsAllocation.brokerage",
        "Brokerage Allocation %",
        "percent",
        "% of Additional Annual Savings",
        75,
      ],
      [
        "savingsAllocation.cash",
        "Cash Allocation %",
        "percent",
        "% of Additional Annual Savings",
        25,
      ],
    ],
  };
}

// Contextual help shown via the Readiness-page metric-help pattern for Plan Setup fields
// that are commonly misunderstood. Keyed by field key; omitted fields get no info icon.
const PLAN_SETUP_FIELD_HELP = {
  safeWithdrawalRate: {
    title: "Safe Withdrawal Rate",
    text: "The percentage of your retirement portfolio that can be withdrawn annually to help support retirement spending. Higher rates require fewer assets but may increase the risk of running out of money later in retirement.",
  },
  socialSecurityAnnualBenefit: {
    title: "Social Security Annual Benefit",
    text: "Annual Social Security benefit at Full Retirement Age (67). If Automatic Estimate is selected, WealthMap estimates this value from your earnings. Claim Age adjustments are applied separately.",
  },
  socialSecurityClaimAge: {
    title: "Social Security Claim Age",
    text: "The age at which Social Security benefits begin. Claiming earlier reduces benefits. Claiming later increases benefits.",
  },
  expectedAnnualReturn: {
    title: "Expected Annual Return",
    text: "Expected long-term annual portfolio growth before inflation. WealthMap converts this assumption into a real return using your inflation rate.",
  },
  inflationRate: {
    title: "Inflation Rate",
    text: "Expected annual increase in the cost of living. WealthMap uses this assumption to express projections in today's purchasing power.",
  },
  retirementAnnualSpendingGoal: {
    title: "Retirement Spending Goal",
    text: "Target annual spending during retirement expressed in today's dollars. This value is used throughout readiness, timeline, and retirement asset calculations.",
  },
  "iraContributions.traditionalIraAnnual": {
    title: "Traditional IRA Annual Contribution",
    text: "Annual contribution to a Traditional IRA. Contributions are treated as pre-tax retirement savings in the model.",
  },
  "iraContributions.rothIraAnnual": {
    title: "Roth IRA Annual Contribution",
    text: "Annual contribution to a Roth IRA. Contributions are made with after-tax dollars and can grow tax-free in the model.",
  },
  "savingsAllocation.brokerage": {
    title: "Brokerage Allocation %",
    text: "Percentage of Additional Annual Savings allocated to a taxable brokerage account.",
  },
  "savingsAllocation.cash": {
    title: "Cash Allocation %",
    text: "Percentage of Additional Annual Savings allocated to cash reserves.",
  },
  cashReserveTargetYears: {
    title: "Cash Reserve (Years of Spending)",
    text: "Sets how many years of retirement spending the model aims to keep in cash. In positive-return years, available brokerage assets may be moved to cash to refill this reserve, helping reduce the need to sell investments during market declines.",
  },
  preTaxWithdrawalTaxRate: {
    title: "Pre-Tax Withdrawal Tax Rate",
    text: "Estimated tax rate applied to future withdrawals from tax-deferred retirement accounts such as 401(k)s and Traditional IRAs.",
  },
  rmdStartAge: {
    title: "RMD Start Age",
    text: "Age at which Required Minimum Distributions (RMDs) begin from eligible tax-deferred retirement accounts.",
  },
  taxableGainsTaxRate: {
    title: "Taxable Gains Tax Rate",
    text: "Estimated tax rate applied to investment gains generated within taxable brokerage accounts.",
  },
  irmaaIncomeThreshold: {
    title: "IRMAA Income Threshold",
    text: "Income level above which Medicare income-related monthly adjustment amounts (IRMAA) may apply.",
  },
  irmaaAnnualSurcharge: {
    title: "Annual IRMAA Surcharge",
    text: "Estimated annual Medicare surcharge applied when income exceeds the IRMAA threshold.",
  },
  rothConversionAnnualAmount: {
    title: "Annual Roth Conversion",
    text: "Annual amount converted from tax-deferred retirement accounts into Roth accounts when using the manual Roth conversion strategy.",
  },
};

function createField(config) {
  const [key, label, type, unit, fallback, options] = config;
  const value = key
    .split(".")
    .reduce((currentValue, path) => currentValue?.[path], workingProfile);
  const fieldId = `field-${key}`;
  const wrapper = document.createElement("div");
  wrapper.className = "field";
  wrapper.id = `wrapper-${key}`;
  wrapper.dataset.fieldWrapper = key;
  const labelEl = document.createElement("label");
  labelEl.htmlFor = fieldId;
  labelEl.textContent = label;
  let labelRow = labelEl;
  const fieldHelp = PLAN_SETUP_FIELD_HELP[key];
  if (fieldHelp) {
    const helpSlug = key
      .replace(/\./g, "-")
      .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
      .toLowerCase();
    labelRow = document.createElement("div");
    labelRow.className = "field-label-row has-help";
    const helpButton = document.createElement("button");
    helpButton.type = "button";
    helpButton.className = "info-button metric-help-button";
    helpButton.id = `${helpSlug}-help-button`;
    helpButton.dataset.helpTarget = `${helpSlug}-help`;
    helpButton.setAttribute("aria-expanded", "false");
    helpButton.setAttribute("aria-controls", `${helpSlug}-help`);
    helpButton.setAttribute("aria-label", `About ${fieldHelp.title}`);
    helpButton.textContent = "i";
    const helpPanel = document.createElement("div");
    helpPanel.className = "metric-help";
    helpPanel.id = `${helpSlug}-help`;
    helpPanel.setAttribute("role", "tooltip");
    helpPanel.dataset.helpButtonId = helpButton.id;
    helpPanel.hidden = true;
    helpPanel.innerHTML = `<strong>${fieldHelp.title}</strong><p>${fieldHelp.text}</p>`;
    labelRow.append(labelEl, helpButton, helpPanel);
  }
  const control =
    type === "select"
      ? document.createElement("select")
      : document.createElement("input");
  control.id = fieldId;
  control.dataset.field = key;
  control.dataset.type = type;
  const messageEl = document.createElement("div");
  messageEl.className = "field-message";
  messageEl.id = `${fieldId}-message`;
  messageEl.setAttribute("aria-live", "polite");
  if (type === "select") {
    const normalizedOptions = options.map((option) =>
      Array.isArray(option) ? option : [option, option],
    );
    normalizedOptions.forEach(([optionValue, optionLabel]) => {
      const optionEl = document.createElement("option");
      optionEl.value = optionValue;
      optionEl.textContent = optionLabel;
      control.append(optionEl);
    });
    control.value = value ?? fallback;
  } else if (type === "readonly") {
    control.type = "text";
    control.readOnly = true;
    control.setAttribute("aria-readonly", "true");
    if (key === "socialSecurityEstimatedBenefit") {
      control.value = money(estimatedSocialSecurityFraBenefit(workingProfile));
    } else {
      control.value = value ?? fallback;
    }
  } else {
    control.type = type === "percent" ? "number" : type;
    if (type === "currency" || type === "number" || type === "percent") {
      control.min = type === "percent" ? "0" : "0";
      if (type === "percent") control.max = "100";
      control.step =
        type === "percent" ? "0.1" : type === "currency" ? "100" : "1";
      control.inputMode = "decimal";
    }
    if (key === "socialSecurityClaimAge") {
      control.min = "62";
      control.max = "70";
    }
    control.value =
      type === "percent"
        ? roundTo(numberValue(value) * 100, 4)
        : (value ?? fallback);
  }
  control.setAttribute("aria-invalid", "false");
  control.setAttribute("aria-describedby", messageEl.id);
  const unitEl = document.createElement("small");
  unitEl.textContent = unit || "Edit to recalculate";
  wrapper.append(labelRow, control, unitEl, messageEl);

  if (key === "socialSecurityEstimatedBenefit") {
    const isAuto =
      (workingProfile.socialSecurityBenefitMode || "auto") === "auto";
    wrapper.hidden = !isAuto;
    wrapper.style.display = isAuto ? "" : "none";
  } else if (key === "socialSecurityAnnualBenefit") {
    const isAuto =
      (workingProfile.socialSecurityBenefitMode || "auto") === "auto";
    wrapper.hidden = isAuto;
    wrapper.style.display = isAuto ? "none" : "";
  }

  return wrapper;
}

function updateSocialSecurityBenefitFieldVisibility() {
  const isAuto =
    (workingProfile.socialSecurityBenefitMode || "auto") === "auto";
  const estimatedWrapper =
    document.getElementById("wrapper-socialSecurityEstimatedBenefit") ||
    document
      .querySelector('[data-field="socialSecurityEstimatedBenefit"]')
      ?.closest(".field");
  const manualWrapper =
    document.getElementById("wrapper-socialSecurityAnnualBenefit") ||
    document
      .querySelector('[data-field="socialSecurityAnnualBenefit"]')
      ?.closest(".field");

  if (estimatedWrapper) {
    estimatedWrapper.hidden = !isAuto;
    estimatedWrapper.style.display = isAuto ? "" : "none";
  }
  if (manualWrapper) {
    manualWrapper.hidden = isAuto;
    manualWrapper.style.display = isAuto ? "none" : "";
  }
}

function fieldValidationMessage(field, state) {
  const entries = [
    ...(state.blockingErrors || []),
    ...(state.warnings || []),
  ].filter((entry) => entry.field === field);
  if (!entries.length) return "";
  const blocking = entries.find((entry) => entry.level === "error");
  const selected = blocking || entries[0];
  const kind = selected.level === "warning" ? "warning" : "error";
  return { message: selected.message, kind };
}

function renderValidationMessages(state = currentValidationState) {
  const note = document.getElementById("plan-setup-validation-note");
  if (note) {
    note.hidden = state.isValid;
  }

  document.querySelectorAll("[data-field]").forEach((input) => {
    const field = input.dataset.field;
    const wrapper =
      input.closest(".field") ||
      input.closest(".asset-row") ||
      input.closest(".inline-field");
    const messageEl = wrapper ? wrapper.querySelector(".field-message") : null;
    const validation = fieldValidationMessage(field, state);
    const isInvalid = Boolean(validation && validation.kind === "error");
    const isWarning = Boolean(validation && validation.kind === "warning");
    input.setAttribute("aria-invalid", String(isInvalid));
    if (wrapper) {
      wrapper.classList.toggle("invalid", isInvalid);
      wrapper.classList.toggle("warning", isWarning && !isInvalid);
      wrapper.classList.toggle("field-warning", isWarning && !isInvalid);
      wrapper.classList.toggle("field-invalid", isInvalid);
    }
    if (messageEl) {
      messageEl.textContent = validation ? validation.message : "";
      messageEl.classList.toggle(
        "warning",
        validation ? validation.kind === "warning" : false,
      );
      messageEl.parentElement?.classList.toggle("invalid", isInvalid);
    }
  });

  document.querySelectorAll(".field-message").forEach((messageEl) => {
    const field = messageEl.closest(".field")?.querySelector("[data-field]")
      ?.dataset.field;
    if (!field) return;
    const validation = fieldValidationMessage(field, state);
    if (!validation) {
      messageEl.textContent = "";
      messageEl.style.display = "none";
    } else {
      messageEl.textContent = validation.message;
      messageEl.style.display = "block";
      messageEl.classList.toggle("warning", validation.kind === "warning");
    }
  });
}

function renderFormFields() {
  const config = inputConfig();
  [
    ["#profile-fields", config.profile],
    ["#assumption-fields", config.assumptions],
    ["#basic-tax-fields", config.basicTax],
    ["#advanced-tax-fields", config.advancedTax],
    ["#strategy-fields", config.strategy],
    ["#income-fields", config.income],
    ["#expense-fields", config.expenses],
    ["#contribution-fields-employer", config.contributionsEmployer],
    ["#contribution-fields-ira", config.contributionsIra],
    ["#contribution-fields-additional", config.contributionsAdditional],
  ].forEach(([selector, fields]) => {
    const container = $(selector);
    if (!container) return;
    container.replaceChildren(...fields.map(createField));
  });
  updateSocialSecurityBenefitFieldVisibility();
}

function renderAssetFields() {
  const container = $("#asset-fields");
  const groups = [
    {
      label: "Liquid assets",
      tooltipId: "liquid-assets-help",
      tooltipTitle: "Liquid Assets",
      tooltipText:
        "Cash available for reserves and retirement spending. WealthMap uses cash as the first withdrawal source during retirement.",
      keys: ["cash"],
    },
    {
      label: "Taxable assets",
      tooltipId: "taxable-assets-help",
      tooltipTitle: "Taxable Assets",
      tooltipText:
        "Investment accounts that may generate taxable gains and investment income. WealthMap models applicable taxes on brokerage growth.",
      keys: ["brokerage"],
    },
    {
      label: "Tax-deferred retirement assets",
      tooltipId: "tax-deferred-assets-help",
      tooltipTitle: "Tax-Deferred Retirement Assets",
      tooltipText:
        "Includes 401(k) and Traditional IRA balances. WealthMap models these accounts together for retirement withdrawals, Roth conversions, future taxes, and required minimum distributions.",
      keys: ["fourOhOneK", "traditionalIra"],
    },
    {
      label: "Tax-free retirement assets",
      tooltipId: "tax-free-assets-help",
      tooltipTitle: "Tax-Free Retirement Assets",
      tooltipText:
        "Roth assets that are modeled as growing and being withdrawn tax-free, providing greater tax flexibility during retirement.",
      keys: ["rothIra"],
    },
  ];
  const sections = groups.map((group) => {
    const section = document.createElement("section");
    section.className = "asset-group";
    const helpButtonId = `${group.tooltipId}-button`;
    section.innerHTML = `<div class="asset-group-heading"><div class="metric-label-row has-help"><h3>${group.label}</h3><button class="info-button metric-help-button" id="${helpButtonId}" type="button" data-help-target="${group.tooltipId}" aria-expanded="false" aria-controls="${group.tooltipId}" aria-label="About ${group.tooltipTitle}">i</button><div class="metric-help" id="${group.tooltipId}" role="tooltip" data-help-button-id="${helpButtonId}" hidden><strong>${group.tooltipTitle}</strong><p>${group.tooltipText}</p></div></div></div>`;
    const rows = group.keys.map((key) => {
      const metadata = ASSET_METADATA[key];
      const row = document.createElement("div");
      row.className = "asset-row";
      row.innerHTML = `<div class="asset-label"><span>${metadata.label}</span><small>${metadata.interpretation}</small></div><span class="tax-tag">${metadata.treatment}</span><input data-field="assets.${key}" data-type="currency" type="number" min="0" step="1000" value="${workingProfile.assets[key]}" aria-label="${metadata.label} balance" /><div class="field-message" aria-live="polite"></div>`;
      return row;
    });
    section.append(...rows);
    return section;
  });
  container.replaceChildren(...sections);
  $("#realEstate").value = workingProfile.assets.realEstate;
  $("#realEstate").dataset.type = "currency";
  $("#realEstate").setAttribute("aria-invalid", "false");
  $("#realEstate").setAttribute(
    "aria-describedby",
    "field-assets.realEstate-message",
  );
}

function renderSocialSecuritySchedule(ssPlan) {
  const body = $("#ss-claiming-table-body");
  if (!body) return;
  const schedule = socialSecurityClaimingSchedule(ssPlan.fraBenefit);
  body.innerHTML = schedule
    .map((row) => {
      const classes = [];
      if (row.claimAge === SOCIAL_SECURITY_FULL_RETIREMENT_AGE)
        classes.push("ss-fra-row");
      if (row.claimAge === ssPlan.claimAge) classes.push("ss-recommended-row");
      return `<tr class="${classes.join(" ")}"><td>${row.claimAge}${row.claimAge === ssPlan.claimAge ? " ★" : ""}</td><td>${money(row.annualBenefit)}</td><td>${money(row.annualBenefit / 12)}</td></tr>`;
    })
    .join("");
}

function recommendations(metrics, profile) {
  const items = [];
  if (metrics.timelineDepletionAge != null)
    items.push({
      priority: "HIGH PRIORITY",
      className: "",
      title: "Address a projected shortfall year",
      trigger: `The year-by-year timeline projects assets reaching $0 at age ${metrics.timelineDepletionAge}, before life expectancy.`,
      metric: `Depletes at age ${metrics.timelineDepletionAge}`,
      action:
        "Open the Timeline page to see which years drive the shortfall and adjust spending, returns, or retirement age.",
      effect:
        "Calculated from the year-by-year timeline, including any per-year overrides.",
    });
  if (metrics.savingsRate < 0.2)
    items.push({
      priority: "HIGH PRIORITY",
      className: "",
      title: "Increase annual savings",
      trigger: "Savings rate is below the 20% target threshold.",
      metric: `${percent(metrics.savingsRate)} savings rate`,
      action: "Consider increasing the annual savings input.",
      effect: "Qualitative; may reduce the projected funding gap.",
    });
  if (metrics.fundingDelta > 0)
    items.push({
      priority: "MEDIUM PRIORITY",
      className: "medium",
      title: "Review retirement timing",
      trigger: "Projected assets do not fully cover the retirement target.",
      metric: `${money(metrics.fundingDelta)} funding gap`,
      action: "Compare a later retirement age or a higher savings amount.",
      effect: "Qualitative; scenario effects update when inputs change.",
    });
  if (profile.retirementAnnualSpendingGoal > metrics.safeSpending)
    items.push({
      priority: "MEDIUM PRIORITY",
      className: "medium",
      title: "Review retirement spending goal",
      trigger: "The spending goal is above the current safe-spending estimate.",
      metric: `${money(profile.retirementAnnualSpendingGoal)} annual goal`,
      action: "Compare a lower spending scenario.",
      effect: "Qualitative; may improve readiness.",
    });
  const taxDeferred = profile.assets.fourOhOneK + profile.assets.traditionalIra;
  if (taxDeferred > metrics.financialAssets * 0.5)
    items.push({
      priority: "INFORMATIONAL",
      className: "info",
      title: "Review tax diversification",
      trigger: "Most investable assets are tax-deferred.",
      metric: `${percent(taxDeferred / metrics.financialAssets)} tax-deferred share`,
      action: "Learn about future account withdrawal sequencing.",
      effect: "General guidance; not a calculated projection.",
    });
  if (metrics.timelineIrmaaAge != null)
    items.push({
      priority: "INFORMATIONAL",
      className: "info",
      title: "Watch for an IRMAA surcharge year",
      trigger: `The timeline projects Medicare income-related surcharges starting at age ${metrics.timelineIrmaaAge}.`,
      metric: `First IRMAA year: age ${metrics.timelineIrmaaAge}`,
      action:
        "Review projected RMD and Social Security timing on the Timeline page.",
      effect: "Calculated from your year-by-year timeline.",
    });
  return items.slice(0, 3);
}

function renderRecommendations(metrics) {
  const items = recommendations(metrics, workingProfile);
  $("#recommendation-count").textContent =
    `${items.length} action${items.length === 1 ? "" : "s"}`;
  const list = $("#recommendation-list");
  if (!items.length) {
    list.innerHTML =
      '<div class="panel" style="padding:24px"><strong>Your current inputs do not trigger a recommendation.</strong><p>Continue reviewing your assumptions as your plan changes.</p></div>';
    return;
  }
  list.innerHTML = items
    .map(
      (item, index) =>
        `<article class="recommendation-card"><div class="recommendation-number">${String(index + 1).padStart(2, "0")}</div><div><h3>${item.title}</h3><p><strong>Trigger:</strong> ${item.trigger}</p><p><strong>Current metric:</strong> ${item.metric}</p><p><strong>Suggested action:</strong> ${item.action}</p><p><strong>Effect:</strong> ${item.effect}</p></div><span class="priority ${item.className}">${item.priority}</span></article>`,
    )
    .join("");
}

function renderTimelineSummary(rows) {
  const summary = timelineSummary(rows, workingProfile);
  $("#timeline-final-assets").textContent = money(summary.finalAssets);
  $("#timeline-depletion-age").textContent = summary.depletionAge
    ? `Age ${summary.depletionAge}`
    : "Not projected to deplete";
  $("#timeline-overridden-count").textContent = String(summary.overriddenYears);
}

function buildTimelineMilestones(rows, profile, ssPlan) {
  if (!rows.length) return [];

  const summary = timelineSummary(rows, profile);
  const byAge = new Map();
  const addMilestone = (age, label, description) => {
    if (!Number.isFinite(age)) return;
    const current = byAge.get(age) || { age, labels: [], description: [] };
    if (!current.labels.includes(label)) current.labels.push(label);
    if (description && !current.description.includes(description))
      current.description.push(description);
    byAge.set(age, current);
  };

  const retirementRow = rows.find((row) => row.isRetired);
  if (retirementRow) {
    addMilestone(
      retirementRow.age,
      "Retirement begins",
      `Retirement begins in the modeled plan at age ${retirementRow.age}.`,
    );
  }

  if (ssPlan && ssPlan.fraBenefit > 0) {
    const socialSecurityRow = rows.find(
      (row) => row.isRetired && row.socialSecurityGrossBenefit > 0,
    );
    if (socialSecurityRow) {
      addMilestone(
        socialSecurityRow.age,
        "Social Security begins",
        `Social Security begins at age ${socialSecurityRow.age} (${ssPlan.source === "auto" ? "model-recommended" : "manual"} claiming age): ${money(ssPlan.annualBenefit)}/year.`,
      );
    }
  }

  const conversionRows = rows.filter((row) => row.rothConversion > 0);
  if (conversionRows.length) {
    const firstAge = conversionRows[0].age;
    const lastAge = conversionRows[conversionRows.length - 1].age;
    addMilestone(
      firstAge,
      "Roth conversions begin",
      `Model-generated Roth conversions begin at age ${firstAge}.`,
    );
    if (lastAge !== firstAge) {
      addMilestone(
        lastAge,
        "Roth conversions end",
        `Modeled Roth conversions end at age ${lastAge}, ahead of RMDs.`,
      );
    }
  }

  const firstRmdRow = rows.find((row) => row.isRetired && row.rmd > 0);
  if (firstRmdRow) {
    addMilestone(
      firstRmdRow.age,
      "First RMD",
      `Required minimum distributions begin at age ${firstRmdRow.age}.`,
    );
  }

  const firstIrmaaRow = rows.find((row) => row.isRetired && row.irmaa > 0);
  if (firstIrmaaRow) {
    addMilestone(
      firstIrmaaRow.age,
      "First IRMAA year",
      `A Medicare surcharge is projected starting at age ${firstIrmaaRow.age}.`,
    );
  }

  const transitionRow = rows.find((row) => {
    if (!row.isRetired || !row.withdrawalSources) return false;
    const { cash, brokerage, preTax, roth } = row.withdrawalSources;
    return preTax + roth > 0 && preTax + roth > cash + brokerage;
  });
  if (transitionRow) {
    addMilestone(
      transitionRow.age,
      "Withdrawal source shifts",
      `Modeled spending begins relying primarily on tax-deferred or Roth withdrawals at age ${transitionRow.age}.`,
    );
  }

  const peakRow = rows.reduce((best, row) =>
    row.endTotal > best.endTotal ? row : best,
  );
  addMilestone(
    peakRow.age,
    "Peak portfolio value",
    `The portfolio reaches its projected peak around age ${peakRow.age}.`,
  );

  if (summary.depletionAge != null) {
    addMilestone(
      summary.depletionAge,
      "Portfolio depletion",
      `The plan is projected to run out of invested assets at age ${summary.depletionAge}.`,
    );
  }

  const rowsByAge = new Map(rows.map((row) => [row.age, row]));
  return [...byAge.values()]
    .map((milestone) => ({
      ...milestone,
      label: milestone.labels.join(" • "),
      detail: milestone.description[0] || "Modeled retirement transition.",
      projectedValue: rowsByAge.get(milestone.age)?.endTotal ?? null,
    }))
    .sort((a, b) => a.age - b.age)
    .slice(0, 8);
}

function renderTimelineMilestones(rows, profile, ssPlan) {
  const container = $("#timeline-milestones");
  if (!container) return;
  const milestones = buildTimelineMilestones(rows, profile, ssPlan);
  if (!milestones.length) {
    container.innerHTML =
      '<div class="milestone"><span>Milestones</span><p>Enter a valid plan to see the major retirement milestones.</p></div>';
    return;
  }

  container.innerHTML = milestones
    .map(
      (milestone) => `
        <div class="milestone">
          <span>Age ${milestone.age}</span>
          <strong>${milestone.label}</strong>
          <p>${milestone.detail}</p>
          ${milestone.projectedValue != null ? `<p class="milestone-value">Projected financial assets: ${money(milestone.projectedValue)}</p>` : ""}
        </div>
      `,
    )
    .join("");
}

const COMPOSITION_CATEGORIES = [
  { key: "cash", label: "Cash reserves", color: "var(--lime)" },
  { key: "brokerage", label: "Taxable brokerage", color: "var(--blue)" },
  {
    key: "preTax",
    label: "Tax-deferred (401(k) & Traditional IRA)",
    color: "var(--coral)",
  },
  { key: "roth", label: "Roth (tax-free)", color: "var(--teal)" },
];

function compositionShare(value, total) {
  return total > 0 ? percent(value / total) : "0.0%";
}

function compositionPlanningNote(row) {
  const total = row.endTotal;
  if (total <= 0) return "No modeled financial assets remain at this age.";
  const preTaxShare = (row.endBalances.preTax || 0) / total;
  const cashShare = (row.endBalances.cash || 0) / total;
  if (row.rmd > 0)
    return `RMD exposure is active: ${money(row.rmd)} modeled this year from tax-deferred assets.`;
  if (preTaxShare > 0.5)
    return "Tax-deferred assets are the majority; future withdrawals may increase taxable income.";
  if (cashShare < 0.05)
    return "Cash is a small share of the portfolio; review liquidity for near-term spending.";
  return "The mix shows taxable, tax-deferred, Roth, and liquid sources for future withdrawals.";
}

function compositionMilestoneRows(rows) {
  const selected = [];
  const add = (row, label) => {
    if (row && !selected.some((item) => item.row.age === row.age))
      selected.push({ row, label });
  };
  add(rows[0], "Current modeled year");
  add(
    rows.find((row) => row.isRetired),
    "Retirement begins",
  );
  add(
    rows.find((row) => row.rmd > 0),
    "First RMD year",
  );
  add(rows[rows.length - 1], "Life expectancy");
  return selected;
}

function renderPortfolioComposition(rows) {
  const container = $("#timeline-composition");
  if (!container) return;
  if (!rows.length) {
    container.innerHTML =
      '<p class="notice-panel">Enter a valid current age and life expectancy to see portfolio composition.</p>';
    return;
  }

  container.innerHTML = compositionMilestoneRows(rows)
    .map(({ row, label }) => {
      const total = row.endTotal;
      const buckets = COMPOSITION_CATEGORIES.map((category) => {
        const value = Math.max(0, row.endBalances[category.key] || 0);
        return `<div class="composition-bucket"><span><i class="legend-swatch" style="background:${category.color}"></i>${category.label}</span><strong>${money(value)}</strong><small>${compositionShare(value, total)}</small></div>`;
      }).join("");
      return `<article class="composition-snapshot"><span class="composition-age">Age ${row.age}</span><h3>${label}</h3><p class="composition-total">${money(total)} financial assets</p><div class="composition-buckets">${buckets}</div><p class="composition-note">${compositionPlanningNote(row)}</p></article>`;
    })
    .join("");
}

function timelineInputCell(age, field, value, defaultValue, disabled, type) {
  const displayDefault =
    type === "percent"
      ? Number(defaultValue ?? 0).toFixed(1)
      : Math.round(numberValue(defaultValue));
  const rawValue = value != null ? value : "";
  return `<input type="number" step="${type === "percent" ? "0.1" : "100"}" inputmode="decimal" data-timeline-age="${age}" data-timeline-field="${field}" placeholder="${displayDefault}" value="${rawValue}" ${disabled ? "disabled" : ""} aria-label="${field} override for age ${age}" />`;
}

function withdrawalSourceSummary(sources) {
  if (!sources) return "";
  const parts = [];
  if (sources.cash > 0) parts.push(`Cash ${money(sources.cash)}`);
  if (sources.brokerage > 0)
    parts.push(`Brokerage ${money(sources.brokerage)}`);
  if (sources.preTax > 0) parts.push(`401(k)/IRA ${money(sources.preTax)}`);
  if (sources.roth > 0) parts.push(`Roth ${money(sources.roth)}`);
  return parts.join(" • ");
}

function contributionDetailsMarkup(row) {
  if (!row.contributionDetails) {
    return `<span class="contribution-total">${money(row.contribution)}</span>`;
  }
  const details = row.contributionDetails;
  return `<details class="contribution-details">
    <summary aria-label="View contribution breakdown for age ${row.age}">${money(row.contribution)}</summary>
    <div class="contribution-breakdown">
      <span><small>Employee 401(k)</small><strong data-contribution-value="employeeFourOhOneK">${money(details.employeeFourOhOneK)}</strong></span>
      <span><small>Employer 401(k) match</small><strong data-contribution-value="employerFourOhOneKMatch">${money(details.employerFourOhOneKMatch)}</strong></span>
      <span><small>Traditional IRA</small><strong data-contribution-value="traditionalIra">${money(details.traditionalIra)}</strong></span>
      <span><small>Roth IRA</small><strong data-contribution-value="rothIra">${money(details.rothIra)}</strong></span>
      <span><small>Taxable brokerage</small><strong data-contribution-value="brokerage">${money(details.brokerage)}</strong></span>
      <span><small>Cash reserve</small><strong data-contribution-value="cash">${money(details.cash)}</strong></span>
    </div>
  </details>`;
}

function withdrawalDetailsMarkup(row) {
  if (!row.isRetired) return "—";
  const sources = row.withdrawalSources || {};
  const sourceRows = [
    ["Cash", sources.cash],
    ["Brokerage", sources.brokerage],
    ["401(k)/IRA", sources.preTax],
    ["Roth", sources.roth],
  ]
    .filter(([, value]) => value > 0)
    .map(
      ([label, value]) =>
        `<span><small>${label}</small><strong>${money(value)}</strong></span>`,
    )
    .join("");
  const shortfall =
    row.unmetWithdrawalNeed > 0
      ? `<span class="withdrawal-shortfall"><small>⚠ Shortfall</small><strong>${money(row.unmetWithdrawalNeed)}</strong></span>`
      : "";
  return `<div class="withdrawal-details">
    ${sourceRows}
    <span class="withdrawal-total"><small>Total</small><strong>${money(row.actualWithdrawal)}</strong></span>
    ${shortfall}
  </div>`;
}

function timelineRowMarkup(row) {
  const override = row.overrides;
  const taxesTotal =
    row.niit + row.socialSecurityTax + row.irmaa + row.rothConversionTax;
  const extraField = row.isRetired ? "extraWithdrawal" : "extraCashNeed";
  const extraDefault = row.isRetired ? row.extraWithdrawal : row.extraCashNeed;
  return `<tr data-timeline-row="${row.age}" class="${row.hasOverride ? "has-override" : ""}">
    <td>${row.age}<span class="timeline-status">${row.isRetired ? "Retired" : "Working"}</span></td>
    <td>${timelineInputCell(row.age, "returnPercent", override.returnPercent, row.defaultReturnPercent, false, "percent")}</td>
    <td>${timelineInputCell(row.age, "income", override.income, row.isRetired ? row.income : row.defaultIncome, row.isRetired, "currency")}</td>
    <td data-col="socialSecurity">${row.socialSecurityGrossBenefit > 0 ? money(row.socialSecurityGrossBenefit) : "—"}</td>
    <td data-col="rothConversion" class="${row.rothConversion > 0 ? "model-generated" : ""}">${row.rothConversion > 0 ? money(row.rothConversion) : "—"}</td>
    <td>${timelineInputCell(row.age, "expenses", override.expenses, row.defaultExpenses, false, "currency")}</td>
    <td>${timelineInputCell(row.age, extraField, override[extraField], extraDefault, false, "currency")}</td>
    <td data-col="contribution">${contributionDetailsMarkup(row)}</td>
    <td data-col="withdrawal" title="${withdrawalSourceSummary(row.withdrawalSources)}">${withdrawalDetailsMarkup(row)}</td>
    <td data-col="rmd">${row.rmd > 0 ? money(row.rmd) : "—"}</td>
    <td data-col="taxes">${taxesTotal > 0 ? money(taxesTotal) : "—"}</td>
    <td data-col="netCashFlow">${money(row.netCashFlow)}</td>
    <td data-col="endTotal" class="timeline-total">${money(row.endTotal)}</td>
    <td><button type="button" class="button button-quiet timeline-clear" data-timeline-clear="${row.age}" ${row.hasOverride ? "" : "disabled"}>Clear</button></td>
  </tr>`;
}

function renderTimelineTable(rows) {
  const body = $("#timeline-table-body");
  if (!rows.length) {
    body.innerHTML =
      '<tr><td colspan="14">Enter a valid current age and life expectancy to build a timeline.</td></tr>';
    return;
  }
  body.innerHTML = rows.map(timelineRowMarkup).join("");
}

function updateTimelineComputedCells(rows) {
  rows.forEach((row) => {
    const tr = document.querySelector(`[data-timeline-row="${row.age}"]`);
    if (!tr) return;
    tr.classList.toggle("has-override", row.hasOverride);
    const taxesTotal =
      row.niit + row.socialSecurityTax + row.irmaa + row.rothConversionTax;
    tr.querySelector('[data-col="socialSecurity"]').textContent =
      row.socialSecurityGrossBenefit > 0
        ? money(row.socialSecurityGrossBenefit)
        : "—";
    const conversionCell = tr.querySelector('[data-col="rothConversion"]');
    conversionCell.textContent =
      row.rothConversion > 0 ? money(row.rothConversion) : "—";
    conversionCell.classList.toggle("model-generated", row.rothConversion > 0);
    const contributionCell = tr.querySelector('[data-col="contribution"]');
    const contributionSummary = contributionCell?.querySelector("summary");
    const contributionTotal = contributionCell?.querySelector(".contribution-total");
    if (contributionSummary) {
      contributionSummary.textContent = money(row.contribution);
    } else if (contributionTotal) {
      contributionTotal.textContent = money(row.contribution);
    }
    if (row.contributionDetails) {
      contributionCell?.querySelectorAll("[data-contribution-value]").forEach((value) => {
        const field = value.dataset.contributionValue;
        value.textContent = money(row.contributionDetails[field]);
      });
    }
    const withdrawalCell = tr.querySelector('[data-col="withdrawal"]');
    if (row.isRetired) {
      withdrawalCell.innerHTML = withdrawalDetailsMarkup(row);
    } else {
      withdrawalCell.textContent = "—";
    }
    withdrawalCell.title = withdrawalSourceSummary(row.withdrawalSources);
    tr.querySelector('[data-col="rmd"]').textContent =
      row.rmd > 0 ? money(row.rmd) : "—";
    tr.querySelector('[data-col="taxes"]').textContent =
      taxesTotal > 0 ? money(taxesTotal) : "—";
    tr.querySelector('[data-col="netCashFlow"]').textContent = money(
      row.netCashFlow,
    );
    tr.querySelector('[data-col="endTotal"]').textContent = money(row.endTotal);
    const clearButton = tr.querySelector(".timeline-clear");
    if (clearButton) clearButton.disabled = !row.hasOverride;
  });
}

function renderStrategySummary(ssPlan, profile, summary) {
  const container = $("#strategy-summary");
  if (!container) return;
  const ssText =
    ssPlan.fraBenefit > 0
      ? `${ssPlan.source === "auto" ? "Model-recommended" : "Manual"}: claim at age ${ssPlan.claimAge} for ${money(ssPlan.annualBenefit)}/year.`
      : "No Social Security benefit is modeled yet.";
  const conversionText =
    profile.rothConversionStrategy === "auto"
      ? summary.firstConversionAge != null
        ? `Model-recommended: convert from age ${summary.firstConversionAge} through age ${summary.lastConversionAge}, filling headroom below an illustrative 22% federal bracket (total ${money(summary.cumulativeRothConversion)}).`
        : "Model-recommended: no conversion window fits before RMDs begin under current assumptions."
      : `Manual: ${money(numberValue(profile.rothConversionAnnualAmount))}/year every modeled year.`;
  container.innerHTML = `
    <div class="strategy-summary-item">
      <span class="has-help">Social Security<button class="info-button metric-help-button" id="ss-strategy-help-button" type="button" data-help-target="ss-strategy-help" aria-expanded="false" aria-controls="ss-strategy-help" aria-label="About the Social Security strategy">i</button>
        <div class="metric-help" id="ss-strategy-help" role="tooltip" data-help-button-id="ss-strategy-help-button" hidden>
          <p>Evaluated using your current plan assumptions. Select the manual strategy to use the claim age entered in Plan Setup.</p>
        </div>
      </span>
      <p>${ssText}</p>
    </div>
    <div class="strategy-summary-item">
      <span class="has-help">Roth conversions<button class="info-button metric-help-button" id="roth-strategy-help-button" type="button" data-help-target="roth-strategy-help" aria-expanded="false" aria-controls="roth-strategy-help" aria-label="About the Roth conversion strategy">i</button>
        <div class="metric-help" id="roth-strategy-help" role="tooltip" data-help-button-id="roth-strategy-help-button" hidden>
          <p>Uses your current assumptions to estimate available conversion opportunities. Actual tax results may differ.</p>
        </div>
      </span>
      <p>${conversionText}</p>
    </div>
  `;
}

function renderTimeline() {
  const { effectiveProfile, ssPlan } = resolveEffectiveProfile(workingProfile);
  const rows = buildTimelineRows(effectiveProfile);
  const summary = timelineSummary(rows, effectiveProfile);
  renderStrategySummary(ssPlan, effectiveProfile, summary);
  renderTimelineTable(rows);
  renderTimelineMilestones(rows, effectiveProfile, ssPlan);
  renderPortfolioComposition(rows);
  renderTimelineSummary(rows);
  return rows;
}

function handleTimelineTableInput(event) {
  const clearAge = event.target.dataset.timelineClear;
  if (clearAge !== undefined) {
    clearTimelineOverride(Number(clearAge));
    renderMetrics();
    return;
  }
  const age = event.target.dataset.timelineAge;
  const field = event.target.dataset.timelineField;
  if (age === undefined || !field) return;
  setTimelineOverride(Number(age), field, event.target.value);
  const { effectiveProfile, ssPlan } = resolveEffectiveProfile(workingProfile);
  const rows = buildTimelineRows(effectiveProfile);
  const summary = timelineSummary(rows, effectiveProfile);
  renderStrategySummary(ssPlan, effectiveProfile, summary);
  updateTimelineComputedCells(rows);
  renderTimelineMilestones(rows, effectiveProfile, ssPlan);
  renderPortfolioComposition(rows);
  renderTimelineSummary(rows);
}

function renderMetrics() {
  const validation =
    typeof PlanSetupValidation !== "undefined"
      ? PlanSetupValidation.validatePlanSetup(workingProfile)
      : { blockingErrors: [], warnings: [], isValid: true };
  currentValidationState = validation;

  if (!validation.isValid) {
    renderValidationMessages(validation);
    return lastValidProjection;
  }

  renderValidationMessages(validation);
  const metrics = calculate(workingProfile);
  lastValidProjection = metrics;
  setText("#sidebar-name", workingProfile.name || "Unnamed plan");
  setText(
    "#sidebar-timeline",
    `Age ${workingProfile.currentAge} → Retire ${workingProfile.targetRetirementAge}`,
  );
  setText("#score-value", metrics.score);
  setWidth("#score-bar", `${metrics.score}%`);
  setText("#score-status", metrics.status);
  setText("#readiness-status", metrics.status);
  const readinessStatus = $("#readiness-status");
  if (readinessStatus) {
    readinessStatus.className = `status-pill ${metrics.status === "On Track" ? "" : "neutral"}`;
  }
  setText("#target-age", workingProfile.targetRetirementAge);
  setText(
    "#expected-age",
    metrics.expectedRetirementAge ?? "Beyond life expectancy",
  );
  setText("#years-to-target", metrics.yearsToTarget);
  setText("#projected-assets", money(metrics.projectedAssets));
  setText(
    "#required-assets",
    Number.isFinite(metrics.requiredAssets)
      ? money(metrics.requiredAssets)
      : "Unavailable",
  );
  setText(
    "#funding-label",
    metrics.fundingDelta > 0 ? "Funding gap" : "Projected surplus",
  );
  setText("#funding-gap", money(Math.abs(metrics.fundingDelta)));
  setText("#safe-spending", money(metrics.safeSpending));
  setText("#spending-goal", money(workingProfile.retirementAnnualSpendingGoal));
  setText("#financial-assets-summary", money(metrics.financialAssets));
  setText("#total-assets-summary", money(metrics.totalAssets));
  setText("#financial-assets-total", money(metrics.financialAssets));
  setText("#total-assets", money(metrics.totalAssets));
  setText("#total-income", money(metrics.totalIncome));
  setText("#after-tax-income", money(metrics.afterTaxIncome));
  setText("#savings-rate", percent(metrics.savingsRate));
  setText(
    "#retirement-contributions",
    money(metrics.totalRetirementContributions),
  );
  setText(
    "#available-annual-savings-summary",
    money(metrics.availableAnnualSavings),
  );
  setText("#total-annual-savings", money(metrics.totalAnnualSavings));
  setText("#available-annual-savings", money(metrics.availableAnnualSavings));
  setText(
    "#brokerage-contribution-amount",
    money(metrics.brokerageContribution),
  );
  setText("#cash-contribution-amount", money(metrics.cashContribution));
  setText("#current-federal-tax", money(metrics.currentFederalTax));
  setText("#current-state-tax", money(metrics.currentStateTax));
  setText("#after-tax-assets", money(metrics.afterTaxAssets));
  setText("#projected-rmd", money(metrics.projectedRmd));
  setText("#projected-niit", money(metrics.projectedNiit));
  setText("#projected-ss-tax", money(metrics.projectedSocialSecurityTax));
  setText("#projected-irmaa", money(metrics.projectedIrmaa));
  setText(
    "#readiness-updated",
    `Updated ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`,
  );
  const estimatedSsInput = document.getElementById(
    "field-socialSecurityEstimatedBenefit",
  );
  if (estimatedSsInput) {
    estimatedSsInput.value = money(
      estimatedSocialSecurityFraBenefit(workingProfile),
    );
  }
  updateSocialSecurityBenefitFieldVisibility();
  renderRecommendations(metrics);
  renderSocialSecuritySchedule(metrics.socialSecurityPlan);
  renderTimeline();
  return metrics;
}

function updateWorkingValue(field, rawValue, type) {
  if (field === "socialSecurityBenefitMode") {
    workingProfile.socialSecurityBenefitMode = rawValue;
    updateSocialSecurityBenefitFieldVisibility();
    renderMetrics();
    return;
  }

  const path = field.split(".");
  const optionalBlankFields = new Set([
    "otherAnnualIncome",
    "rothConversionAnnualAmount",
    "socialSecurityAnnualBenefit",
    "irmaaAnnualSurcharge",
    "assets.realEstate",
    "iraContributions.traditionalIraAnnual",
    "iraContributions.rothIraAnnual",
  ]);

  const value =
    type === "percent"
      ? rawValue === "" && optionalBlankFields.has(field)
        ? 0
        : rawValue === ""
          ? null
          : roundTo(numberValue(rawValue) / 100, 6)
      : type === "number" || type === "currency"
        ? rawValue === "" && optionalBlankFields.has(field)
          ? 0
          : rawValue === ""
            ? null
            : numberValue(rawValue)
        : rawValue;

  const candidate = JSON.parse(JSON.stringify(workingProfile));
  if (path.length === 2) {
    if (!candidate[path[0]]) candidate[path[0]] = {};
    candidate[path[0]][path[1]] = value;
  } else {
    candidate[path[0]] = value;
  }

  const validation =
    typeof PlanSetupValidation !== "undefined"
      ? PlanSetupValidation.validatePlanSetup(candidate)
      : { blockingErrors: [], warnings: [], isValid: true };

  if (!validation.isValid) {
    renderValidationMessages(validation);
    return;
  }

  if (path.length === 2) workingProfile[path[0]][path[1]] = value;
  else workingProfile[path[0]] = value;
  renderMetrics();
}

function handleInput(event) {
  const field = event.target.dataset.field;
  if (!field) return;
  updateWorkingValue(field, event.target.value, event.target.dataset.type);
}

function showPage(page) {
  currentPage = pageTitles[page] ? page : "readiness";
  $$(".page-view").forEach((view) => {
    view.hidden = view.dataset.view !== currentPage;
  });
  $$(".nav-item").forEach((item) =>
    item.classList.toggle("active", item.dataset.page === currentPage),
  );
  const [breadcrumb, title] = pageTitles[currentPage];
  $("#breadcrumb").textContent = breadcrumb;
  $("#page-title").textContent = title;
  closeMenu();
}

function closeMenu() {
  $("#sidebar").classList.remove("open");
  $("#scrim").hidden = true;
}

function toggleAdvancedTaxSettings() {
  const button = $("#advanced-tax-toggle");
  const content = $("#advanced-tax-content");
  if (!button || !content) return;
  const isOpen = !content.hidden;
  content.hidden = isOpen;
  button.setAttribute("aria-expanded", String(!isOpen));
  // Save preference to session storage
  if (typeof sessionStorage !== "undefined") {
    sessionStorage.setItem("advancedTaxSettingsOpen", String(!isOpen));
  }
}

function restoreAdvancedTaxSettingsState() {
  const content = $("#advanced-tax-content");
  const button = $("#advanced-tax-toggle");
  if (!content || !button) return;
  const isOpen =
    typeof sessionStorage !== "undefined"
      ? sessionStorage.getItem("advancedTaxSettingsOpen") === "true"
      : false;
  content.hidden = !isOpen;
  button.setAttribute("aria-expanded", String(isOpen));
}

function closeScoreHelp() {
  const button = $("#score-help-button");
  const help = $("#score-help");
  if (!button || !help) return;
  help.hidden = true;
  button.setAttribute("aria-expanded", "false");
}

function closeMetricHelps() {
  document.querySelectorAll(".metric-help").forEach((help) => {
    help.hidden = true;
    const button = document.getElementById(help.dataset.helpButtonId);
    if (button) button.setAttribute("aria-expanded", "false");
  });
}

function toggleScoreHelp() {
  const button = $("#score-help-button");
  const help = $("#score-help");
  if (!button || !help) return;
  const isOpen = !help.hidden;
  help.hidden = isOpen;
  button.setAttribute("aria-expanded", String(!isOpen));
}

function toggleMetricHelp(button) {
  if (!button) return;
  const targetId = button.dataset.helpTarget;
  const help = targetId ? document.getElementById(targetId) : null;
  if (!help) return;
  const isOpen = !help.hidden;
  closeMetricHelps();
  help.hidden = isOpen;
  button.setAttribute("aria-expanded", String(!isOpen));
}

function resetSample() {
  workingProfile = cloneSampleProfile();
  lastValidProjection = null;
  currentValidationState = { blockingErrors: [], warnings: [], isValid: true };
  renderFormFields();
  renderAssetFields();
  restoreAdvancedTaxSettingsState();
  bindFieldListeners();
  renderValidationMessages(currentValidationState);
  renderMetrics();
}

function bindFieldListeners() {
  $$("[data-field]").forEach((input) => {
    input.removeEventListener("input", handleInput);
    input.addEventListener("input", handleInput);
    input.removeEventListener("change", handleInput);
    input.addEventListener("change", handleInput);
  });
}

function init() {
  renderFormFields();
  renderAssetFields();
  restoreAdvancedTaxSettingsState();
  renderValidationMessages(currentValidationState);
  renderMetrics();
  bindFieldListeners();
  $$(".nav-item").forEach((item) =>
    item.addEventListener("click", () => showPage(item.dataset.page)),
  );
  $("#reset-button").addEventListener("click", resetSample);
  $("#advanced-tax-toggle").addEventListener(
    "click",
    toggleAdvancedTaxSettings,
  );
  $("#timeline-reset-button").addEventListener("click", () => {
    clearAllTimelineOverrides();
    renderMetrics();
  });
  $("#timeline-table-body").addEventListener("input", handleTimelineTableInput);
  $("#timeline-table-body").addEventListener("click", handleTimelineTableInput);
  $("#open-menu").addEventListener("click", () => {
    $("#sidebar").classList.add("open");
    $("#scrim").hidden = false;
  });
  $("#close-menu").addEventListener("click", closeMenu);
  $("#scrim").addEventListener("click", closeMenu);
  $("#score-help-button").addEventListener("click", (event) => {
    event.stopPropagation();
    closeMetricHelps();
    toggleScoreHelp();
  });
  $("#score-help").addEventListener("click", (event) =>
    event.stopPropagation(),
  );
  // Delegated so tooltip buttons rendered later (e.g. the Timeline strategy summary) work too.
  document.addEventListener("click", (event) => {
    const button = event.target.closest(".metric-help-button");
    if (button) {
      event.stopPropagation();
      closeScoreHelp();
      toggleMetricHelp(button);
      return;
    }
    if (event.target.closest(".metric-help")) return;
    closeScoreHelp();
    closeMetricHelps();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeMenu();
      closeScoreHelp();
      closeMetricHelps();
    }
  });
}

if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", init);
}

// Exposes pure calculation functions for Node-based tests; no-op in the browser, where
// `module` is undefined for a classic (non-module) script.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    calculate,
    buildTimelineRows,
    timelineSummary,
    benefitForClaimAge,
    estimatedSocialSecurityFraBenefit,
    recommendedSocialSecurityClaimAge,
    socialSecurityClaimingSchedule,
    resolveSocialSecurityPlan,
    resolveEffectiveProfile,
    migrateSocialSecurityProfile,
    migrateLegacyIraContributions,
    SOCIAL_SECURITY_FULL_RETIREMENT_AGE,
  };
}
