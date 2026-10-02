# Wealth Map Product Requirements Document

## 1. Product Overview

### Product name

Wealth Map

### Purpose

Wealth Map is a retirement-planning application with a browser-based planning experience and persisted plan data. It helps people understand whether they are on track to retire, identify their projected funding gap, estimate when they may be able to retire, and decide what actions to take today.

The product is an educational decision-support tool, not a net-worth tracker or financial-advice service. It should give users useful answers quickly rather than require them to build a complex financial plan.

### Research foundation and product vision

The calculation model and planning documents define the foundation for the product. The application does not reproduce a full tax-planning engine, but its data model and calculation layer leave room for those future capabilities; the Wealth Timeline page and the RMD divisor table, NIIT, and Social Security claiming-age comparison are part of the current release.

The current release uses the simplified rules in this PRD. Future tax-aware features should validate documented scenarios against the deterministic calculation model before implementation.

The long-term product should help users answer decision-oriented questions:

- Can I retire at my target age?
- Which account should I spend from first?
- Should I perform Roth conversions, and how much?
- When should I claim Social Security?
- How much can I sustainably spend?
- How can I reduce lifetime taxes?

### Core product promise

Within approximately 60 seconds of reviewing the sample profile, a user should understand:

- Their Retirement Health Score from 0 to 100
- Whether they are on track for retirement
- Their estimated retirement age compared with their target
- Their projected retirement funding gap or surplus
- Their three highest-priority recommended actions

## 2. Goals and Non-Goals

### Product goals

- Provide a coherent retirement-planning workflow.
- Provide six connected pages with simple navigation, including an editable year-by-year wealth timeline.
- Display a realistic built-in sample dataset.
- Calculate basic retirement-readiness metrics from the sample data.
- Show a Retirement Health Score, projected retirement age, and funding gap.
- Generate understandable, rule-based recommendations.
- Establish a foundation that can later use more sophisticated planning logic.
- Make the Retirement Health Score the primary experience, with the other pages supporting that result.
- Make every score and recommendation explain which assumptions or metrics produced it.

### Product boundaries and future capabilities

- The first release requires an application service, authenticated plan ownership, and a database-backed persistence layer.
- Server-side validation and authorization must protect saved plans; browser state is a working copy, not the system of record.
- No real financial-account aggregation.
- No external APIs or live market data.
- Tax calculations are simplified illustrative estimates rather than production tax software.
- The application supports an editable annual Roth-conversion assumption; full Roth-conversion optimization is a future capability.
- The application estimates taxable benefits from an editable benefit input and shows an illustrative, single-filer claiming-age comparison (ages 62-70); Social Security optimization is a future capability.
- The application estimates RMD amounts using an illustrative IRS Uniform Lifetime Table divisor; full RMD alerting is a future capability.
- No Monte Carlo simulation.
- No estate-planning functionality.
- No claim that results are personalized financial advice.
- No claim that the application produces official federal tax, IRMAA, Roth conversion, Social Security, or RMD outcomes.

## 3. Target Audience

### Primary audience

- Adults who want a quick, understandable view of their retirement readiness.
- People who have money across multiple account types and want to understand how those assets contribute to retirement.
- Users who prefer actionable guidance over a complex spreadsheet or financial model.

### User characteristics

- Comfortable entering or reviewing basic financial information.
- Interested in retirement timing, savings behavior, and spending sustainability.
- May not understand tax treatment, withdrawal order, or retirement projections in detail.

## 4. User Problems and Jobs To Be Done

Users need to answer questions such as:

- Can I retire at my target age?
- Am I saving enough?
- Will my assets support my retirement spending goal?
- Which account balances contribute to my retirement plan?
- Which account type may be most appropriate for a future withdrawal, at a conceptual level?
- How large is my projected retirement gap?
- What are the most useful actions I can take next?

## 5. Core Use Cases

1. A user opens the app and reviews a sample financial profile.
2. A user navigates to Assets and sees balances grouped by account type.
3. A user reviews Income & Expenses and sees income, savings, spending, and retirement spending goals.
4. A user opens Retirement Readiness and sees a score, readiness status, projected retirement age, and funding gap.
5. A user opens Recommendations and sees up to three prioritized suggestions generated from the sample data.
6. A user opens the Wealth Timeline and reviews or overrides individual years of the projection to match their own expectations.
7. A user navigates between all six pages using persistent navigation and can always identify the current page.
8. A user edits one or more profile, asset, income, expense, or assumption fields and immediately sees the score, projections, and recommendations update.
9. A user can restore the original sample dataset after experimenting with values.
10. A user can preview and print or save a concise Retirement Plan Summary PDF from Readiness, including current readiness outputs, the top three recommendations, a plan snapshot, major timeline milestones, and a disclaimer.

## 6. Information Architecture and Page Requirements

### 6.1 Profile

**Purpose:** Present the assumptions that define the retirement plan.

**Display:**

- User name
- Current age
- Target retirement age
- Life expectancy
- State
- Tax filing status
- Expected annual return
- Inflation rate
- Safe withdrawal rate
- Projection basis
- Short summary of the plan

**Account classification:** Each account must show a plain-language tax-treatment label:

| Account           | Tax treatment                  | Product interpretation                                  |
| ----------------- | ------------------------------ | ------------------------------------------------------- |
| Taxable brokerage | Taxable                        | Flexible withdrawals; gains may be taxable              |
| 401(k)            | Tax-deferred                   | Future withdrawals may be taxable                       |
| Traditional IRA   | Tax-deferred                   | Future withdrawals may be taxable                       |
| Roth IRA          | Tax-free qualified withdrawals | Tax-free retirement flexibility                         |
| Cash              | Liquid                         | Short-term spending reserve                             |
| Real estate       | Separate asset                 | Not automatically treated as spendable portfolio assets |

The application may display educational withdrawal-order context, but must not claim to optimize withdrawal order.

**Product behavior:** Load editable values from the saved plan or shared sample dataset. Changes must update the shared working state, persist through the application service, and update all dependent calculations.

### 6.2 Assets

**Purpose:** Show the user's financial resources by account or asset type and explain their role in retirement planning.

**Display:**

- Taxable brokerage balance
- 401(k) balance
- Traditional IRA balance
- Roth IRA balance
- Cash balance
- Real estate value
- Total financial assets
- Total assets including real estate
- Optional net worth value if liabilities are included in the dataset

**Product behavior:** Provide editable numeric inputs for each balance. Calculate totals from the current working plan, not from hard-coded display values, and persist valid changes through the application service. Clearly distinguish account categories because they have different tax treatments.

### 6.3 Income & Expenses

**Purpose:** Show current earning, saving, and spending behavior.

**Display:**

- Annual salary
- Other annual income, if present
- Annual savings
- Current annual expenses
- Retirement annual spending goal
- Current savings rate
- Annual cash flow or surplus

**Product behavior:** Provide editable inputs for income, savings, expenses, and retirement spending goal. Calculate savings rate and surplus from the current working plan, persist valid changes, and use clear positive and negative states.

### 6.4 Retirement Readiness

**Purpose:** Give the user the primary answer: whether they are on track to retire.

**Display:**

- Retirement Health Score from 0 to 100
- Readiness status: On Track, Slightly Behind, or Major Shortfall
- Target retirement age
- Expected retirement age
- Projected after-tax retirement assets at the beginning of the target retirement year
- Required after-tax retirement assets at the beginning of the target retirement year to remain solvent through life expectancy
- Funding gap or surplus
- Safe annual spending estimate that remains sustainable through life expectancy under the shared retirement projection engine
- A short explanation of the result and its assumptions

**Product behavior:** Derive all values from the current working plan and calculation rules. Recalculate after every valid input change and keep saved plan data consistent with the displayed result. Use a prominent but restrained visual treatment for the score and status.

The Retirement Health Score is the primary output. The page must identify the assumptions that drive it and distinguish projected investable assets from real estate.

### 6.5 Recommendations

**Purpose:** Convert the readiness results into practical next actions.

**Display:**

- Up to three prioritized recommendations
- A short explanation for each recommendation
- The metric or condition that triggered it
- Optional estimated effect, such as reducing the funding gap or improving projected retirement age

Each recommendation must also include its priority, triggering metric, and a short explanation. An estimated effect may be shown only when the application actually calculates it; otherwise label the effect as qualitative.

**Possible recommendation rules:**

- Recommend increasing savings when the savings rate is below the target threshold.
- Recommend delaying retirement by one year when the projected gap is materially positive.
- Recommend reviewing retirement spending when the spending goal is high relative to assets.
- Recommend delaying Social Security to age 70 as an educational suggestion, without calculating actual benefit values.
- Recommend reviewing tax diversification when most assets are in tax-deferred accounts.

- Do not present Roth conversion, Social Security, tax, or RMD outputs as official advice. All such outputs must be labeled as simplified educational estimates.

Recommendations must be labeled as educational suggestions, not financial advice.

### 6.6 Wealth Timeline

The layout and interaction contract for this workbench is defined in [planning/wireframe-timeline.md](wireframe-timeline.md). The Timeline is a first-class planning view and the shared source of truth for annual retirement projection details used by Readiness and Recommendations.

**Purpose:** Let the user see and adjust the model's year-by-year projection so it can be reconciled with their own reality, rather than trusting a single target-age snapshot.

**Display:**

- A chart of projected financial assets by age, from the current age through life expectancy, with the target retirement age marked.
- A summary of projected assets at life expectancy, the age assets are projected to deplete (if any), and how many years currently have a user override.
- An editable row for every age, showing the modeled or overridden expected return, income, expenses or spending, one-time withdrawal, contribution or withdrawal amount, RMD, and ending assets for that year.

**Product behavior:** Blank fields use the automatically modeled value; a per-year override is layered on top of, and does not replace, the shared profile assumptions. Overrides are cleared by the `Reset sample data` control or a page-level `Reset timeline overrides` control. Income overrides apply only to working years, and expense or one-time withdrawal overrides apply only to retired years, because the underlying engine does not use those values outside that phase. A projected shortfall or IRMAA-triggering year found in the timeline must also surface in the Retirement Health Score and Recommendations, not only on this page.

### Editable input behavior

- Inputs must be clearly labeled with their unit, such as dollars, years, percentage, or currency per year.
- Numeric inputs must reject or safely handle invalid, negative, or out-of-range values according to the field rules.
- Changes may recalculate on input or on a clearly labeled Apply/Update action, but the interaction must require no page reload.
- Recalculation must update all affected pages or views, including totals, cash flow, readiness metrics, score, and recommendations.
- Provide a `Reset sample data` control that restores the original dataset and recalculates the app without deleting the user's saved plan.
- Persist the working plan through the application service. Browser memory or storage may support responsiveness, but must not be the system of record.

## 7. Navigation Requirements

- Provide persistent navigation to Profile, Assets, Income & Expenses, Retirement Readiness, Wealth Timeline, and Recommendations.
- Every page must link to every other page through the navigation.
- Highlight the active page.
- Use readable page titles and consistent navigation labels.
- Navigation must work on desktop and mobile layouts.
- Use vanilla JavaScript for page switching if implementing a single-page app.
- A multi-page HTML implementation is also acceptable, provided the shared sample data and calculations remain consistent.
- The preferred implementation is a browser application with six view sections backed by a shared application service, because it avoids duplicated markup while keeping saved plan data and calculated state consistent.

## 8. Functional Requirements

- FR1: The app must use HTML, CSS, and vanilla JavaScript.
- FR2: The app must provide a browser experience backed by the application service.
- FR3: The first release must provide authenticated access to saved plans through a backend and database.
- FR4: The app must load a saved plan or built-in sample dataset when opened.
- FR5: The app must calculate asset totals from individual asset values.
- FR6: The app must calculate annual savings rate and annual surplus.
- FR7: The app must calculate a basic retirement projection using the defined assumptions.
- FR8: The app must calculate a funding gap or surplus.
- FR9: The app must calculate and display a Retirement Health Score from 0 to 100.
- FR10: The app must classify readiness as On Track, Slightly Behind, or Major Shortfall.
- FR11: The app must estimate Safe Spending as the maximum annual retirement spending goal that remains sustainable through life expectancy under the shared retirement projection engine. The configurable safe withdrawal rate remains an assumption used by the required-assets calculation, but Safe Spending must not be a separate rule-of-thumb formula.
- FR12: The app must generate no more than three prioritized recommendations from rule-based conditions.
- FR13: All pages must use the same underlying dataset and calculations.
- FR14: The app must display a clear disclaimer that projections are simplified educational estimates.
- FR15: The app must avoid presenting outputs as guaranteed results or individualized financial advice.
- FR16: The app must classify assets by account type and display their simplified tax treatment.
- FR17: The app must distinguish investable retirement assets from real estate in readiness calculations.
- FR18: The app must identify the assumptions contributing to the Retirement Health Score.
- FR19: Each recommendation must show its trigger, priority, and rationale.
- FR20: The calculation layer must be separate from rendering and navigation so future scenario calculations can be added without rewriting page markup.
- FR21: The app must visibly label tax, Roth conversion, Social Security, IRMAA, and RMD calculations as simplified illustrative estimates.
- FR22: The app must provide editable controls for all core profile, asset, income, expense, and projection-assumption fields.
- FR23: Valid input changes must update the shared working state, persist through the application service, and update dependent views without a page reload.
- FR24: Every derived value must be recalculated from the current state after an edit, including asset totals, savings rate, surplus, projected assets, funding gap, expected retirement age, score, and recommendations.
- FR25: The app must provide a reset control that restores the original sample dataset.
- FR26: Invalid or out-of-range input must produce an understandable validation state and must not produce broken, misleading, or `NaN` output.
- FR27: The app must provide editable assumptions for federal standard deduction, state income tax rate, taxable gains tax rate, pre-tax withdrawal tax rate, annual Roth conversion, Social Security benefit mode and taxable percentage, RMD start age, NIIT MAGI threshold, Cash Reserve (Years of Spending) (how many years of retirement spending the model attempts to maintain in cash), and IRMAA threshold and surcharge.
- FR28: The app must apply a simplified progressive federal bracket calculation and show its assumptions without representing it as official tax software.
- FR29: The app must include simplified tax effects in projected after-tax assets and retirement spending needs.
- FR30: The app must provide an editable year-by-year wealth timeline from the current age through life expectancy, allowing per-year overrides that fall back to the modeled value when left blank.
- FR31: The app must estimate RMDs using an age-indexed divisor table rather than a single flat rate.
- FR32: The app must show an illustrative, read-only Social Security claiming-age comparison and must not present it as claiming optimization.
- FR33: The app must provide an editable Social Security claim age (62-70, default 67, editable on Plan Setup next to the benefit mode) that adjusts the modeled benefit using the same claiming-schedule methodology as FR32, and that determines the age at which modeled Social Security income, taxation, and withdrawal offsets begin in the Timeline, Readiness, and Recommendations. A profile without a stored claim age must default to 67 without user action.
- FR34: The app must default new plans to an automatically estimated Social Security benefit at Full Retirement Age based on current earnings, while providing an editable manual entry mode to allow users to supply values from their official Social Security statement.

## 9. Sample Data Model

Store the sample data in a clearly separated JavaScript object, preferably in `data.js` or at the top of `app.js`.

```js
const sampleProfile = {
  name: "Alex Morgan",
  currentAge: 45,
  targetRetirementAge: 65,
  lifeExpectancy: 95,
  state: "Florida",
  filingStatus: "Married filing jointly",
  annualSalary: 180000,
  otherAnnualIncome: 0,
  contributionRates: { fourOhOneK: 0.05 },
  iraContributions: { traditionalIraAnnual: 0, rothIraAnnual: 3000 },
  savingsAllocation: { brokerage: 0.75, cash: 0.25 },
  currentAnnualExpenses: 140000,
  retirementAnnualSpendingGoal: 100000,
  expectedAnnualReturn: 0.0375,
  inflationRate: 0.025,
  projectionBasis: "real_dollars",
  safeWithdrawalRate: 0.04,
  federalStandardDeduction: 30000,
  // Florida has no state income tax; this is the default so most users start with 0%.
  stateIncomeTaxRate: 0,
  taxableGainsTaxRate: 0.15,
  preTaxWithdrawalTaxRate: 0.22,
  rothConversionAnnualAmount: 0,
  socialSecurityBenefitMode: "auto",
  socialSecurityAnnualBenefit: 0,
  // Full Retirement Age (67) is the default and supported range is 62-70; the Full Retirement Age
  // benefit is adjusted for this claim age.
  socialSecurityClaimAge: 67,
  socialSecurityTaxablePercent: 0.85,
  rmdStartAge: 73,
  niitThreshold: 250000,
  cashReserveTargetYears: 1,
  irmaaIncomeThreshold: 200000,
  irmaaAnnualSurcharge: 1800,
  assets: {
    brokerage: 40000,
    fourOhOneK: 275000,
    traditionalIra: 75000,
    rothIra: 25000,
    cash: 20000,
    realEstate: 450000,
  },
};
```

The default sample currently produces a 79-point `Slightly Behind` score, a 10.6% savings rate, estimated safe spending below its $100,000 goal, and several prioritized and informational planning opportunities. These are deterministic sample outputs, not promises about a user's plan.

The exact sample values may be adjusted by the implementation agent, but the dataset must be internally consistent and must produce visible content in every required page. The implementation also keeps a separate, initially empty map of per-age wealth-timeline overrides; it is runtime state, not sample data, and is cleared whenever the sample dataset is reset.

## 10. Calculation Rules

Use simplified, transparent calculations suitable for an educational planning application. Keep calculation functions separate from rendering functions.

### Asset totals

- Financial assets = brokerage + 401(k) + Traditional IRA + Roth IRA + cash.
- Total assets = financial assets + real estate.
- If liabilities are added, net worth = total assets - total liabilities.

### Cash flow

- Total annual income = salary + other annual income.
- Employee 401(k) contribution = employee 401(k) rate x annual salary.
- Traditional IRA contribution = a fixed editable annual dollar amount, not a percentage of income. This better matches how users plan IRA funding (for example, "$7,000 per year") and avoids unrealistic contribution levels a percentage of income could produce.
- Illustrative current income taxes apply after those employee pre-tax contributions.
- Roth IRA contribution = a fixed editable annual dollar amount, not a percentage of income. It does not reduce taxable income and is subtracted from income remaining after illustrative taxes and employee pre-tax contributions to help determine available annual savings.
- Available annual savings = max(0, income remaining after illustrative taxes and employee pre-tax contributions - Roth IRA contribution - current annual expenses). It can never be negative.
- Brokerage and cash contributions are allocations of available annual savings, not separate percentages of income: `Brokerage Allocation %` and `Cash Allocation %` split available annual savings and must total 100%. Because they only divide an already-nonnegative pool, they can never create additional negative cash flow.
- Legacy profiles saved with percentage-of-income `contributionRates.brokerage`/`contributionRates.cash` are migrated automatically the first time the model runs: the legacy percentages are converted into an equivalent allocation split that preserves their relative proportion, which then becomes the profile's Brokerage/Cash allocation going forward.
- An optional "Use current IRS max" shortcut fills the Traditional IRA or Roth IRA annual contribution field with an illustrative current-year IRA limit; it only populates the field and introduces no separate contribution logic.
- Legacy profiles saved with percentage-based `contributionRates.traditionalIra`/`contributionRates.rothIra` are migrated automatically the first time the model runs: the old percentage formulas are replayed against the profile's own income and tax assumptions to reconstruct an equivalent annual dollar amount, which then becomes the profile's Traditional IRA/Roth IRA annual contribution going forward.
- Employer 401(k) match = the lesser of employee 401(k) contribution x match rate and annual salary x match cap. It increases retirement savings but does not reduce employee income, cash flow, or taxable income.
- After-tax annual surplus = income after employee pre-tax contributions and illustrative taxes - employee post-tax contributions - current annual expenses.
- Employee savings rate = employee contributions / total annual income.

- Total retirement contributions = employee contributions + employer 401(k) match. The UI must distinguish employee savings, employer match, and total retirement contributions.

### Retirement target

- Required retirement assets = retirement annual spending goal / safe withdrawal rate.
- For the sample data above, a 4% safe withdrawal rate implies a target equal to 25 times annual retirement spending.

- If `projectionBasis` is `real_dollars`, treat the return assumption as a real return and do not inflate the spending goal again.
- If the implementation uses nominal dollars instead, inflate the retirement spending goal by the inflation rate through the target retirement year and label all projected values as nominal. The app must use one basis consistently.

### Projection

Use a simple annual compounding projection with fixed real-dollar, end-of-year contributions to their matching account buckets:

- Years to target retirement = target retirement age - current age.
- Projected assets = current financial assets compounded at the expected annual return plus calculated employee and employer contributions compounded through the remaining years.
- Do not project real estate as spendable retirement portfolio assets unless the UI explicitly labels it as a separate assumption.
- Account for contributions as end-of-year contributions unless the implementation documents another convention.

A suitable simplified formula is:

```text
projectedAssets = currentFinancialAssets * (1 + returnRate)^years
                  + annualSavings * (((1 + returnRate)^years - 1) / returnRate)
```

Handle a zero return rate without dividing by zero.

### Funding gap

- Funding gap = long-horizon sustainable required retirement assets at the target retirement year - projected after-tax assets at the beginning of that year. Both values must be derived from the shared Timeline retirement engine; the Readiness page must not use a separate target-date-only forecasting methodology.
- If the result is negative, display the absolute value as a projected surplus.

### Expected retirement age

Estimate an expected retirement age by testing future retirement ages until projected assets meet the required target. If the target is not reached by the configured life expectancy, display `Beyond life expectancy` or an equivalent clear state.

### Retirement Health Score

The Retirement Health Score is the primary executive summary indicator on the Readiness page. It is a concise planning aid that summarizes funding progress, savings progress, retirement timing, and long-term sustainability from the shared retirement projection model. It must update when assumptions change and must be presented as a heuristic planning indicator, not a guarantee, probability, or prediction of retirement outcomes.

Implement a transparent score from 0 to 100 based on:

- Progress toward required retirement assets
- Savings rate
- Retirement timing relative to the target age

The exact weighting may be chosen by the implementation agent, but it must be documented in code or a short README note and must always be clamped to the range 0-100. The score must also reflect a shortfall found in the year-by-year wealth timeline (section 6.6), not only the single target-age snapshot, by way of a documented penalty.

The score is a heuristic, not a probability of success. Do not label it as a probability or imply that it is comparable to a Monte Carlo result.

Suggested interpretation:

- 80-100: On Track
- 50-79: Slightly Behind
- 0-49: Major Shortfall

The full RMD divisor table, NIIT surtax, wealth-timeline accumulation/decumulation rules, cash-reserve buffer, and Social Security claiming-age formulas are documented in [`planning/calculation-model.md`](calculation-model.md) rather than duplicated here.

## 11. UI and Styling Requirements

- Create a clean, modern financial-planning dashboard.
- Prioritize clarity, trust, and scanning over decorative complexity.
- Use a responsive layout that works on desktop and mobile.
- Use consistent spacing, typography, headings, cards, tables, and status indicators.
- Present the Retirement Health Score as the main visual focus of the Readiness page.
- Use positive styling for surplus or on-track states and warning styling for gaps or negative cash flow.
- Make financial values easy to scan using currency formatting.
- Include a small assumptions or disclaimer area on the Retirement Readiness page.
- Avoid charts that require external libraries; simple bars, progress indicators, or CSS visualizations are sufficient.
- Ensure all important information remains accessible without relying on color alone.
- Use semantic HTML and accessible labels, headings, focus states, and keyboard-operable navigation.
- Show unavailable future calculations with an explicit state such as `Not currently modeled`, rather than displaying invented values.

## 12. Technical Requirements

- Use HTML5, CSS3, and modern vanilla JavaScript.
- Keep the browser experience focused and accessible, with the application service responsible for persistence and server-side validation.
- The first release must be deployable with an application service and database; static hosting alone is insufficient for the released product.
- Do not add account aggregation or live financial APIs without updating the product requirements and deployment plan.
- Use a maintainable build and deployment process appropriate for the selected application service and database.
- Keep data, calculations, rendering, navigation, and styling organized into understandable files.
- Define calculation functions with stable, testable inputs and outputs so future scenario validations can be added without changing the user-facing contract.
- Keep the original sample dataset immutable and maintain a separate working state for user edits.
- Use a single update path for input changes: validate input, update working state, recalculate derived values, then render dependent views.
- Do not duplicate editable values or calculated results across page markup.
- Format currency and percentages using JavaScript formatting utilities.
- Avoid hard-coding calculated results into page markup.
- Handle missing, zero, and invalid numeric values without breaking the UI.
- Include a README with local run instructions and a short explanation of the application assumptions.

## 13. Expected Deliverables

Create a browser application and supporting application service with a structure similar to:

```text
index.html
styles.css
app.js
data.js             (optional)
README.md
server/              (application service)
database/            (schema and migrations)
planning/wireframe-navigation.md
planning/wireframe-profile.md
planning/wireframe-assets.md
planning/wireframe-income-expenses.md
planning/wireframe-retirement-readiness.md
planning/wireframe-recommendations.md
```

The app may use additional files if they improve clarity. Local development must run the browser application together with the application service and a development database or documented database substitute.

## 14. Acceptance Criteria

- All six required pages or views exist:
  - Profile
  - Assets
  - Income & Expenses
  - Retirement Readiness
  - Wealth Timeline
  - Recommendations
- Navigation between all pages works from any page.
- The active page is visually identifiable.
- The sample profile appears consistently throughout the app.
- Asset totals are calculated from the underlying asset values.
- Income, expenses, savings rate, and surplus are displayed.
- Retirement Readiness displays a score from 0 to 100.
- Retirement Readiness displays target age, expected age, projected assets, required assets, and gap or surplus.
- Recommendations are generated from the sample data and limited to the top three.
- The app includes a clear educational disclaimer.
- The layout is usable on desktop and mobile widths.
- The first release works with authenticated access, a backend application service, and a database.
- The browser experience can be deployed alongside the application service through the release deployment process.
- The README explains how to run the application and describes the simplified calculations.
- The README identifies which planning concepts are implemented, simplified, or future capabilities.
- The app does not describe the Retirement Health Score as a probability of retirement success.
- Each recommendation displays why it was generated.
- Investable assets and real estate are visibly distinguished.
- Tax, Roth conversion, Social Security, IRMAA, and RMD outputs are visibly labeled as simplified illustrative estimates.
- Core profile, asset, income, expense, and projection-assumption fields are editable.
- Editing a valid field updates dependent calculations without a page reload.
- Changes made on one page are reflected when the user navigates to another page.
- Invalid input is handled visibly without `NaN`, broken layouts, or stale calculated results.
- Resetting the sample data restores the original displayed values and calculations, including clearing any wealth-timeline overrides.
- Every age in the Wealth Timeline falls back to the modeled value when its override is blank, and an override at one age does not change any other age.
- A wealth-timeline shortfall (projected depletion before life expectancy) or IRMAA-triggering year is reflected in the Retirement Health Score or Recommendations, not only on the Timeline page.

## 15. Future Enhancements

### Current release and future roadmap

- Scenario comparison using the same transparent projection functions. The Wealth Timeline's per-year overrides partially address this for a single scenario; named, side-by-side scenario comparison remains future work.
- Optional local storage persistence.

### Phase 2: Tax-aware planning / P1

- Roth conversion modes: Base, Suggested, and Aggressive.
- Basic federal tax projections.
- Social Security claiming optimization beyond the illustrative, single-filer claiming-age comparison already implemented in the current release.
- Withdrawal-order analysis beyond the fixed cash → brokerage → pre-tax → Roth order already used by the wealth timeline.
- Validation against additional documented scenarios.

### Phase 3: Advanced planning / P2

- Monte Carlo simulation.
- Account aggregation.
- RMD alerting and more complete RMD cash-flow treatment beyond the illustrative divisor-table estimate already implemented in the current release.
- More detailed scenario comparisons.
- Estate-planning features.

## 16. Model Validation Requirements

- Create a small set of documented input scenarios and expected outputs before implementing tax-aware features.
- Compare future tax, Roth conversion, Social Security, and RMD results against documented reference scenarios.
- Record which planning assumptions are supported, simplified, or intentionally excluded.
- Treat ending account balances as incomplete measures of household wealth when modeled RMD cash has left the tracked accounts.

## 17. Product and Financial Disclaimer

Wealth Map is an educational retirement-planning application. Its projections use simplified assumptions and are not guarantees of investment performance, retirement success, tax outcomes, or Social Security benefits. The app does not provide financial, tax, or legal advice. Users should consult qualified professionals before making financial decisions.
