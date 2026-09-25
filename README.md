# EatFirst order skill

Logs in to EatFirst and places a canteen order from `order.json`, either on demand
(`/eatfirst-order`) or on a schedule through a Claude Routine.

## One-off setup

1. **Credentials** — add `EATFIRST_EMAIL` and `EATFIRST_PASSWORD` as environment variables in
   the cloud environment (environment menu in the session title bar, then Edit). Never put them
   in a file that gets committed.
2. **Network** — in the same environment settings, add `www.eatfirst.com` to the allowed domains
   (or choose a broader access level). The default policy denies it.
3. **Preferences** — copy `order.example.json` to `order.json` and list the items you want in
   order of preference. The first one on the menu gets ordered. `day` is matched
   case-insensitively against the site's day selector; leave it out to order for whatever day the
   canteen page shows by default.
4. **Playwright** — cloud sessions ship Chromium and the `playwright` package. Locally, run
   `npm install && npx playwright install chromium` in this directory.

## Try it first

```bash
npm run login            # proves the credentials and selectors work, saves the session
npm run order:dry-run    # adds the item to the cart and stops before confirming
npm run order            # places the order
```

If a step fails, `artifacts/` gets a screenshot and an ARIA snapshot of the page it stopped on.
Use `npm run inspect -- <url>` to capture any page for selector tuning.

## Schedule it with a Routine

Ask Claude in a session that has this skill, for example:

> Create a routine named "EatFirst lunch order" that runs at 9:10am Sydney time Monday to Friday,
> starts a fresh session, and runs `/eatfirst-order`.

That maps to a fresh-session Routine with cron `CRON_TZ=Australia/Sydney 10 9 * * 1-5` and the
prompt "Run the eatfirst-order skill and place today's order." The skill's preflight checks stop
the run with a clear message if credentials, network access or `order.json` are missing.

## Where the skill lives

This folder is `.claude/skills/eatfirst-order/` in the ContractReview checkout, so any session on
this branch (including a fresh-session Routine) loads it. Its own `.gitignore` keeps `order.json`,
the saved login session, `artifacts/` and `node_modules/` out of git. Run the `npm` commands above
from this directory.
