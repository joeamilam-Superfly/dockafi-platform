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
| `netlify/functions/customer-admin.js` | Invite, resend, manual schedule POST `/api/customer-admin` |
| `netlify/functions/coverage-schedule.js` | Daily warnings and auto-cancel |
| `netlify/functions/help-assistant.js` | Help desk POST `/api/help-assistant` |
| `portal.js`, `portal.css` | Customer portal UI |
| `supabase/migrations/20261114120000_customer_portal.sql` | Roles, RLS, coverage functions, Brenden seed |
| `netlify/functions/_lib.js` | Shared CORS + Supabase helper |
| `DockaFI_Process_Guide.docx` | Download from Help |

**Not in this repo (and not invented here):** Stripe webhooks, partner purchase-page writers, `dockafi_backup.py`, Tello integration. Orders land in `orders_queue` from elsewhere.

### SPA → `/api/*`

- `GET /api/portal-account`, `POST /api/portal-action`, `POST /api/portal-recover` — signed-in customer portal.
- `POST /api/customer-admin` — operator invite, resend password email, or `run_schedule`.
- `POST /api/submit-request` — legacy email + IMEI last 5 request. The portal no longer uses it.
- `POST /api/help-assistant` — ops help desk. Uses Claude when `ANTHROPIC_API_KEY` is set; otherwise answers from the embedded operations guide. The SPA also falls back locally if the function is missing.

### SPA → Supabase (PostgREST)

Tables: `devices`, `sim_cards`, `end_users`, `organizations`, `device_enduser`, `subscriptions`, `service_requests`, `orders_queue`.

Also present in the DB but unused by this SPA: `device_assignments`, `invoices`, `support_tickets`.

No public RPCs.

Auth: email/password against Supabase Auth (`/auth/v1/token`, `/auth/v1/signup`). Session is stored in `localStorage` and refreshed with the refresh token.

## Customer portal

Customers sign in at `/?portal=1` with email and password. They see their name, email, device IMEI, data plan, and coverage (Active, Suspended, or Canceled). Suspend, reactivate, and cancel apply immediately in the platform. Suspend pauses billing (`subscriptions.status = suspended`, `next_billing_date` cleared) and sets an auto-cancel date six months out in America/New_York. Cancel means a new SIM is required to restart. Each action emails the operator and inserts a `service_requests` row so the Tello change can be marked actioned.

The daily Netlify function `coverage-schedule` (13:00 UTC) emails suspended customers 30, 7, and 1 days before auto-cancel, then cancels the line and emails the operator. It runs on the published production deploy. A deploy preview can use the Netlify **Run now** button, or an operator session can POST `/api/customer-admin` with `{ "action": "run_schedule" }`.

Operator accounts are `joeamilam@gmail.com` and `heath@isomelectric.com`. The migration writes those rows into `user_roles` before it removes blanket `authenticated` access, so the console keeps working for them. Public signup is closed by a trigger on `auth.users`. The console no longer offers Create admin account.

Brenden Milstead (`brendenmilstead@yahoo.com`, device `9b5f038d-009f-4d49-a976-d5422621fef9`, IMEI `861157040036945`) is seeded with an active link and a `50 GB Monthly` subscription at the ledger default of **$60**. Craig Isom's two cancelled links on that device are left in place. The seed does not create a login and does not send email.

## Security notes (do not rotate without Joe)

- The anon key stays in the SPA. After the migration it cannot read devices, end users, SIMs, or subscriptions. `anon` can still INSERT `orders_queue` for the partner checkout.
- Customers can read only their own end user, device link, device, and subscription. They cannot update those rows. Coverage changes go through service-role functions.
- SIM activation codes are not returned to the portal.
- `SUPABASE_SERVICE_ROLE_KEY` is required on Netlify and must not be added to the SPA.
- Authorization uses `user_roles` and `app_metadata.role`. It does not trust `user_metadata`.

Auth email on this project was not readable from Postgres (custom SMTP is a GoTrue setting, not a table). The built-in Supabase mailer only delivers to organization members and is rate-limited, and it cannot send the Tello or warning mail. This portal generates reset and invite links with the admin API and sends them with Resend or SMTP. Set one of those before inviting Brenden. Also add `https://dockafiplatform.netlify.app/?portal=1` under Authentication → URL configuration if it is not already allowed.

Set on the Netlify site (never commit):

```
SUPABASE_URL
SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
RESEND_API_KEY
RESEND_FROM
# or SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
# optional:
ADMIN_NOTIFY_EMAIL
CRON_SECRET
PORTAL_SITE_URL
ANTHROPIC_API_KEY
```

## After merge (do not apply before approval)

1. In the Supabase SQL editor, or with the CLI, apply `supabase/migrations/20261114120000_customer_portal.sql` to project `ldgbghjjzbhtrgdnmlmv`.
2. Confirm `user_roles` has admin rows for Joe and Heath, and that Brenden has an end user, an active device link, and a subscription — and no Auth user yet.
3. Set the Netlify env vars above and redeploy so the functions pick them up.
4. In Supabase Auth → Sign In / Providers, turn off **Allow new users to sign up**. The migration trigger already blocks public signup; this makes the API error clearer.
5. In Auth → URL configuration, allow `https://dockafiplatform.netlify.app/?portal=1`.
6. When Joe is ready, open End users and use **Resend password email** on Brenden Milstead. That sends the first invite. Do not do this until Resend or SMTP is set, unless you intend to copy the one-time setup link the console shows when email is not configured.
7. Confirm the $60 monthly amount or edit it on the subscription. The data plan name comes from the SIM (`50 GB Monthly`).

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
