# Wealth Map Recommendations Page Wireframe

```text
+--------------------------------------------------------------------------------+
| Recommendations                                                               |
| Suggested next actions based on your current inputs                           |
+--------------------------------------------------------------------------------+
| TOP RECOMMENDATIONS                                                            |
|                                                                                |
| 01  HIGH PRIORITY     Address projected portfolio depletion                    |
|     Trigger: depletion is projected by age 92.                                |
|     Current metric: portfolio does not last through life expectancy 95.       |
|     Suggested action: increase savings, delay retirement, or reduce spending. |
|     Effect: qualitative; use the Timeline to inspect the annual path.          |
|                                                                                |
| 02  HIGH PRIORITY     Address the projected funding gap                       |
|     Trigger: projected assets are below the sustainable requirement.          |
|     Current metric: $116,855 funding gap.                                     |
|     Suggested action: increase savings, delay retirement, or reduce spending. |
|     Effect: qualitative; may improve plan sustainability.                     |
|                                                                                |
| 03  HIGH PRIORITY     Align retirement spending with the estimate              |
|     Current metric: $100,000 goal; $95,846 estimated safe spending.           |
|     Suggested action: reduce the goal by approximately $4,154 per year.       |
|     Effect: qualitative; based on the shared Timeline estimate.                |
|                                                                                |
| Additional Opportunities (4) [collapsed by default]                           |
| Roth conversion ($206,700 first year), savings rate (10.6%), tax diversification|
| (80.5% tax-deferred), and future IRMAA exposure (from age 65).                 |
| All cards retain their situation, recommended action, and rationale.           |
+--------------------------------------------------------------------------------+
```

## Interactions

- Display zero to three recommendations ordered by priority.
- Each recommendation shows its trigger, metric, rationale, and effect type.
- Recommendations regenerate when editable inputs change.
- Do not invent tax savings, conversion amounts, benefits, IRMAA costs, or RMDs.
