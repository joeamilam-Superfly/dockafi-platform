# DockaFI management platform (OPS console)

Internal AquaEase ops SPA for **DockaFI | AquaEase** — devices, SIMs, organizations, orders, billing, and the end-user request portal.

- Live: https://dockafiplatform.netlify.app
- Customer portal: https://dockafiplatform.netlify.app/?portal=1
- Data: shared Supabase project `ldgbghjjzbhtrgdnmlmv` (data only; this repo is the console)

Do **not** put marketing/site content here. That lives in `dockafi-site`.

## Repo inventory vs what the SPA calls

| In this repo | Used by |
| --- | --- |
| `index.html` | Entire admin + portal SPA |
| `netlify.toml` | Publishes `.` and rewrites `/api/*` → `/.netlify/functions/:splat` |
| `netlify/functions/submit-request.js` | Legacy request POST `/api/submit-request` |
| `netlify/functions/portal-account.js` | Customer account GET `/api/portal-account` |
| `netlify/functions/portal-action.js` | Suspend, reactivate, cancel POST `/api/portal-action` |
| `netlify/functions/portal-recover.js` | Forgot password POST `/api/portal-recover` |
| `netlify/functions/portal-password.js` | Change password POST `/api/portal-password` |
| `netlify/functions/customer-admin.js` | New customer, resend, regenerate link, manual schedule POST `/api/customer-admin` |
| `netlify/functions/coverage-schedule.js` | Daily warnings and auto-cancel |
| `netlify/functions/help-assistant.js` | Help desk POST `/api/help-assistant` |
| `portal.js`, `portal.css` | Customer portal UI |
| `supabase/migrations/20261114120000_customer_portal.sql` | Roles, RLS, coverage functions, Brenden seed |
| `netlify/functions/_lib.js` | Shared CORS + Supabase helper |
| `DockaFI_Process_Guide.docx` | Download from Help |

**Not in this repo (and not invented here):** Stripe webhooks, partner purchase-page writers, `dockafi_backup.py`, Tello integration. Orders land in `orders_queue` from elsewhere.

### SPA → `/api/*`

- `GET /api/portal-account`, `POST /api/portal-action`, `POST /api/portal-recover`, `POST /api/portal-password` — customer portal.
- `POST /api/customer-admin` — operator new customer, resend password email, regenerate a reset link, or `run_schedule`.
- `POST /api/submit-request` — legacy email + IMEI last 5 request. The portal no longer uses it.
- `POST /api/help-assistant` — ops help desk. Uses Claude when `ANTHROPIC_API_KEY` is set; otherwise answers from the embedded operations guide. The SPA also falls back locally if the function is missing.

### SPA → Supabase (PostgREST)

Tables: `devices`, `sim_cards`, `end_users`, `organizations`, `device_enduser`, `subscriptions`, `service_requests`, `orders_queue`.

Also present in the DB but unused by this SPA: `device_assignments`, `invoices`, `support_tickets`.

No public RPCs.

Auth: email/password against Supabase Auth (`/auth/v1/token`, `/auth/v1/signup`). Session is stored in `localStorage` and refreshed with the refresh token.

## Customer portal

Customers sign in at `/?portal=1` with email and password. They see their name, email, device IMEI, data plan, and coverage (Active, Suspended, or Canceled). Amounts are not shown. Suspend, reactivate, and cancel apply immediately in the platform. Suspend pauses billing (`subscriptions.status = suspended`, `next_billing_date` cleared) and sets an auto-cancel date six months out in America/New_York. Cancel means a new SIM is required to restart. Each action saves an email draft for the operator and inserts a `service_requests` row so the Tello change can be marked actioned.

New customer accounts use the starting password in `PORTAL_DEFAULT_PASSWORD` (default `Dockafi1234`). The welcome draft includes the login URL, email, and that password. After sign-in the portal asks them to change it and keeps asking until they do. Skipping it does not lock the page. Forgot password and Resend password email save a recovery-link draft. Those links last about an hour. Email drafts can regenerate one.

Nothing is emailed automatically. Drafts live in `email_drafts` and show under Email drafts, with a count of unsent drafts. An operator copies the body or opens it in a mail app and sends it from support@dockafi.com, then marks it sent or discards it. Set `PORTAL_SEND_EMAIL=true` only if Resend or SMTP is also configured and that send path should be on.

The daily Netlify function `coverage-schedule` (13:00 UTC) saves warning drafts 30, 7, and 1 days before auto-cancel, then cancels the line and saves the operator and customer drafts. It runs on the published production deploy. A deploy preview can use the Netlify **Run now** button, or an operator session can POST `/api/customer-admin` with `{ "action": "run_schedule" }`.

Operator accounts are `joeamilam@gmail.com` and `heath@isomelectric.com`. The migration writes those rows into `user_roles` before it removes blanket `authenticated` access, so the console keeps working for them. Public signup is closed by a trigger on `auth.users`. The console no longer offers Create admin account.

Brenden Milstead (`brendenmilstead@yahoo.com`, device `9b5f038d-009f-4d49-a976-d5422621fef9`, IMEI `861157040036945`) is seeded with an active link, a `50 GB Monthly` subscription, a login whose password is `Dockafi1234`, and a welcome draft. Craig Isom's two cancelled links on that device are left in place. The seed does not send email. That seed password stays `Dockafi1234` even if `PORTAL_DEFAULT_PASSWORD` is changed later.

## Security notes (do not rotate without Joe)

- The anon key stays in the SPA. After the migration it cannot read devices, end users, SIMs, or subscriptions. `anon` can still INSERT `orders_queue` for the partner checkout.
- Customers can read only their own end user, device link, device, and subscription. They cannot update those rows. Coverage changes and password changes go through service-role functions.
- Customers cannot read `email_drafts`. Operators can.
- SIM activation codes are not returned to the portal.
- `SUPABASE_SERVICE_ROLE_KEY` is required on Netlify and must not be added to the SPA. The starting password is read on the server, not written into the customer page.
- Authorization uses `user_roles` and `app_metadata.role`. It does not trust `user_metadata`.

Set on the Netlify site (never commit):

```
SUPABASE_URL
SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
# optional:
PORTAL_DEFAULT_PASSWORD
PORTAL_SITE_URL
CRON_SECRET
ADMIN_NOTIFY_EMAIL
PORTAL_SEND_EMAIL
ANTHROPIC_API_KEY
```

## After merge (do not apply before approval)

1. In the Supabase SQL editor, or with the CLI, apply `supabase/migrations/20261114120000_customer_portal.sql` to project `ldgbghjjzbhtrgdnmlmv`.
2. Confirm `user_roles` has admin rows for Joe and Heath. Confirm Brenden has an end user, an active device link, a subscription, an Auth user with password `Dockafi1234` and `must_change_password`, and one welcome draft. No email is sent.
3. Set the Netlify env vars above and redeploy so the functions pick them up.
4. In Supabase Auth → Sign In / Providers, turn off **Allow new users to sign up**. The migration trigger already blocks public signup; this makes the API error clearer.
5. In Auth → URL configuration, allow `https://dockafiplatform.netlify.app/?portal=1`.
6. Joe can sign in as Brenden at `/?portal=1` with `Dockafi1234`, then change the password. Send the welcome draft from Email drafts when he is ready. Do not email Brenden until then.

## Local check

This is a static SPA. After a deploy, Netlify must pick up `netlify/functions`.

```bash
python3 -m http.server 4173
# Admin: http://127.0.0.1:4173/
# Portal: http://127.0.0.1:4173/?portal=1
# Functions only work on Netlify (or `netlify dev` with env vars).
```

## Org soft-delete

Postgres CHECK on `organizations.type` only allows `manufacturer | distributor | reseller`. The UI now marks deleted orgs in `notes` as `[DOCKAFI_DELETED orig:<type>]` instead of writing `type='deleted'` (which always failed).
