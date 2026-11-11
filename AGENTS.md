# Working on this copy of Colony

The person asking may not be a developer. Explain changes in plain words, and say what will change on screen before you make it.

## How it works

- Plain HTML and JavaScript front end: `index.html`, `app.js`, `js/`, `styles.css`. Server code is in `netlify/functions/`. The database is Supabase, defined in `supabase/migrations/`.
- A push to `main` deploys on Netlify in about 2 minutes. Only push when the person says so.
- `youragency.com`, `admin@youragency.com` and `Your Agency` are placeholders. `_build/apply-identity.mjs` swaps in the real company details at build time from Netlify environment variables. Leave them in the code. Don't replace them by hand.
- Optional features switch on when their Netlify environment variable is set. See `CUSTOMIZE.md`. Removing a feature from the screens is usually better than deleting its server code.

## Rules

- Run `npm install` once, then `npm test` before saying a change is done.
- Never put keys, tokens or passwords in the repo. They belong in Netlify environment variables.
- Never edit an existing migration. Add a new file in `supabase/migrations/`. Migrations don't apply themselves after install, so give the person the SQL to paste into the Supabase SQL Editor.
- Every new table needs row level security in the same migration.
- Access rules protect staff and client data. Before changing who can see or do something, explain the effect and ask.
- A failed action must show a message on screen. Never fail silently.
