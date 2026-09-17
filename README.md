# DockaFI management platform (OPS console)

Internal AquaEase ops SPA for **DockaFI | AquaEase** — devices, SIMs, organizations, orders, billing, and the end-user request portal.

- Live: https://dockafiplatform.netlify.app
- End-user portal: https://dockafiplatform.netlify.app/?portal=1
- Data: shared Supabase project `ldgbghjjzbhtrgdnmlmv` (data only; this repo is the console)

Do **not** put marketing/site content here. That lives in `dockafi-site`.

## Repo inventory vs what the SPA calls

| In this repo | Used by |
| --- | --- |
| `index.html` | Entire admin + portal SPA |
| `netlify.toml` | Publishes `.` and rewrites `/api/*` → `/.netlify/functions/:splat` |
| `netlify/functions/submit-request.js` | Portal POST `/api/submit-request` |
| `netlify/functions/help-assistant.js` | Help desk POST `/api/help-assistant` |
| `netlify/functions/_lib.js` | Shared CORS + Supabase helper |
| `DockaFI_Process_Guide.docx` | Download from Help |

**Not in this repo (and not invented here):** Stripe webhooks, partner purchase-page writers, `dockafi_backup.py`, Tello integration. Orders land in `orders_queue` from elsewhere.

### SPA → `/api/*`

- `POST /api/submit-request` — end-user portal. Matches **email + IMEI last 5** against an active device link, then inserts `service_requests`.
- `POST /api/help-assistant` — ops help desk. Uses Claude when `ANTHROPIC_API_KEY` is set; otherwise answers from the embedded operations guide. The SPA also falls back locally if the function is missing.

### SPA → Supabase (PostgREST)

Tables: `devices`, `sim_cards`, `end_users`, `organizations`, `device_enduser`, `subscriptions`, `service_requests`, `orders_queue`.

Also present in the DB but unused by this SPA: `device_assignments`, `invoices`, `support_tickets`.

No public RPCs.

Auth: email/password against Supabase Auth (`/auth/v1/token`, `/auth/v1/signup`). Session is stored in `localStorage` and refreshed with the refresh token.

## Security notes (do not rotate without Joe)

- The **anon/publishable key is embedded** in the SPA. That is expected for a browser client, but several RLS policies are wide open:
  - `anon` **SELECT** on `devices`, `end_users`, `device_enduser`
  - `anon` **ALL** on `sim_cards` and `subscriptions`
  - `anon` **INSERT** on `service_requests` and `orders_queue`
  - `authenticated` **ALL** on every ops table
- Public **Create admin account** hits Supabase signup. Anyone who can load the console can attempt to register.
- Tightening RLS, disabling open signup, or rotating keys is **deferred** — doing it live would break the portal and any other client sharing this project.

Set on the Netlify site (never commit):

```
SUPABASE_URL
SUPABASE_ANON_KEY
# optional, functions only:
SUPABASE_SERVICE_ROLE_KEY
ANTHROPIC_API_KEY
```

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
