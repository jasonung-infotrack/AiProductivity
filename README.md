# EatFirst order skill

Logs in to EatFirst and places, repeats or changes a canteen order, either on demand
(`/eatfirst-order`) or on a schedule through a Claude Routine. There is no static order file:

- **Repeat.** With order history, it orders what you had on the same weekday last week (or, if
  there was nothing that day, your most recent order), including the options you chose (sauce,
  sub size), which it reads from the orders dashboard.
- **First order.** With no history, Claude shows you the day's menu and asks what you want. On a
  Routine it can't ask, so the run stops and tells you a first order needs your choice.
- **Change.** "Change my order to X" cancels the existing order for that day and places X.
  "Cancel my order" just cancels it. Without either instruction, an existing order is left alone.
  Once the canteen's cut-off has passed (around 11am–noon the day before), an order can't be
  changed or cancelled.
- **Within the subsidy.** It never checks out unless the cart's "Total to pay" is 0.00 credits.
  If last week's order no longer fits, it stops and says how much would be charged; `menu` shows
  the day's subsidy and flags items that exceed it. `--allow-payment` is the only override.

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
npm run orders -- --day friday                  # lists the site's orders and what a repeat would place
npm run menu -- --day friday                    # lists the day's menu with prices and which items need options
npm run repeat -- --day friday --dry-run        # fills the cart with last week's order and stops before Checkout
npm run repeat -- --day friday                  # places it
npm run order -- --day friday --item "Mt Franklin Water (600ML)" --item "Chicken Schnitzel Salad" --option "NO SAUCE"
npm run order -- --day friday --item "Steak Melt" --option "NO SAUCE" --replace   # cancels Friday's order, then orders this
npm run cancel -- --day friday                  # cancels Friday's order
```

`--day` accepts `today` (the default), `tomorrow`, a weekday name, or `YYYY-MM-DD`, resolved in
Australia/Sydney. `--item` is the exact menu name (case-insensitive) and can repeat; `--quantity`
and `--option` apply to the `--item` before them. Every placed or cancelled order is appended to
`order-history.json` (gitignored) as a fallback record; the site's orders dashboard stays the
source of truth.

If a step fails, `artifacts/` gets a screenshot and an ARIA snapshot of the page it stopped on.
Use `npm run inspect -- <url>` to capture any page for selector tuning. The site structure the
script relies on is documented in the header of `scripts/eatfirst.mjs`.

## Schedule it with a Routine

The canteen closes orders around 11am–noon the day before, so schedule the run the day before
(or earlier) and name the day. Ask Claude in a session that has this skill, for example:

> Create a routine named "EatFirst lunch order" that runs at 9:00am Sydney time every Thursday,
> starts a fresh session, and runs `/eatfirst-order` for Friday.

That maps to a fresh-session Routine with cron `CRON_TZ=Australia/Sydney 0 9 * * 4` and the
prompt "Run the eatfirst-order skill and place Friday's order." Each run repeats last week's
Friday order. The skill's preflight checks stop the run with a clear message if credentials or
network access are missing, and a run with no order history stops and asks you to place the
first order interactively.

## Where the skill lives

This folder is `.claude/skills/eatfirst-order/` in the ContractReview checkout, so any session on
this branch (including a fresh-session Routine) loads it. Its own `.gitignore` keeps `.env`,
`order-history.json`, the saved login session, `artifacts/` and `node_modules/` out of git. Run
the `npm` commands above from this directory.
