# Wealth Map Wealth Timeline Wireframe

The Wealth Timeline is the detailed retirement-planning workbench. It lets users inspect the shared projection year by year, compare planning strategies, and make isolated overrides when their real situation differs from the default assumptions.

```text
+--------------------------------------------------------------------------------+
| WEALTH MAP / TIMELINE                                      [Reset overrides]   |
| Wealth Timeline                                                               |
| Adjust the projection to your reality without changing the core plan inputs.  |
+--------------------------------------------------------------------------------+

+----------------------+----------------------+-------------------------------+
| PROJECTED ASSETS     | PROJECTED DEPLETION  | YEARS WITH AN OVERRIDE        |
| AT LIFE EXPECTANCY   |                      |                               |
| $0                   | Age 92               | 0                             |
+----------------------+----------------------+-------------------------------+

+--------------------------------------------------------------------------------+
| MODEL-GENERATED RETIREMENT STRATEGY                                           |
| Plan Setup remains the source of the core assumptions. Use these controls to   |
| compare model-generated strategies with the selected manual assumptions.      |
|                                                                                |
| Social Security claim strategy       [ Use Plan Setup claim age           v ]  |
| Roth conversion strategy             [ Model-recommended                  v ]  |
|                                                                                |
| Social Security: Manual / Model-recommended                                  |
| Roth conversions: Manual / Model-recommended                                  |
+--------------------------------------------------------------------------------+

+--------------------------------------------------------------------------------+
| SOCIAL SECURITY CLAIMING-AGE COMPARISON                                       |
| Illustrative single-filer estimates. This is not claiming optimization.      |
|                                                                                |
| Claim age          Annual benefit             Monthly benefit                  |
| 62                 $44,100                    $3,675                           |
| 63                 $47,250                    $3,938                           |
| ...                ...                        ...                              |
| 67  [FRA]         $63,000                    $5,250                           |
| 70  [active *]    $78,120                    $6,510                           |
+--------------------------------------------------------------------------------+

+--------------------------------------------------------------------------------+
| RETIREMENT MILESTONES                                                         |
|                                                                                |
| [Age 65] Retirement begins     [Age 65] Roth conversions begin                |
|          projected portfolio              $206,700 first conversion           |
|                                                                                |
| [Age 67] Social Security begins [Age 68] Roth conversions end                  |
|          $63,000 annual benefit           final modeled conversion            |
|                                                                                |
| [Age 73] RMD start age         [Age 92] Portfolio depletion                   |
|          no RMD projected                before life expectancy at age 95      |
+--------------------------------------------------------------------------------+

+--------------------------------------------------------------------------------+
| PORTFOLIO COMPOSITION AT PLANNING MILESTONES                                  |
| Real estate is excluded because it is not treated as spendable assets.        |
|                                                                                |
| CURRENT YEAR       RETIREMENT BEGINS    RMD START AGE       LIFE EXPECTANCY  |
| Total financial    Total financial      Total financial    Total financial   |
| assets: $0         assets: $0           assets: $0         assets: $0        |
| Cash       $0 / 0% Cash       $0 / 0%   Cash       $0 / 0% Cash       $0 / 0%|
| Brokerage  $0 / 0% Brokerage  $0 / 0%   Brokerage  $0 / 0% Brokerage  $0 / 0%|
| Tax-deferred $0/% Tax-deferred $0/%    Tax-deferred $0/%  Tax-deferred $0/% |
| Roth       $0 / 0% Roth       $0 / 0%   Roth       $0 / 0% Roth       $0 / 0%|
| Planning note       Planning note       Planning note       Planning note     |
+--------------------------------------------------------------------------------+

+--------------------------------------------------------------------------------+
| YEAR-BY-YEAR DETAIL                                                           |
| Income overrides apply during working years; spending and extra withdrawals   |
| apply during retirement. Rows with overrides are highlighted.                 |
|                                                                                |
| Age | Return | Income | Social Security | Roth conversion | Spending | Extra  |
|     |        |        |                 |                  |          | withdrawal|
|-----+--------+--------+-----------------+------------------+----------+----------|
| 45  | [5.0%] | [$0]   | $0              | $0               | [$0]     | [$0]     |
| 46  | [     ] | [   ]  | $0              | $0               | [   ]    | [   ]    |
| ... | ...    | ...    | ...             | ...              | ...      | ...      |
|                                                                                |
| Contribution | Withdrawal | RMD | Taxes | Net cash flow | Ending assets | Clear|
| $0           | $0         | $0  | $0    | $0            | $0             | [x]  |
+--------------------------------------------------------------------------------+
```

## Page responsibilities

- Show the projected asset path from the current age through life expectancy using the same timeline engine that feeds Readiness and Recommendations.
- Summarize ending assets, projected depletion, and the number of ages with local overrides.
- Expose Social Security and Roth conversion strategy selectors without duplicating Plan Setup fields.
- Show the read-only Social Security comparison for ages 62 through 70, with the active claim age and Full Retirement Age clearly identified.
- Surface major modeled events through milestone cards, including retirement, Social Security, the first RMD, the first IRMAA year, portfolio peak, and depletion when present.
- Show portfolio composition snapshots for the current modeled year, retirement start, first RMD year when present, and life expectancy. Real estate remains separate from spendable financial assets.
- Provide editable year-by-year detail so users can reconcile individual years without rewriting shared profile assumptions.

## Interactions and state

- `Reset timeline overrides` clears every per-age override and rerenders the Timeline and all dependent views. The global `Reset sample data` control also clears overrides and restores the immutable sample profile.
- Blank override fields fall back to the modeled value for that age. An override is stored at one age only and must not change any other age.
- Return overrides apply to that year's expected return. Income overrides apply during working years. Spending and extra-withdrawal overrides apply during retirement years. Controls that do not apply to the row's phase are disabled or read-only.
- Entering, changing, or clearing a valid override recalculates the shared model and updates Readiness, Recommendations, milestones, composition snapshots, summary metrics, and the affected annual row without a page reload.
- A row with any override receives a visible non-color-only indicator and exposes a clear action. Clearing the row restores all of its fields to modeled values.
- Social Security comparison values are read-only illustrative estimates. The selected manual or model-recommended claim strategy is shown separately from the comparison and is not presented as optimization advice.
- Roth conversion strategy choices are labeled as manual or model-recommended. The model-recommended strategy remains an estimate based on current assumptions.
- Invalid, negative, non-finite, or out-of-range values must show an understandable validation state and must never produce `NaN` or a broken table.
- The detail table remains horizontally scrollable within its own region on narrow screens; the page itself must not require horizontal scrolling. Sticky headers and readable row labels should remain usable on desktop and mobile.

## Calculation contract

- `buildTimelineRows(profile)` produces one row per age from current age through life expectancy.
- Accumulation rows apply growth, contributions, taxes, and the configured conversion strategy. Retirement rows apply Social Security, RMDs, IRMAA, spending, withdrawal sequencing, and cash-reserve behavior.
- Retirement withdrawals use the documented order: cash, brokerage, pre-tax accounts grossed up for withdrawal tax, then Roth. RMDs are removed from pre-tax balances whether or not they are needed for spending.
- The cash reserve refills from brokerage only after a positive-return year. A down year must not force a brokerage refill solely to restore the reserve.
- Timeline summaries and milestone values must be derived from the same rows rendered in the detail table. No Timeline metric may be hard-coded or calculated by a separate retirement model.

## Implementation references

- View: `data-view="timeline"` in `index.html`
- Summary IDs: `timeline-final-assets`, `timeline-depletion-age`, `timeline-overridden-count`
- Strategy controls: `strategy-fields`, `strategy-summary`
- Comparison table: `ss-claiming-table-body`
- Milestones and composition: `timeline-milestones`, `timeline-composition`
- Detail table: `timeline-table-body`; row inputs use `data-timeline-age` and `data-timeline-field`
- Reset control: `timeline-reset-button`
- Core calculation and summaries: `buildTimelineRows()`, `timelineSummary()`, and `buildTimelineMilestones()` in `app.js`
