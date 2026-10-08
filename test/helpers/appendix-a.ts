/**
 * Appendix A's v0.1 page ("v0.1 form"), verbatim from the pinned specification text: Open Knowledge Format,
 * `SPEC.md` at 25461dbcdd5b2f3fc9aef99c19fb7d8a94ef6149 (Apache-2.0; see NOTICE). The OKF 0.1 fallbacks of §13.1
 * (R5, R6) are tested on it.
 */
export const APPENDIX_A_V01 = `---
type: Metric
title: Income statement (fiscal year)
description: Headline income-statement figures for a fiscal year.
tags: [finance, income-statement]
timestamp: '2026-05-28T22:53:05+00:00'
---

# Definition
The income statement reports revenue and gross profit for a fiscal year.

# Revenue
Recognized revenue sums \`amount\` over rows booked to the fiscal year:

    SELECT SUM(amount) AS revenue
    FROM finance.recognized_revenue
    WHERE fiscal_year = <year>

# Gross profit
Gross profit by segment, per the cost-allocation standard:

    SELECT gross_profit FROM fct_income_statement
    WHERE fiscal_year = <year> AND segment = <segment>

# Citations
- https://wiki.acme/finance/fpa-handbook
- https://wiki.acme/finance/revenue-recognition
- https://wiki.acme/finance/cost-allocation
`;
