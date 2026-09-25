---
name: eatfirst-order
description: "Log in to EatFirst (eatfirst.com, en-AU) and place the user's canteen order from their saved preferences. Use when asked to order lunch, place the EatFirst order, or when a Routine fires with 'order from EatFirst'. Triggers on: 'eatfirst', 'order lunch', 'place my order', 'canteen order'."
---

# EatFirst Order

Place the user's EatFirst canteen order using the Playwright script in this skill's `scripts/`
directory. The script is deterministic where it can be and hands over to you with diagnostics
where the site's markup doesn't match. Never place the same order twice.

## Preflight (stop and report if any fails)

1. `EATFIRST_EMAIL` and `EATFIRST_PASSWORD` must be set in the environment. Never print, log, or
   echo them. If missing, tell the user to add them as environment variables in the cloud
   environment settings and stop.
2. `order.json` must exist next to this file. If only `order.example.json` exists, tell the user
   to copy it to `order.json` with their real preferences and stop.
3. The site must be reachable: `curl -sS -o /dev/null -w '%{http_code}' https://www.eatfirst.com/`.
   A `000` with a "CONNECT tunnel failed" error means the environment's network policy denies
   `www.eatfirst.com`. Tell the user to add that domain to the environment's allowed domains and
   stop.
4. Playwright must resolve: `node -e "require('playwright')"` from this directory, or the
   pre-installed copy under `/opt/node22/lib/node_modules`. If neither, run `npm install` here.

## Place the order

From this skill's directory:

```bash
node scripts/eatfirst.mjs order --config order.json
```

- Exit code 0 with `ORDER PLACED: <item>` means done. Report the item and the confirmation
  screenshot path from `artifacts/`.
- Exit code 0 with `an order for "<day>" already exists` means nothing to do. Report that.
- Exit code 1 means the script could not finish. Read the newest `artifacts/*-failure.aria.txt`
  and `*-failure.png` and continue by hand (next section).

## Finishing by hand

The ARIA snapshot shows the page the script stopped on. Drive the rest with a short Playwright
script of your own (import from the same `playwright` module, reuse
`eatfirst-storage-state.json` as `storageState` so you're already logged in), following the
order of preference in `order.json`. Rules:

- Before adding anything, check the orders page (`ordersUrl` in the config) for an existing
  order on the target day. If one exists, stop and report it.
- Add exactly one item, from the `items` list in preference order, at the configured quantity.
- Take a screenshot before the final confirm and one after. Confirm only if the cart matches the
  configuration. If anything looks off (wrong item, wrong day, unexpected price, an upsell
  modal), stop before confirming and report what you saw.
- Once a selector you found by hand works, update `scripts/eatfirst.mjs` to use it so the next
  run is deterministic. Mention the change in your report.

## Report

One short message: what was ordered (or why nothing was), the day, and the path to the
confirmation screenshot. Do not include credentials or the full ARIA snapshot.
