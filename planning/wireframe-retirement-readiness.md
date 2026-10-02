# Wealth Map Retirement Readiness Page Wireframe

```text
+--------------------------------------------------------------------------------+
| Retirement Readiness                                     [Slightly Behind]    |
| Your current retirement projection                                           |
|                                                [Export Retirement Plan PDF]   |
+--------------------------------------------------------------------------------+
|                    RETIREMENT HEALTH SCORE                                   |
|                              79 / 100                                         |
|                          SLIGHTLY BEHIND                                       |
|                 Heuristic estimate, not a probability                         |
+--------------------------------------+-----------------------------------------+
| RETIREMENT TIMING                    | FUNDING POSITION                       |
| Target retirement age     65         | Projected assets at retirement    $907,574 |
| Expected retirement age    66        | Required at retirement for life expectancy $1,024,430 |
| Years to target             20       | Funding gap                   $116,855 |
+--------------------------------------+-----------------------------------------+
| SPENDING CAPACITY                                                              |
| Safe Spending: sustainable through life expectancy              $95,846        |
| Retirement spending goal                                      $100,000        |
| Projected IRMAA (cumulative through life expectancy)           $5,400          |
|                                                                                |
| WHAT DRIVES THIS RESULT?                                                       |
| [x] Current investable assets     [x] Annual savings                           |
| [x] Expected return               [x] Retirement spending goal                 |
| [x] Target retirement age         [x] Safe withdrawal rate                     |
|                                                                                |
| Assumptions: real-dollar projection, end-of-year contributions, 4% SWR.       |
| Tax, Roth, Social Security, IRMAA, and RMD values are illustrative estimates. |
+--------------------------------------------------------------------------------+
```

## Interactions

- Every metric updates when inputs change on another page.
- Show an unambiguous funding gap or surplus.
- Projected Assets is the after-tax target-year portfolio from the Timeline; Required Assets is the minimum target-year portfolio that remains solvent through life expectancy under the same Timeline engine.
- A plan that depletes before life expectancy must not appear fully funded because of a target-date-only snapshot.
- If the target is not reached by life expectancy, show `Beyond life expectancy`.
- Never describe the score as a probability of success.
- Provide score context on demand through the information control: it summarizes funding progress, savings, retirement timing, and Timeline sustainability; it updates with assumptions and is a planning aid rather than a guarantee.
- Provide an export action that opens a concise, printable Retirement Plan Summary with executive/readiness results, the current top three recommendations, a plan snapshot, major timeline milestones, and the educational disclaimer. Do not include Additional Opportunities or yearly timeline rows.
