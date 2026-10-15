# Empty, loading, and error states

Launch-critical when the product has a UI that shows data (lists, dashboards, search, notifications, profiles, or equivalent). Candidate source: untrusted X post `2110505680830697561` (@Voxyz_ai). Also listed on `2110705357492203564`. Core check 11 covers missing routes and server errors; this module covers **no-data** and **in-progress** UI, which 11 did not spell out.

A page that is blank, or that shows a raw error, when a new user has no data is FAIL.

| ID | Check | Maps to | Evidence expected |
|---|---|---|---|
| E1 | Inventory of data-displaying surfaces | 11, 17 | List every list, table, dashboard, search/filter results view, notification inbox, and profile or detail view that binds to data. If the inventory cannot be completed, UNKNOWN, not PASS. |
| E2 | Designed empty state | 11 | For each inventoried surface: a designed empty state (not a blank page, not an uncaught error) with one line of why it is empty and a next-step control where a next step exists. Evidence: screenshot or fetched UI as a **fresh empty account**, plus a no-results search/filter, plus an everything-deleted case if the product allows delete. |
| E3 | Designed loading state | 11 | Each inventoried surface shows a loading indicator or skeleton while data is in flight (throttled or slow network). Screenshot or test. |
| E4 | Designed error state | 8, 11 | Each inventoried surface shows an on-brand, actionable error (not a stack trace, not "something went wrong" with no next step) when the request fails. Test by forcing a failed fetch if safe. |
| E5 | Form validation keeps user input | 6, 17 | If forms exist: a failed field does not wipe the other fields. |

## How to verify

1. Build the inventory from routes, screens, and components (file:line).
2. Create or use a **fresh empty account** (not the developer's data-filled account).
3. Open every inventoried surface. Record empty, loading, and error for each.
4. Repeat for search/filter with a query that has no hits, and for a user who deleted their last item if that path exists.

Developer accounts already have data, so they are not evidence for E2. A unit test that mocks an empty array is supporting evidence only; the empty-account walkthrough is required for PASS.

NOT APPLICABLE only for products with no end-user UI that displays collections (pure API, library, CLI). Say which client owns E1-E4.
