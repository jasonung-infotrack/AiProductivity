---
name: eatfirst-order
description: "Log in to EatFirst (eatfirst.com, en-AU) and place, repeat or change the user's canteen order. Repeats what they ordered last week, asks them for a first order, and replaces an existing order when they want something different. Use when asked to order lunch, place or change the EatFirst order, or when a Routine fires with 'order from EatFirst'. Triggers on: 'eatfirst', 'order lunch', 'place my order', 'change my order', 'canteen order'."
---

# EatFirst Order

Place, repeat or change the user's EatFirst canteen order with the Playwright script in this
skill's `scripts/` directory. There is no static order file: the order is whatever the user had
on the same weekday last week (else their most recent order), or whatever they tell you when
they have no history or want a change. The script is deterministic against the site as verified
on 2026-09-25 and hands over to you with diagnostics where the markup no longer matches. Never
place a second order on a day that already has one; replace it only when the user asked for a
change. Never place an order that exceeds the subsidy: the cart's "Total to pay" must be 0.00
credits. The script enforces this and only `--allow-payment` overrides it; pass that only when
the user has explicitly said they will pay the difference.

## Preflight (stop and report if any fails)

1. Credentials. From this skill's directory run `node scripts/eatfirst.mjs check`. It reports
   whether `EATFIRST_EMAIL` and `EATFIRST_PASSWORD` are present, never their values, and exits 1
   if either is missing. They come from the shell environment or from a `.env` file next to this
   file (the script loads it; shell variables win). Never print, log, echo or `cat` them. If one
   is missing, ask the user to copy `.env.example` to `.env` and fill in both values themselves
   (or set them as environment variables; in the cloud environment, via the environment
   settings). Never enter or store credentials on their behalf. Stop.
2. If `check` itself fails to start because Playwright is missing, see step 4.
3. The site must be reachable: `curl -sS -o /dev/null -w '%{http_code}' https://www.eatfirst.com/`.
   A `000` with a "CONNECT tunnel failed" error means the environment's network policy denies
   `www.eatfirst.com`. Tell the user to add that domain to the environment's allowed domains and
   stop. A `000` with a schannel `CRYPT_E_NO_REVOCATION_CHECK` error is a Windows curl quirk, not
   a policy block; retry with `--ssl-no-revoke`.
4. Playwright must resolve: `node -e "require('playwright')"` from this directory, or the
   pre-installed copy under `/opt/node22/lib/node_modules`. If neither, run `npm install` here.

## Target day

`today` unless the user says otherwise ("tomorrow", a weekday name, or a `YYYY-MM-DD` date).
Pass it as `--day <day>` to every command below; the script resolves it in Australia/Sydney.
The canteen closes orders around 11am–noon on the day before, so "today" is usually too late:
a Routine should run the day before (or earlier) and name the day, e.g. `--day friday`.

## Decide what to order

Run, from this skill's directory:

```bash
node scripts/eatfirst.mjs orders --day <day>
```

It lists every order on the site's dashboard (most recent first, with chosen options in square
brackets and whether each can still be cancelled), says whether the target day already has an
order, what was ordered on the same weekday last week, and exactly what `repeat` would place.
Then pick exactly one of these:

- **The user named what they want** ("order the katsu", "change it to the salad"). Place it
  with `order --item ...` (below), whatever the history says. Items with options (sauce, sub
  size) need `--option` values; get the choices from `menu` or the item's previous orders, and
  ask the user if none are known.
- **An order already exists on the target day.**
  - The user asked to change it: place the new items with `--replace`, which cancels the
    existing order first. If they asked for a change without saying what to, show them the
    `menu` output and ask before touching anything.
  - The user only wants it cancelled: `node scripts/eatfirst.mjs cancel --day <day>`.
  - Otherwise: report what is already ordered and stop. Don't cancel, don't re-order.
  - `orders` says "cut-off passed" for it: it can't be changed or cancelled any more. Say so.
- **No order that day, and there is history:** `node scripts/eatfirst.mjs repeat --day <day>`.
  It orders the same weekday last week, else the most recent order, options included. Don't
  ask; just run it. It checks the day's menu first, and if that order's items are no longer
  offered (usually because the day's restaurant changed, e.g. Subway last week, Guzman y Gomez
  this week) it places nothing and prints `MENU CHANGED` with the day's menu: see below.
- **`orders` says `NO HISTORY`:** this is a first order. Run
  `node scripts/eatfirst.mjs menu --day <day>` and let the user pick from it (see "Let the user
  pick from the menu" below). Never guess.

## Place the order

```bash
node scripts/eatfirst.mjs repeat --day <day>                       # last week's order again
node scripts/eatfirst.mjs order --day <day> --item "Mt Franklin Water (600ML)" --item "Chicken Schnitzel Salad" --option "NO SAUCE"
node scripts/eatfirst.mjs order --day <day> --item "<item>" --replace   # change an existing order
```

`--item` is the exact menu name (case-insensitive) and can repeat; `--quantity` and `--option`
apply to the `--item` just before them. Add `--dry-run` to fill the cart and stop before
Checkout when the user wants to see it first.

- Exit 0 with `ORDER PLACED: ...` means done and verified on the dashboard. The script appends
  it to `order-history.json`. Report the items and day. EatFirst emails a confirmation, so the
  script takes no confirmation screenshot.
- Exit 0 with `an order for <day> already exists` means nothing to do. Report that. Only add
  `--replace` when the user asked for a change.
- Exit 0 with `NO HISTORY` means nothing to repeat: see the first-order case above.
- Exit 0 with `MENU CHANGED` means last week's order can't be repeated because one or more of
  its items aren't on this day's menu (usually the restaurant changed). It names the missing
  items, then prints the day's numbered menu. Nothing was placed or cancelled. Tell the user the
  menu changed and what last week's order was, then let them pick from the printed menu (next
  section). Never substitute a "similar" item yourself. After they order, `repeat` picks the new
  order up next week.
- Exit 1 with `"<item>" is not on the menu for this day`: nothing was placed or cancelled (the
  menu is checked before `--replace` cancels anything). Run `menu --day <day>` and let the user
  pick from it (next section). Don't substitute.
- Exit 1 with `"<item>" needs options`: the item needs a choice (it names the groups). Ask the
  user, then rerun `order` with `--option`.
- Exit 1 with `the order exceeds the subsidy`: it says how much would be charged. Nothing was
  placed. Tell the user, and ask what to drop or swap (`menu` shows the day's subsidy and flags
  items that exceed it on their own). Rerun `order` with the smaller set. Only if the user says
  they want to pay the difference, rerun with `--allow-payment`.
- Exit 1 with `Checkout was clicked but the dashboard shows no order`: do not retry blindly.
  Tell the user to check their email before anything else is placed.
- Any other exit 1: the script could not finish. Read the newest `artifacts/*-failure.aria.txt`
  and `*-failure.png` and continue by hand (next section).

## Let the user pick from the menu

Used for a first order, `MENU CHANGED`, and an item that's not on the menu. Always give the user
the day's actual menu to choose from (the numbered list `menu` or `repeat` printed), never an
open "what do you want?".

1. Build the choices from the printed menu. Leave out items marked "EXCEEDS SUBSIDY on its own",
   but mention them. Each choice is the item's exact name; its description is the price, plus
   "needs options" where marked.
2. Ask with `AskUserQuestion`, `multiSelect: true`. Each question takes up to 4 choices and
   one call takes up to 4 questions, so split a menu of up to 16 items into questions of 4 in
   menu order ("Menu 1 of 3: which items do you want?", header "Menu 1/3"). The user's "Other"
   answer covers anything else. For a longer menu, or if `AskUserQuestion` isn't available,
   show the whole numbered menu in your message (number, name, price, "needs options") and ask
   them to reply with the numbers they want, e.g. "3 and 7".
3. For each picked item marked "needs options", run `order --day <day> --item "<item>"
   --dry-run`. It fails with the required option groups and every choice offered. Ask those choices with
   `AskUserQuestion` too (one question per group), and ask the quantity only if they asked for
   more than one.
4. Place it with `order --item ... --option ...`, which enforces the subsidy (see the outcomes
   above). If it exceeds the subsidy, show the total and ask what to drop, with the picked items
   as choices.

In a Routine nobody may be watching. Still ask the same way. If the question can't be asked or
times out, end the run with the numbered menu as the final message: "<Day>'s menu has changed,
so last week's <order> can't be repeated. Reply with the numbers you'd like and I'll place it
before the cut-off." If `PushNotification` is available, send a one-line notification so the
user sees it. When they reply in that session, check that the cut-off hasn't passed, then do
steps 3–4.

## Finishing by hand

The ARIA snapshot shows the page the script stopped on. Drive the rest with a short Playwright
script of your own (import from the same `playwright` module, reuse
`eatfirst-storage-state.json` as `storageState` so you're already logged in). What the script
knows about the site is in the header comment of `scripts/eatfirst.mjs`. Rules:

- Before adding anything, check the orders dashboard
  (`https://www.eatfirst.com/en-au/dashboard/canteen-orders`) for an existing order on the
  target day. If one exists and the user didn't ask for a change, stop and report it. If they
  did, cancel it there first ("Cancel Order" on its row) and confirm it's gone before ordering.
- Add exactly the items decided above, at the decided quantities and options.
- Take a screenshot before Checkout. Continue only if the cart matches and "Total to pay" is
  0.00 credits. If anything looks off (wrong item, wrong day, a non-zero total, an upsell
  modal), stop and report what you saw.
- After a successful confirm, append `{ "action": "placed", "date": "<YYYY-MM-DD>", "weekday":
  "<weekday>", "items": [{ "quantity": 1, "name": "<item>", "options": [] }], "replaced": <bool>,
  "at": "<ISO timestamp>" }` to `order-history.json`.
- Once a selector you found by hand works, update `scripts/eatfirst.mjs` to use it so the next
  run is deterministic. Mention the change in your report.

## Report

One short message: what was ordered (or cancelled, or why nothing was), for which day, and
whether it repeated last week's order, replaced an existing one, or came from the user. EatFirst
sends the confirmation email, so do not take or attach a confirmation screenshot. When the menu
changed and nobody answered, the report is the numbered menu and the question (see above).
Do not include credentials or the full ARIA snapshot.
