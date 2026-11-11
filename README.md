# Agency Colony

**The tool a small agency runs on.** Who's working on what, who's on leave, what's in the pipeline, who's joining next month, and how your clients' channels are actually doing — in one place, instead of eight spreadsheets nobody updates.

Free and open source. Built for a real agency of about twenty people, and used there every day.

## Get your own, in about 10 minutes

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/antkind-collective/agency-colony)

1. Press the button and sign in to Netlify with GitHub. It copies Colony to your account and puts it online.
2. Open your new site. A setup page appears.
3. Paste two tokens (the page shows where to get them), enter your company name and email, and tick only the tools you use.

Colony builds its own database and connects everything. There is no code to edit and nothing to install. Netlify and Supabase both have free plans.

Don't use Papersign, Slack, Google Workspace or AI? Skip them. To change anything else without coding, see [CUSTOMIZE.md](CUSTOMIZE.md).

Prefer to do it by hand? See [SETUP.md](SETUP.md).

---

## The problem it solves

Most small agencies run on a pile of spreadsheets:

- an **allocation sheet** that's three weeks out of date
- a **leave tracker** only one person maintains
- a **BD pipeline** doc that lives in someone's Drive
- **task lists** scattered across five different tools
- **client analytics** rebuilt by hand into a deck every month
- **hiring paperwork** chased over email: a form here, a contract there, a Google account someone forgot to create

None of them talk to each other. By the time leadership asks "who's free next week?" or "is the new hire's contract signed?", the honest answer is "let me check three files and ask two people."

Colony puts all of it in one app — and, more importantly, makes it worth updating. It nudges the people who forget, fills things in for you where it can, and tells you when its own data has gone stale instead of quietly showing you March's numbers in July.

---

## What it actually looks like

**Monday morning.** You open My Work and type your tasks for the week, each tagged to a client. Then you open My Allocation and hit *"Suggest from tasks"* — it reads what you just wrote and fills in your split. You adjust and save. That took a minute, not fifteen. Your streak on the home page ticks up.

**You need Friday off.** You request it in My Leave. It routes to your manager — only your manager — who gets an email and approves it. It shows on the team calendar, on everyone's home screen, and your balance updates. Half-days count as half.

**You're hiring.** You open the hire with the role, the start date and the pay. The candidate gets a checklist for their details and documents. The contract is drafted from your template in Papersign, reviewed, sent, signed — and the signed PDF files itself against the hire. Finance is told what to set up and from when. Their Google account is created from inside Colony. On their start date they're switched on. Nobody chased anybody.

**A deal closes.** Your BD lead drags it to *Contracted* in Deal Flow. It becomes a client automatically. When the engagement ends, archiving the client closes the deal properly — so your pipeline never lies about what's active.

**Reporting time.** Your account manager drags in the client's LinkedIn, Instagram and Facebook exports. Colony parses them, charts them, compares them against the period you pick, and — if you want — writes you a short, skimmable read of what happened, with real numbers, to paste straight into the client email.

**You, on a Tuesday.** You open Agency Overview and see who's over capacity, who's under, whose numbers moved, and which client's data hasn't been touched in six weeks — without asking anyone.

---

## The screens

| | |
|---|---|
| **Home** | your day: tasks due, who's out, what the team shipped, your streak |
| **Agency Overview** | leadership's bird's-eye: capacity, pipeline, activity |
| **Deal Flow** | BD pipeline, drag-and-drop, closes into real clients |
| **Resource Planner** | the team grid — who's booked, who's free, what's gone stale |
| **My Work** | daily tasks, weekly backlog, weekly and monthly repeats, auto carry-forward |
| **My Allocation** | your week's split, suggested from your own tasks |
| **My Leave** | requests, approvals, balances, half-days |
| **Team Directory** | people, profiles, designations, reporting lines, utilisation |
| **Hiring** | every open hire as one checklist, each step with a named owner |
| **Clients** | who they are, who's on them, what's in scope, how they're doing |
| **Client Analytics** | LinkedIn, Instagram, Facebook and newsletter, with AI insights |
| **Briefs** | client creative briefs on an internal board, with deadlines and reminders |
| **Invoice Center** | monthly uploads from consultants, tracked |
| **Policy** | company policies, who's acknowledged them, a read-only copy in Drive |
| **Bugs & Features** | your team's requests, with replies and notifications |

---

## Hiring, start to finish

Hiring used to be the part of running an agency that lived entirely in email. It's now a page, and every hire on it is one checklist where each step has a named owner — so it's always obvious what's next and whose move it is.

| Step | Who | What happens |
|---|---|---|
| **Open the hire** | hiring lead | name, start date, designation, who they report to, notice period, and the pay: an annual CTC for full-time staff, a monthly fee for consultants and fractional people |
| **Details** | the candidate | a joining checklist: personal details, address, tax regime, salary slips, bank details |
| **Pay breakup** | finance | full-time hires only: each salary component entered in Colony, checked against the CTC, and printed into the agreement's annexure — consultants and fractional people invoice |
| **Agreement** | legal | drafted from your template in Papersign, reviewed, then sent |
| **Signed by both** | Papersign | the signed PDF is filed against the hire automatically |
| **Payroll or vendor set-up** | finance | emailed with the start date and the figure, the moment it's signed |
| **Work account** | Colony | their Google Workspace account, created from inside the app |
| **First sign-in** | the candidate | their profile arrives pre-filled — designation, manager, address — so they aren't asked twice |
| **Active from the start date** | Colony | switched on automatically that morning |

Each step emails the person whose turn it is, with a link straight to that hire — not to a list they have to search.

### Contracts through Papersign

Colony doesn't generate PDFs; it drives [Papersign](https://paperform.co/products/papersign/), so the agreement you already have stays the agreement.

1. Upload your employment and consulting agreements to Papersign once, as **templates**, and mark the fill-in spots with these variable keys: `hire_name`, `hire_email`, `start_date`, `notice_period_days`, `notice_period_words`, `compensation`, `compensation_label`, `ctc_amount`, `ctc_words`, `ctc_breakup_1` … `ctc_breakup_10`, `fee_amount`, `fee_words`, `scope_of_work`, `designation`, `department`, `current_address`, `permanent_address`, `pan`. Amounts come both ways — "₹15,00,000 per annum" and "15,00,000" / "Fifteen Lakh" — so the template's own wording reads right.
2. On a hire, **Draft in Papersign** copies the right template and fills every variable from what's already in Colony. Nothing is retyped.
3. Legal reviews the draft inside Papersign and changes whatever needs changing.
4. **Approve and send** sends it for signature to the hire and your agency's signer, with automatic reminders.
5. When both have signed, a webhook files the signed PDF against the hire, marks the step done, and emails finance what to set up and from when.

Full-time, consultant and fractional hires can each use their own template. The signer and who's told on signature are settings, not code.

### Google Workspace accounts, created — never deleted

Colony can create a new hire's Google account itself, instead of you emailing your reseller and forwarding a password. It generates a one-time password, emails it to the hire once, and never stores or logs it — Google makes them change it at first sign-in.

It can **only create**. It never deletes, suspends or edits a Google account, and a test fails the build if anyone ever adds code that tries. Removing people stays a deliberate, manual act.

---

## The analytics bit (the part people ask about)

Your team already downloads exports from LinkedIn and Meta. Colony reads those files as-is — no new habits, no API keys, no data entry.

**Drag the files in — several at once. That's the whole workflow.**

- **LinkedIn** — content, followers and visitor exports → week-on-week numbers, trends, audience breakdown, post performance
- **Instagram and Facebook** — Meta's post exports and its per-metric Insights CSVs → daily trend charts for views, reach, follows, interactions. Meta names these files identically for both platforms, so Colony asks which account an upload is from — once per upload, not once per file.
- **Newsletters and community** — per-send open and click rates, subscriber growth, member demographics. Even a Word report full of screenshots: Colony reads the screenshots, shows you what it extracted, and only saves once you've checked it.

Pick a comparison — last week, last month, the same period last year — and every tile shows the change as a percentage. Every upload is kept in an archive, labelled by platform and by who sent it.

Then, optionally, a button that reads all of it and writes you a short, skimmable brief:

> *Impressions have fallen four weeks running: 10,809 → 4,386 → 3,526 → 207. Four hiring posts on 29 May pulled 51,779 between them — structural outliers. Take them out and the real baseline is about 3,000.*

**Three things it refuses to do:**

- **Lie about freshness.** It knows what dates your data actually covers — not when someone last clicked upload. A client whose numbers stop in March says so, loudly.
- **Invent patterns.** "Mondays perform best" from two posts is noise. It won't tell you that.
- **Do its own arithmetic.** Every percentage the AI quotes is computed by Colony first and handed to it. The model writes the sentence; it never gets to make up the number.

---

## Client briefs

Clients' creative requests land on an internal board: the brief, the deliverables, the turnaround each deliverable promises, the status history and a comment thread.

- **Approval gate** — a brief can require the client's own sign-off before it reaches your team, and Colony chases it if it sits there.
- **Deadlines** — reminders before each deliverable is due, and a nudge if an approved brief sits with nobody.
- **On pause** — park a brief without losing it or its history, and without its reminders firing.
- **On behalf of** — raise a brief for someone who isn't a user.
- **Working days** — every date Colony proposes or judges skips weekends and your public holidays.

Links pasted into a brief, a comment or a feedback post are clickable. A link in a task's description turns the task's title into the link — the address itself never sits in the cell.

---

## Security: closed by default

Colony holds salaries, addresses, tax IDs and contracts, so access is decided by the database, not by what the interface chooses to hide.

- **Every table has row-level security.** 157 policies across 49 tables. The interface hiding a button is a convenience; the database refusing the query is the rule.
- **Closed by default.** Internal helper functions live in a private schema that signed-in users can't reach. Any function that *is* callable has to be declared, and a database trigger rejects a change that would leave an undeclared one exposed.
- **Checked on every test run.** A suite of live checks against your own database fails if any table lacks row-level security, if anonymous users can reach anything, or if salary and hire data become visible beyond the people who handle hiring. Red means don't deploy.
- **Server functions check who's asking**, not just that someone is signed in.
- **Personal details** — home address, emergency contact — are visible to the person themselves and to leadership, nobody else.
- **Nothing can frame the app**, so a hostile page can't trick someone into clicking a button inside it.

---

## Is this for you?

**Probably yes if:** you're a 5–50 person agency or studio, you're on Google Workspace, you're drowning in spreadsheets, and someone there can spend an afternoon setting up a Supabase project.

**Probably not if:** you need a mobile app, you want SSO beyond Google, you bill hourly and need timesheets (this tracks allocation, not hours), or you want something configurable without ever touching code.

**It's opinionated.** It was built for how one agency works — an April–March leave year, percentage-based allocation, full-time staff alongside fractional people and consultants, a superadmin who can override anything. Most of that is configurable inside the app. Some of it you'll want to change in code. It's MIT licensed, so go ahead.

---

## Try it

```bash
git clone https://github.com/antkind-collective/agency-colony.git
cd agency-colony
npm install
npm test
```

The logic tests run anywhere and should be green. A further set of live security checks runs only once you point it at your own Supabase project — until then they're skipped, not failed.

To actually run it you need a free Supabase project and Google sign-in, about 30 minutes. **[SETUP.md](SETUP.md)** walks through every step.

```bash
cp .env.example .env    # your Supabase keys
netlify dev             # → http://localhost:8888
```

---

## How it's built

Vanilla JavaScript. No framework, no bundler, **no build step** — the folder you clone is the folder that gets served.

- **Data and auth:** Supabase (PostgreSQL), Google Workspace sign-in
- **Security:** row-level security on every table, closed-by-default functions, live invariant checks — see above
- **Backend jobs:** Netlify Functions — reminders, digests, nudges, activations. Each reports a heartbeat, so a broken job shows up within a day instead of silently doing nothing for two months (ask us how we know)
- **Tests:** over the logic that matters — leave rules, allocation maths, task carry-forward, streaks, analytics parsing, the hiring checklist, access rules

Most settings — who's an admin, who approves whose leave, who reviews briefs, holidays — live in the database and are editable inside the app. You shouldn't need a deploy to onboard someone. The two lists that decide who sees pay — invoice viewers and the hiring crew — are deliberately kept out of the app.

### Integrations (all optional)

The app works without any of them; each switches itself on when its settings are present.

| | What it's for |
|---|---|
| **Resend** | email notifications |
| **Claude** | the analytics insights, and reading screenshots in newsletter reports |
| **Google Workspace** | creating new hires' accounts; read-only copies of policies and signed agreements in a Drive folder |
| **Papersign** | employment and consulting agreements, from draft to signed PDF |

---

## What's new in v2.3 (September 2026)

**Hiring.** A Hiring page where each hire is a checklist with a named owner per step. Pay captured at the start — CTC for full-time, a monthly fee for consultants and fractional people — alongside notice period, designation, scope and reporting line. A candidate joining checklist. Contracts through Papersign from draft to filed PDF. Google Workspace accounts created from the app, create-only by design. Activation on the start date. Designation, manager and address carried onto the new person's profile so they aren't asked twice.

**People.** Consultant and fractional as real employment types, with client scoping for people who work on only some clients and capacity maths that respects it. Per-person timezones, so the 11am nudge arrives at 11am wherever you are. New joiners declare their setup and get approved, or get switched on automatically on a date.

**Briefs.** An internal board for client creative requests: deliverables, turnaround promises, an approval gate, revisions, pausing, raising on someone's behalf, deadline reminders and nudges.

**Analytics.** Facebook alongside Instagram. A comparison picker with percentages on every change. Several uploads at once, with an archive labelled by platform and uploader. Newsletter reports read from screenshots. AI insights rewritten to be skimmable, with every number computed before the model sees it.

**Tasks.** Streaks on the home page, with milestones and your rank. Weekly repeating tasks alongside monthly ones. Links in a task make its title clickable.

**Everywhere.** Every email lands on the exact thing it's about, not the list it lives in. Weekends and holidays are respected wherever a date is judged. Long-open tabs learn when a new version ships. Policies and signed agreements get read-only copies in Google Drive.

**Security.** Closed-by-default access enforced in the database, live invariant checks on every test run, functions that authorise the caller, personal details restricted, and no framing. See [Security](#security-closed-by-default).

### A note on the client portal

The agency this was built for also runs a client-facing portal on the same code, and some of its screens are still in the source. It isn't packaged in this release and doesn't run out of the box. If you'd like it, open an issue.

---

## Contributing

Issues and PRs welcome — especially "I tried to set this up and got stuck at X." That's the most useful thing you can tell us.

Keep it build-step-free. Logic that can be pure belongs in `js/*.js` with a test in `tests/`. New tables need row-level security in the same migration that creates them.

## Licence

MIT — do what you like with it. See [LICENSE](LICENSE).

Made by [Antkind](https://github.com/antkind-collective).
