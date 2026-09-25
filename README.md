# EatFirst order skill

Logs in to EatFirst and places, repeats or changes a canteen order, either on demand
(`/eatfirst-order`) or on a schedule through a Claude Routine. There is no static order file:

- **Repeat.** With order history, it orders what you had on the same weekday last week (or, if
  there was nothing that day, your most recent order).
- **First order.** With no history, Claude shows you the day's menu and asks what you want. On a
  Routine it can't ask, so the run stops and tells you a first order needs your choice.
- **Change.** "Change my order to X" cancels the existing order for that day and places X.
  "Cancel my order" just cancels it. Without either instruction, an existing order is left alone.

## One-off setup

1. **Credentials** — copy `.env.example` to `.env` (gitignored) and fill in `EATFIRST_EMAIL`
   and `EATFIRST_PASSWORD`. In the cloud environment, where `.env` doesn't exist, set them as
   environment variables instead (environment menu in the session title bar, then Edit). Shell
   variables take precedence over `.env`. Never commit `.env`.
2. **Network** — in the same environment settings, add `www.eatfirst.com` to the allowed domains
   (or choose a broader access level). The default policy denies it.
3. **Playwright** — cloud sessions ship Chromium and the `playwright` package. Locally, run
   `npm install && npx playwright install chromium` in this directory.

## Try it first

```bash
npm run check                                   # reports whether credentials are present (never their values)
npm run login                                   # proves the credentials and selectors work, saves the session
npm run orders -- --day today                   # prints local history and a snapshot of the orders page
npm run menu -- --day today                     # prints a snapshot of the day's menu
npm run order -- --day today --item "Chicken Katsu" --dry-run   # adds it to the cart and stops before confirming
npm run order -- --day today --item "Chicken Katsu"             # places the order
npm run order -- --day today --item "Caesar Salad" --replace    # cancels today's order, then orders the salad
npm run cancel -- --day today                   # cancels today's order
```

`--day` accepts `today` (the default), `tomorrow`, a weekday name, or `YYYY-MM-DD`, resolved in
Australia/Sydney. `--item` is matched case-insensitively as a substring of the menu item's name.
Every placed or cancelled order is appended to `order-history.json` (gitignored) as a fallback
record; the site's orders page stays the source of truth.

If a step fails, `artifacts/` gets a screenshot and an ARIA snapshot of the page it stopped on.
Use `npm run inspect -- <url>` to capture any page for selector tuning.

## Schedule it with a Routine

Ask Claude in a session that has this skill, for example:

> Create a routine named "EatFirst lunch order" that runs at 9:10am Sydney time Monday to Friday,
> starts a fresh session, and runs `/eatfirst-order`.

That maps to a fresh-session Routine with cron `CRON_TZ=Australia/Sydney 10 9 * * 1-5` and the
prompt "Run the eatfirst-order skill and place today's order." Each run repeats last week's
order for that weekday. The skill's preflight checks stop the run with a clear message if
credentials or network access are missing, and a run with no order history stops and asks you
to place the first order interactively.

## Where the skill lives

This folder is `.claude/skills/eatfirst-order/` in the ContractReview checkout, so any session on
this branch (including a fresh-session Routine) loads it. Its own `.gitignore` keeps `.env`,
`order-history.json`, the saved login session, `artifacts/` and `node_modules/` out of git. Run
the `npm` commands above from this directory.
