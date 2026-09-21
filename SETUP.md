# Setup Guide

Everything needed to run your own Agency Colony instance.

> Most operational settings live in the **database** and are editable in the app (Admin Settings → Operational Config). You only edit code for the initial bootstrap. See [Configuration](#6-configuration).

Sections 1–8 get you a working app. Sections 9–12 are optional integrations; each switches itself on when its settings are present and stays out of the way when they aren't.

---

## 1. Create a Supabase project

1. Go to [supabase.com](https://supabase.com) and create a project
2. From **Settings → API**, note your:
   - **Project URL** (`https://your-project-ref.supabase.co`)
   - **anon/public key** (safe in the browser — row-level security protects your data)
   - **service_role key** (secret — server-side only, never commit it)

## 2. Run the database migrations

Run every file in `supabase/migrations/` **in alphabetical order**:

- **Supabase Dashboard** → SQL Editor → paste and run each file, or
- **Supabase CLI** → `supabase db push` (after linking your project)

They create 49 tables with **157 row-level security policies**, covering:

- employees, departments, clients, projects, allocations, client scoping
- the leave system (requests, balances, April–March cycles, half-days, holidays)
- daily, weekly and monthly-repeating tasks, and task streaks
- deals and stage history
- client analytics (LinkedIn, Instagram, Facebook, community) and a per-file upload log
- hiring: hires, offer terms, the candidate checklist, stage history, contracts
- client briefs: deliverables, turnaround promises, status history, comments
- invoices, policies, onboarding, feature requests, notifications
- configuration kept in the database: `access_overrides`, `app_config`, `public_holidays`

Access is **closed by default**: internal helper functions live in a private schema signed-in users can't reach, and a database trigger rejects any change that would leave an undeclared function callable. If you add a function the browser must call, declare it in `app_private.callable_definer_functions` before granting it — the migrations show how.

The migrations are schema plus a **placeholder bootstrap**: they seed the departments and a few placeholder accounts (`admin@youragency.com`, `strategy-lead@…`, `creative-lead@…`, `am-lead@…`, finance) so the first sign-in has a superadmin to attach to. Change those emails to your real ones **before running the migrations** (search-replace `youragency.com`), or delete the seeded rows afterwards. No client data, no real people.

## 3. Set up Google sign-in

1. In [Google Cloud Console](https://console.cloud.google.com) → **APIs & Services → Credentials**
2. Create an **OAuth 2.0 Client ID** (Web application)
3. Add your Supabase callback as an authorised redirect URI:
   ```
   https://your-project-ref.supabase.co/auth/v1/callback
   ```
4. In Supabase → **Authentication → Providers → Google**: enable it, paste the Client ID and Secret
5. Restrict to your Google Workspace domain if you want sign-in limited to your team

> The app uses the **PKCE** flow. Don't switch to implicit — it breaks token refresh across tabs.

## 4. Environment variables

```bash
cp .env.example .env
```

The first block is required. Everything under *Optional integrations* in `.env.example` can stay unset until you want that feature.

```
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_ANON_KEY=your_supabase_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key
EMAIL_SENDER=noreply@youragency.com
APP_BASE_URL=https://app.youragency.com
```

For Netlify, set the same values in **Site settings → Environment variables**.

> **Netlify caps every environment variable at 4KB.** One oversized value fails the whole deploy at the function-upload step, with an error that doesn't name the variable. The usual culprit is a Google service-account key — see [section 11](#11-google-workspace-optional).

## 5. Run it locally

```bash
npm install
npm test        # should be green
netlify dev     # serves the app and functions at http://localhost:8888
```

`npm test` runs the logic tests anywhere. It also includes **live security checks** against your own database — every table has row-level security, anonymous users reach nothing, hiring and pay data stay with the people who handle hiring. They're skipped until your `.env` has `SUPABASE_ACCESS_TOKEN` and `SUPABASE_PROJECT_REF`; once it does, treat a red result as "don't deploy".

`netlify dev` serves `/api/runtime-config` from your `.env`, so the browser never needs hardcoded keys.

## 6. Configuration

### Bootstrap (in code — `js/config.js`)

Edit these once so you can sign in as an admin:

```js
const ENFORCED_ACCESS_BY_EMAIL = {
  'admin@youragency.com': 'admin',
  'creative-lead@youragency.com': 'leadership',
};
const SUPERADMIN_EMAIL = 'admin@youragency.com';
const ANT_DOMAIN = '@youragency.com';           // your email domain
const WORK_HOURS_PER_WEEK = 45;                 // your working week
```

Also set your domain in `supabase/migrations/202602230001_init_agency_colony.sql` (`is_agency_email`) before running it.

### Everything else (in the app — no deploys)

Once you're signed in as superadmin, **Admin Settings** manages:

| Setting | What it does |
|---|---|
| Full-access users | who is leadership or admin |
| Team approver | department → leave approver |
| Direct manager | per-person overrides (take precedence) |
| Setup approvers | who approves new joiners' setup and switches them on |
| Brief reviewers | who can lock, approve and manage client briefs |
| Invoice-excluded | who's exempt from invoice reminders |
| Hidden employees | keep access, hide from team views |
| Deal-flow viewers | non-leadership people who can see Deal Flow |
| Public holidays | the yearly list — every date Colony proposes or judges skips these |

Two lists are deliberately **not** editable in the app, because they decide who sees pay:

- **Invoice viewers** — `INVOICE_VIEWER_EMAILS` in `js/config.js`. Kept in code so access to invoices can't be widened by a mis-click.
- **Hiring crew** — who sees the Hiring page and offer terms beyond leadership, typically legal and finance. Set `HIRING_CREW_EMAILS` in `js/config.js`, or the `hiring_crew_emails` row in `app.app_config`. The database enforces it through `app.is_hiring_crew()`.

Each falls back to the `js/config.js` constant when unset, so the app works before you touch any of it. Client audience personas live on each client and are edited by its account lead on the client's Audience tab.

## 7. Branding

Replace in `assets/`: `favicon.svg`, `favicon-32.png`, `favicon-192.png`, `wordmark-the.svg`, `wordmark-text.svg`, `ant-icon.svg`.
Update the page title and splash text in `index.html`.
`assets/analytics-ant.png` is used in the task-nudge email — swap it, and the copy in `netlify/functions/task-nudge.js`, for something your team finds funny.

## 8. Deploy

1. Push to a Git repo
2. Connect it to Netlify
3. Set the environment variables
4. Deploy — there's **no build step**; the root is served as-is

`netlify.toml` configures static serving, `/api/*` → functions, cache headers, and the scheduled functions:

| Job | When (UTC) | What |
|---|---|---|
| `daily-reminders` | 04:30 daily | pending-leave digest, birthdays, leave cycle rollover |
| `task-nudge` | every 30 min | nudges people at 11am *their* time, only if they haven't touched their tasks |
| `scheduled-activation` | 04:00 daily | switches on new joiners whose start date has arrived |
| `brief-deadline-reminder` | 04:30 daily | reminders before brief deliverables are due |
| `brief-approval-nudge` | 05:00 daily | chases briefs waiting on the client's approval |
| `brief-pickup-nudge` | 05:15 daily | chases approved briefs nobody has picked up |
| `invoice-reminder` | 04:30 daily | consultants' invoice uploads, from the 25th |
| `policy-update-reminder` | Mon 04:30 | annual policy review |
| `analytics-upload-reminder` | Tue 04:30 | per-client analytics staleness, retainers only |

Adjust the times for your timezone.

> **Scheduled functions gotcha:** they're invoked over HTTP POST by Netlify's scheduler, so never guard them on `event.httpMethod` — that silently kills every cron. They guard on the `next_run` payload instead. Every run writes a heartbeat, surfaced in **Admin Settings → Scheduled Jobs Health**.

### Other hosts

The frontend is a static single-page app and runs anywhere (Vercel, Cloudflare Pages, S3). The `netlify/functions/` need porting to your platform's serverless runtime.

---

## 9. Email (optional)

Notifications use [Resend](https://resend.com): create an account, verify your sending domain, set `RESEND_API_KEY` and `EMAIL_SENDER`. Without it the app runs fine and email is skipped. Every workflow email links straight to the thing it's about.

## 10. AI insights (optional)

The analytics insight buttons, and reading screenshots inside newsletter reports, call Claude via `netlify/functions/analyze-analytics.js`. Set `ANTHROPIC_API_KEY` to enable them; without it the rest of analytics works normally.

## 11. Google Workspace (optional)

Two features share one Google service account:

- **New hires' accounts** — create a hire's Google Workspace account from their Hiring checklist. Create-only: Colony never deletes, suspends or edits a Google user, and `tests/workspace-create-only.test.mjs` fails the build if code that could is ever added. It generates a one-time password, emails it to the hire once, and never stores or logs it.
- **Read-only copies in Drive** — each policy page becomes a Google Doc, updated in place on every save so Drive's version history holds each edit, and each signed agreement lands as a PDF. Every copy is locked, so it can't be edited in Drive; your app stays the place to edit.

Set-up:

1. In Google Cloud, enable the **Admin SDK API** and the **Google Drive API** for your project.
2. Create a **service account** and download a JSON key.
3. In the Google Admin console → **Security → API controls → Domain-wide delegation**, add the service account's client ID with these scopes, one per line:
   ```
   https://www.googleapis.com/auth/admin.directory.user
   https://www.googleapis.com/auth/drive
   ```
4. Set two environment variables. **Store only the two fields below** — a full key file is over Netlify's 4KB limit and will fail the deploy:
   ```
   GOOGLE_SA_JSON={"client_email":"colony@your-project.iam.gserviceaccount.com","private_key":"-----BEGIN PRIVATE KEY-----\n…"}
   GOOGLE_ADMIN_IMPERSONATE=admin@youragency.com
   ```
   The second is a Workspace super-admin the service account acts as.
5. For Drive copies, tell Colony which folder to use:
   ```sql
   insert into app.app_config (key, value)
   values ('drive_mirror_folder_id', to_jsonb('YOUR_DRIVE_FOLDER_ID'::text))
   on conflict (key) do update set value = excluded.value;
   ```

## 12. Papersign contracts (optional)

Employment and consulting agreements go from draft to signed PDF through [Papersign](https://paperform.co/products/papersign/). Sending documents through its API needs a paid plan.

1. **Templates.** Upload each agreement to Papersign as a template, and mark the fill-in spots with these variable keys:

   `hire_name` · `start_date` · `notice_period_days` · `compensation` · `compensation_label` · `scope_of_work` · `designation` · `current_address` · `permanent_address` · `pan`

   Give each template two signer roles: the hire, and your agency's signer.

2. **Tell Colony which template each hire type uses**, and the key of each signer role in it:
   ```sql
   insert into app.app_config (key, value) values ('papersign_templates', '{
     "full-time":  { "document_id": "…", "signer_hire_key": "…", "signer_agency_key": "…" },
     "consultant": { "document_id": "…", "signer_hire_key": "…", "signer_agency_key": "…" },
     "fractional": { "document_id": "…", "signer_hire_key": "…", "signer_agency_key": "…" }
   }'::jsonb) on conflict (key) do update set value = excluded.value;
   ```
   A hire type with no entry simply keeps the manual upload path.

3. **Environment variables:**
   ```
   PAPERSIGN_API_TOKEN=…
   PAPERSIGN_WEBHOOK_KEY=a_long_random_string
   PAPERSIGN_SIGNER_NAME=Your Name              # signs for the agency on every agreement
   PAPERSIGN_SIGNER_EMAIL=you@youragency.com
   PAPERSIGN_FINANCE_EMAIL=finance@youragency.com  # told what to set up once it's signed
   PAPERSIGN_FINANCE_NAME=Finance
   PAPERSIGN_NOTIFY_CC=you@youragency.com       # comma-separated
   ```

4. **Webhook.** In Papersign, add a folder webhook for **Document completed** pointing at:
   ```
   https://app.youragency.com/api/papersign-webhook?key=YOUR_PAPERSIGN_WEBHOOK_KEY
   ```
   Papersign's folder webhooks carry no signature, so this key is the only thing stopping anyone else posting a fake "signed" event. Make it long and random; Colony compares it in constant time.

On a hire, **Draft in Papersign** fills the template from what Colony already knows, legal reviews it in Papersign, **Approve and send** sends it for signature with reminders, and on completion the signed PDF is filed against the hire and finance is emailed.

---

## First run checklist

1. Migrations applied
2. Google sign-in working, domain restricted
3. `js/config.js`: superadmin email and domain set
4. Sign in — your profile bootstraps automatically
5. Admin Settings → add your team, departments and holidays; set the hiring crew in `js/config.js`
6. `npm test` green, including the live security checks once `.env` points at your project
7. Everyone else signs in and lands on an empty, working app
