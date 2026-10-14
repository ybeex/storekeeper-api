# What changed in this drop

Two archives: `ventrix-source.tar.gz` (the API, folder `storekeeper-api/`) and `storekeeper-web.tar.gz` (the web app).
Replace your local folders with them, or copy over only the files listed below.

## Apply it

1. **Database** (API folder). Existing database, in this order:
   `psql "$DATABASE_URL" -f drizzle/manual/0003_catalog_appearance_and_imports.sql` then `psql "$DATABASE_URL" -f drizzle/manual/0004_org_accounts.sql`.
   Both are safe to run twice. Do not wrap 0003 in a transaction (it builds two indexes `CONCURRENTLY`). New database: `npm run db:setup` runs both.
2. **API:** `npm install`, then restart. New optional settings are in `.env.example` (`IMPORT_MAX_MB`, `IMPORT_MAX_ROWS`, `IMPORT_CHUNK_ROWS`, `DATABASE_READ_URL`).
3. **Imports in the background:** with `JOBS_MODE=queue` run the worker (`npm run dev:worker`). With `inline` the API does it itself.
4. **Web:** `npm install`, then restart.

## Done

| You asked for | What now happens |
| --- | --- |
| Holders column shows names | `GET /transactions` returns item, holder, actor and job **names**. The Ledger tab shows readable columns. |
| Dashboard org name bolder, with a dropdown of your orgs | Bold in the header. For admins it opens a list of the organizations they run (current one ticked), plus "All organizations" and "New organization". Switching ends the old session, starts one in the other org, and clears cached data so nothing from one org shows in the other. It refuses while this device still holds unsynced offline actions, because those belong to the org they were made in. |
| `/app`: create another org, pending invites, org notifications | New admin-only page. After registering you land here. It shows your organizations as cards (people count, unread alerts, Open), a "New organization" card and dialog, the invitations still waiting across all your orgs, and the latest alerts across all of them (click one to open that org at Notifications). Everyone who is not an admin is sent back to their own home, and the API refuses them too. |
| Invited users work in one org only | An invite is refused if the email already has an active login in another organization, both when it is sent and when it is accepted. Invited users never get an account link, so they have no way to reach a second org. |
| Table header not transparent | The dashboard items table header is solid. |
| Dashboard header not transparent | The top bar is now a solid, full-width bar. |
| Recent activity and assets cards same height | Both are a fixed height with internal scrolling, so nothing shifts while loading. |
| Buttons with no state | One shared busy button (spinner, changing label, disabled, announced to screen readers) now used on import, team, settings, approvals, reconciliation, transactions, notifications, activity and the catalog. Deactivate has a confirmation and shows "Deactivating and signing them out". |
| Admin-only line on Notifications | "Alerts routed to the right roles." shows for admins only. |
| Rules page was empty | It was a bug: the page read the wrong field from the API response. Fixed, and each alert now has a name and a description of what it is for. Also fixed: the bell never showed an unread count, and read items still looked unread. |
| Store staff see only their own activity | Enforced on the server for the ledger, a single transaction, the activity feed and an item's timeline. They also get "My activity" in the menu. |
| Store staff: no dashboard or analytics | The dashboard and its analytics now refuse store staff (403), the menu hides them, and they land on Transactions. |
| Analytics on the dashboard | New section: movements per day (7/14/30 days), checkouts with a named holder, people recording, lost and damaged, stock health, most used stock, who holds the most. |
| Category and shelf creation inside the item form | "+ Shelf" and "+ Category" buttons open a pop-up; the new one is selected automatically. |
| Shelves, categories and items as cards | Catalog is Shelves (cards) > a shelf's Categories (cards) > a category's Items (cards). Each has its own colour and icon. Items show their photo, or the icon and colour chosen when creating them, falling back to the category's, then the shelf's. "All items" keeps the searchable table. |
| Heavy uploads | Files up to 100 MB / 200,000 rows stream in with a real progress bar, are checked and imported in the background with live progress, resume after a crash, and leave a downloadable error list. |
| Robust for millions of users | See `storekeeper-api/docs/SCALING.md`: what is built (cache with write invalidation, read replica option, chunked imports, indexes) and what is deliberately not yet (pooling, partitioning, load test). |

## How the multi-org part works (so you can check it matches what you meant)

* Still one `users` row per person per organization, so nothing that points at `users` changed. A nullable `users.account_id` ties together the **admin** rows of one person. It is set only when a signed-in admin creates another organization, never by matching email, because emails are not verified and a match would let a stranger claim your organizations. The tests cover that case.
* One password across an admin's organizations: changing or resetting it in one changes it in all and signs every session out.
* Logging in is unchanged (organization, email, password). Admins can then switch from the top bar or `/app`.
* Public sign-up with an email that already has an organization still creates a separate, unlinked login, as before. Use "New organization" instead.
* Limit of 20 organizations per account.

## Waiting on you

* **Wholesale and provisions stores, shelf records only.** The answer to "is the existing app enough" is in the chat reply. Nothing built yet: it needs your pick of the small gaps listed there.

## Known, not mine

Four API tests fail on your original code as well (60 tests now run; the same 4 fail) (`security`: last admin returns 403 not 409; `input hardening`: 404 not 400;
`UI-kit read APIs`; `offline bootstrap`). Your archives had no lockfiles, so library versions may differ from yours. The web app
has two type errors that also exist in the original (`items/[id]/page.tsx` line 37, and `Big_Shoulders_Display` in the root layout).
Not run: the Playwright e2e tests (no browser available here), and no visual check in a real browser.
