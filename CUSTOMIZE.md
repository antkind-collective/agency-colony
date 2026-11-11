# Making Colony yours

Colony is built so you can leave out what you don't use. You don't need to know how to code to change the rest.

## What you can skip

Everything below is optional. Leave it unticked during setup and Colony carries on without it.

| Feature | If you skip it | To add it later, set these in Netlify |
|---|---|---|
| Email (Resend) | Colony sends no emails. People see updates in the app. Email sign-in links won't work, so use Google sign-in. | `RESEND_API_KEY`, `EMAIL_SENDER` |
| AI summaries (Anthropic) | Analytics still work. The written summaries don't appear. | `ANTHROPIC_API_KEY` |
| Slack | Colony doesn't check whether joiners are on Slack. | `SLACK_BOT_TOKEN` |
| Papersign | You handle hiring agreements yourself and mark each step done in Colony. | `PAPERSIGN_API_TOKEN`, `PAPERSIGN_WEBHOOK_KEY` (any long random text) |
| Google Workspace | You create work email accounts yourself, wherever you host email, and record them in Colony. | `GOOGLE_SA_JSON`, `GOOGLE_ADMIN_IMPERSONATE` |

To add one later, open your site in Netlify, go to **Project configuration > Environment variables**, add the values, then go to **Deploys > Trigger deploy**.

## Which email address you need

Colony treats everyone at your email's domain as staff. So it needs a domain that belongs to your company, like `yourcompany.com`.

- **You don't need Google Workspace.** Any email provider works. People can sign in with an emailed link, which needs the Email feature.
- **Plain Gmail, Outlook or Yahoo addresses are refused.** Anyone in the world with a Gmail address would count as your staff.
- **No company domain?** The simplest route is to buy one, usually about $10 to $15 a year. Otherwise see "My team only uses Gmail" below.

## Change anything with an AI coding tool

You can describe a change in plain words and let an AI coding tool make it. Any of them works, for example [Claude Code](https://claude.com/claude-code), [Cursor](https://cursor.com), [OpenAI Codex](https://openai.com/codex) or [GitHub Copilot](https://github.com/features/copilot). Most need an account with that company.

When you pressed Deploy, Netlify put your own copy of Colony in your GitHub account. Any change saved there goes live by itself in about 2 minutes.

1. Install the tool you like and sign in.
2. Tell it: *"Download my GitHub repo called [your repo name] and open it."*
3. Say what you want, in plain words. This repo includes an `AGENTS.md` file that tells these tools how Colony works and what to be careful with.
4. Ask it: *"Run the tests and explain what you changed."*
5. When you're happy, say: *"Push it."* Then wait 2 minutes and refresh Colony.

If a change goes wrong, open **Deploys** in Netlify, pick the last one that worked and press **Publish deploy**.

### Things you can ask for

- "We don't hire through Colony. Remove the Hiring section from the menu."
- "We don't use Papersign. Remove every mention of it from the screens."
- "Change our leave policy to 24 days a year."
- "Rename Deal Flow to Pipeline."
- "Change the main colour to dark green."
- "We send email through Postmark, not Resend. Switch it."

### If a change touches the database

Your database doesn't update by itself when the code does. If the tool writes a new migration, ask: *"Give me the SQL to paste into Supabase."* Then paste it into **SQL Editor** in your Supabase project and press Run.

### My team only uses Gmail

This is a bigger change, because Colony's access rules are built around a company domain. Done carelessly, it would let strangers in. Try it on a separate test copy first, and give your tool this:

> My team uses personal Gmail addresses and we have no company domain. Change Colony so staff are invite-only: only addresses an admin has added can sign in as staff, and nobody can create their own staff profile. Find every place that decides staff by email domain, in the app and in the database migrations. Add tests proving a stranger with a Gmail address gets no access to any data. Show me the plan before you change anything.
