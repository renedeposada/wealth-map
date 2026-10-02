# Wealth Map Profile Page Wireframe

```text
+--------------------------------------------------------------------------------+
| Profile                                                        [Reset sample]  |
| Personal details and planning assumptions                                     |
+--------------------------------------------------------------------------------+
| PROFILE                                                                        |
|                                                                                |
| Name                         [ Alex Morgan                         ]           |
| Current age                 [ 45        ] years                               |
| Target retirement age       [ 65        ] years                               |
| Life expectancy             [ 95        ] years                               |
| State                       [ Florida v ]                                     |
| Tax filing status           [ Married filing jointly v ]                      |
|                                                                                |
| PROJECTION ASSUMPTIONS                                                         |
| Expected annual return      [ 3.75      ] %                                   |
| Inflation rate              [ 2.5       ] %                                   |
| Safe withdrawal rate        [ 4.0       ] %                                   |
| Projection basis            [ Real dollars v ]                                |
|                                                                                |
| [Changes recalculate automatically]                                           |
+--------------------------------------------------------------------------------+
```

## Interactions

- All displayed planning fields are editable.
- Changes update the shared working state and all dependent pages.
- Invalid ages or percentages show validation feedback.

## Implementation note

The shipped Plan Setup page also includes a "Tax and retirement settings" section with State, Tax filing status, Social Security benefit mode (Automatically estimate by default, or Enter manually), Social Security Full Retirement Age benefit (read-only estimate in auto mode, editable in manual mode), and Social Security claim age (62-70, default 67) always visible, plus a collapsible "Advanced Tax & Retirement Settings" section for less commonly changed assumptions. This wireframe predates that structure; see [wireframe-navigation.md](wireframe-navigation.md) and the shipped `index.html` for the current layout.
