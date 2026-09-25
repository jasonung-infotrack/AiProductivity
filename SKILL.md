---
name: eatfirst-order
description: "Log in to EatFirst (eatfirst.com, en-AU) and place, repeat or change the user's canteen order. Repeats what they ordered last week, asks them for a first order, and replaces an existing order when they want something different. Use when asked to order lunch, place or change the EatFirst order, or when a Routine fires with 'order from EatFirst'. Triggers on: 'eatfirst', 'order lunch', 'place my order', 'change my order', 'canteen order'."
---

# EatFirst Order

Place, repeat or change the user's EatFirst canteen order with the Playwright script in this
skill's `scripts/` directory. There is no static order file: the order is whatever the user had
on the same weekday last week, or whatever they tell you when they have no history or want a
change. The script is deterministic where it can be and hands over to you with diagnostics where
the site's markup doesn't match. Never place a second order on a day that already has one;
replace it only when the user asked for a change.

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
A Routine asking for "today's order" means `today`. Pass it as `--day <day>` to every command
below; the script resolves it in Australia/Sydney.

## Decide what to order

Run, from this skill's directory:

```bash
node scripts/eatfirst.mjs orders --day <day>
```

It prints the target date, the same weekday last week, the local `order-history.json`, whether
an order already exists on the target day (a heuristic), and an ARIA snapshot of the site's
orders page. The site is the source of truth; the local history is a fallback for when the
snapshot can't be read. Then pick exactly one of these:

- **The user named an item** ("order the katsu", "change it to the salad"). That is the order,
  whatever the history says. Quantity 1 unless they said otherwise.
- **An order already exists on the target day.**
  - The user asked to change it: place the new item with `--replace` (next section), which
    cancels the existing order first. If they asked for a change without naming the new item,
    ask them what they want (show the `menu` output, below) before touching anything.
  - The user only wants it cancelled: `node scripts/eatfirst.mjs cancel --day <day>`.
  - Otherwise: report what is already ordered and stop. Don't cancel, don't re-order.
- **No order that day, and there is history.** Take the order from the same weekday last week:
  item and quantity as the orders page shows them. If there was no order that day, take the
  most recent one. Don't ask; just place it.
- **No history anywhere** (nothing on the orders page, nothing local). This is a first order.
  Run `node scripts/eatfirst.mjs menu --day <day>`, pull the item names out of the snapshot, and
  ask the user which one they want and how many (`AskUserQuestion` listing the items when the
  session is interactive). In a Routine or any other non-interactive run you can't ask, so stop
  and report that the first order needs their choice. Never guess an item.

## Place the order

```bash
node scripts/eatfirst.mjs order --day <day> --item "<item>" --quantity <n>
node scripts/eatfirst.mjs order --day <day> --item "<item>" --quantity <n> --replace   # change an existing order
```

`--item` is matched case-insensitively as a substring of the menu item's name, so the name as it
appears on the orders page or menu snapshot is enough.

- Exit code 0 with `ORDER PLACED: <item>` means done. The script appends the order to
  `order-history.json`. Report the item and day. EatFirst emails a confirmation, so the script
  takes no confirmation screenshot.
- Exit code 0 with `an order for <day> already exists` means nothing to do. Report that. Only
  add `--replace` when the user asked for a change.
- Exit code 1 with `"<item>" is not on the menu for this day` means last week's item isn't
  available. Run `menu --day <day>` and ask the user to choose from what is (or, non-interactive,
  stop and report). Don't substitute an item yourself.
- Any other exit code 1 means the script could not finish. Read the newest
  `artifacts/*-failure.aria.txt` and `*-failure.png` and continue by hand (next section).

## Finishing by hand

The ARIA snapshot shows the page the script stopped on. Drive the rest with a short Playwright
script of your own (import from the same `playwright` module, reuse
`eatfirst-storage-state.json` as `storageState` so you're already logged in). Rules:

- Before adding anything, check the orders page (`https://www.eatfirst.com/en-au/orders`) for
  an existing order on the target day. If one exists and the user didn't ask for a change, stop
  and report it. If they did, cancel it there first and confirm it's gone before ordering.
- Add exactly one item, the one decided above, at the decided quantity.
- Take a screenshot before the final confirm. Confirm only if the cart matches. If anything
  looks off (wrong item, wrong day, unexpected price, an upsell modal), stop before confirming
  and report what you saw.
- After a successful confirm, append `{ "action": "placed", "date": "<YYYY-MM-DD>", "weekday":
  "<weekday>", "item": "<item>", "quantity": <n>, "replaced": <bool>, "at": "<ISO timestamp>" }`
  to `order-history.json` so next week's run can find it.
- Once a selector you found by hand works, update `scripts/eatfirst.mjs` to use it so the next
  run is deterministic. Mention the change in your report.

## Report

One short message: what was ordered (or cancelled, or why nothing was), for which day, and
whether it repeated last week's order, replaced an existing one, or came from the user. EatFirst
sends the confirmation email, so do not take or attach a confirmation screenshot. Do not include
credentials or the full ARIA snapshot.
