#!/usr/bin/env node
/**
 * EatFirst canteen automation: log in, read the order history, then repeat, place, replace or
 * cancel a canteen order.
 *
 * Usage:
 *   node scripts/eatfirst.mjs check                         # report whether credentials are present (never values)
 *   node scripts/eatfirst.mjs login                         # log in, save session, exit
 *   node scripts/eatfirst.mjs orders [--day <day>]          # list the site's orders and what a repeat would place
 *   node scripts/eatfirst.mjs menu [--day <day>]            # list the menu for that day (name, price, needs options?)
 *   node scripts/eatfirst.mjs repeat [--day <day>] [--replace] [--dry-run]
 *       # order what was ordered on the same weekday last week, else the most recent order
 *   node scripts/eatfirst.mjs order --item "<name>" [--quantity N] [--option "<choice>"]... [--item ...] [--day <day>] [--replace] [--dry-run]
 *       # order exactly these items; --quantity and --option apply to the --item before them
 *   node scripts/eatfirst.mjs cancel [--day <day>]          # cancel the existing order for that day
 *   node scripts/eatfirst.mjs inspect [url]                 # dump a page snapshot for debugging
 *
 * <day> is "today" (default), "tomorrow", a weekday name, or YYYY-MM-DD, resolved in Australia/Sydney.
 * `repeat` and `order` refuse to place a second order on a day that already has one unless
 * --replace is given, in which case they cancel the existing order first.
 *
 * Site structure this relies on (verified 2026-09-25):
 *   - Login is two-step: email, "Next", then password.
 *   - /en-au/dashboard/canteen-orders is a grid of upcoming and past orders. Each row: date
 *     ("25 September 2026"), meal, items as "1x Name" paragraphs each followed by an icon whose
 *     aria-label holds the chosen options ("1x NO SAUCE"), and a "Cancel Order" button that is
 *     disabled once the cut-off has passed.
 *   - /en-au/canteen?meal=lunch&date=YYYY-MM-DD is the menu for a day. Each item card has a
 *     .MuiCardHeader-title with the exact name, a "Show Options"/"Show More" button and an
 *     unnamed add button. Add opens either the cart dialog (heading "Your Order", "Checkout")
 *     or, for items with options, an item dialog with checkboxes and a "... add to cart" button
 *     that stays disabled until the required options are chosen.
 *
 * Environment (shell variables, or a .env file in the working directory — shell wins):
 *   EATFIRST_EMAIL, EATFIRST_PASSWORD   credentials (never printed; copy .env.example to .env)
 *   EATFIRST_HEADED=1                   run with a visible browser
 *   EATFIRST_ARTIFACTS=dir              where screenshots/snapshots go (default ./artifacts)
 *
 * Every placed or cancelled order is appended to order-history.json (gitignored). Every failure
 * writes a screenshot and an ARIA snapshot to the artifacts directory and exits non-zero, so a
 * driving agent can read them and finish the flow by hand.
 */
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ENV_FILE_PATH = resolve('.env');
const CREDENTIAL_VARIABLE_NAMES = ['EATFIRST_EMAIL', 'EATFIRST_PASSWORD'];

const isSet = (value) => typeof value === 'string' && value.trim().length > 0;

/** Loads KEY=value lines from .env into process.env without overriding variables the shell already set. */
const loadEnvironmentFile = () => {
  if (!existsSync(ENV_FILE_PATH)) return;
  for (const rawLine of readFileSync(ENV_FILE_PATH, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const separatorIndex = line.indexOf('=');
    if (separatorIndex === -1) continue;
    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
    if (!isSet(process.env[key])) process.env[key] = value;
  }
};
loadEnvironmentFile();

const require = createRequire(import.meta.url);
const loadPlaywright = () => {
  const candidates = ['playwright', '@playwright/test', '/opt/node22/lib/node_modules/playwright'];
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {
      // try the next location
    }
  }
  throw new Error('Playwright not found. Run `npm install playwright` in the skill directory.');
};
const { chromium } = loadPlaywright();

const BASE_URL = 'https://www.eatfirst.com';
const LOGIN_URL = `${BASE_URL}/en-au/authentication/login?destination=%2Fen-au%2Fcanteen`;
const CANTEEN_URL = `${BASE_URL}/en-au/canteen`;
const ORDERS_URL = `${BASE_URL}/en-au/dashboard/canteen-orders`;
const MEAL = 'lunch';
const STORAGE_STATE_PATH = resolve('eatfirst-storage-state.json');
const HISTORY_PATH = resolve('order-history.json');
const ARTIFACTS_DIR = resolve(process.env.EATFIRST_ARTIFACTS ?? 'artifacts');
const SYDNEY_TIME_ZONE = 'Australia/Sydney';
const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];
const MILLISECONDS_PER_DAY = 86_400_000;
/** An XPath predicate for a <p> whose text is only digits — the quantity readout between the - and + buttons. */
const DIGITS_ONLY_PARAGRAPH = 'p[translate(normalize-space(.), "0123456789", "") = "" and normalize-space(.) != ""]';

const log = (message) => console.log(`[eatfirst] ${message}`);

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exactly = (text) => new RegExp(`^\\s*${escapeRegExp(text)}\\s*$`, 'i');
const capitalise = (word) => word.charAt(0).toUpperCase() + word.slice(1);

const parseArguments = (argv) => {
  const [command = 'repeat', ...rest] = argv;
  const options = { command, day: 'today', items: [], replace: false, dryRun: false, url: undefined };
  const currentItem = () => {
    if (options.items.length === 0) throw new Error('--quantity and --option must come after an --item');
    return options.items.at(-1);
  };
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === '--day') options.day = rest[++index];
    else if (argument === '--item') options.items.push({ name: rest[++index], quantity: 1, options: [] });
    else if (argument === '--quantity') currentItem().quantity = Number(rest[++index]);
    else if (argument === '--option') currentItem().options.push(rest[++index]);
    else if (argument === '--replace') options.replace = true;
    else if (argument === '--dry-run') options.dryRun = true;
    else if (!argument.startsWith('--')) options.url = argument;
    else throw new Error(`unknown option "${argument}"`);
  }
  for (const item of options.items) {
    if (!isSet(item.name)) throw new Error('--item needs a menu item name');
    if (!Number.isInteger(item.quantity) || item.quantity < 1) throw new Error(`--quantity for "${item.name}" must be a positive integer`);
  }
  return options;
};

// ---------------------------------------------------------------------------------------------
// Dates. Everything is a plain calendar date in Australia/Sydney, held as noon UTC so day
// arithmetic never crosses a daylight-saving boundary.
// ---------------------------------------------------------------------------------------------

const todayInSydney = () => {
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone: SYDNEY_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const partValue = (type) => Number(parts.find((part) => part.type === type).value);
  return new Date(Date.UTC(partValue('year'), partValue('month') - 1, partValue('day'), 12));
};

const addDays = (date, days) => new Date(date.getTime() + days * MILLISECONDS_PER_DAY);

const describeDate = (date) => ({
  iso: date.toISOString().slice(0, 10),
  weekday: WEEKDAY_NAMES[date.getUTCDay()],
  dayOfMonth: date.getUTCDate(),
  monthNumber: date.getUTCMonth() + 1,
  month: MONTH_NAMES[date.getUTCMonth()],
  year: date.getUTCFullYear(),
});

const formatDay = (date) => {
  const { weekday, iso } = describeDate(date);
  return `${weekday} ${iso}`;
};

/** The date as the dashboard grid prints it: "25 September 2026". */
const formatLongDate = (date) => {
  const { dayOfMonth, month, year } = describeDate(date);
  return `${dayOfMonth} ${capitalise(month)} ${year}`;
};

/** "today" (default), "tomorrow", a weekday name (next occurrence, today if it is that day), or YYYY-MM-DD. */
const resolveTargetDate = (dayArgument = 'today') => {
  const today = todayInSydney();
  const normalised = dayArgument.trim().toLowerCase();
  if (normalised === '' || normalised === 'today') return today;
  if (normalised === 'tomorrow') return addDays(today, 1);
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalised);
  if (isoMatch) return new Date(Date.UTC(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3]), 12));
  const weekdayIndex = normalised.length >= 3 ? WEEKDAY_NAMES.findIndex((name) => name.startsWith(normalised)) : -1;
  if (weekdayIndex !== -1) return addDays(today, (weekdayIndex - today.getUTCDay() + 7) % 7);
  throw new Error(`unrecognised day "${dayArgument}": use today, tomorrow, a weekday name, or YYYY-MM-DD`);
};

/** Parses "25 September 2026" (as the dashboard prints dates) into a noon-UTC date, or null. */
const parseLongDate = (text) => {
  const match = /(\d{1,2})\s+([a-z]+)\s+(\d{4})/i.exec(text);
  if (!match) return null;
  const monthIndex = MONTH_NAMES.findIndex((name) => name.startsWith(match[2].toLowerCase().slice(0, 3)));
  if (monthIndex === -1) return null;
  return new Date(Date.UTC(Number(match[3]), monthIndex, Number(match[1]), 12));
};

// ---------------------------------------------------------------------------------------------
// Order items
// ---------------------------------------------------------------------------------------------

/** "1x Chicken Schnitzel Salad" → { quantity: 1, name: "Chicken Schnitzel Salad" }. */
const parseItemLine = (text) => {
  const match = /^(\d+)\s*x\s+(.+)$/i.exec(text.trim());
  return match ? { quantity: Number(match[1]), name: match[2].trim() } : { quantity: 1, name: text.trim() };
};

/** The options icon's aria-label, "1x NO SAUCE, 1x REMOVE Capsicum" → ["NO SAUCE", "REMOVE Capsicum"]. */
const parseOptionsLabel = (label) =>
  (label ?? '')
    .split(',')
    .map((part) => part.replace(/^\s*\d+\s*x\s+/i, '').trim())
    .filter((part) => part.length > 0);

const describeItems = (items) =>
  items
    .map((item) => `${item.quantity}x ${item.name}${item.options.length > 0 ? ` [${item.options.join(', ')}]` : ''}`)
    .join('; ');

/** The `order` command arguments that would reproduce these items. */
const itemsAsArguments = (items) =>
  items
    .map((item) => [
      `--item "${item.name}"`,
      item.quantity !== 1 ? `--quantity ${item.quantity}` : '',
      ...item.options.map((option) => `--option "${option}"`),
    ].filter((part) => part.length > 0).join(' '))
    .join(' ');

/** Same weekday last week if it was ordered, else the most recent order before the target day, else null. */
const chooseRepeat = (siteOrders, targetDate) => {
  const targetIso = describeDate(targetDate).iso;
  const lastWeekIso = describeDate(addDays(targetDate, -7)).iso;
  const lastWeek = siteOrders.find((order) => order.date === lastWeekIso);
  if (lastWeek) return { source: `same weekday last week (${lastWeek.date})`, order: lastWeek };
  const mostRecent = siteOrders.find((order) => order.date < targetIso);
  if (mostRecent) return { source: `most recent order (${mostRecent.date})`, order: mostRecent };
  return null;
};

// ---------------------------------------------------------------------------------------------
// Local history: a fallback record of what this script placed, for when the site's orders
// page can't be read. The site is the source of truth.
// ---------------------------------------------------------------------------------------------

const readHistory = () => {
  if (!existsSync(HISTORY_PATH)) return [];
  try {
    const history = JSON.parse(readFileSync(HISTORY_PATH, 'utf8'));
    return Array.isArray(history) ? history : [];
  } catch {
    return [];
  }
};

const recordHistory = (entry) => {
  writeFileSync(HISTORY_PATH, `${JSON.stringify([...readHistory(), entry], null, 2)}\n`);
};

const describeHistory = (history) => {
  if (history.length === 0) return 'none';
  return [...history]
    .reverse()
    .map((entry) => `${entry.date} (${entry.weekday}) ${entry.action}${entry.items ? `: ${describeItems(entry.items)}` : ''}`)
    .join('; ');
};

// ---------------------------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------------------------

const saveDiagnostics = async (page, label) => {
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const screenshotPath = resolve(ARTIFACTS_DIR, `${stamp}-${label}.png`);
  const snapshotPath = resolve(ARTIFACTS_DIR, `${stamp}-${label}.aria.txt`);
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
  const snapshot = await page.locator('body').ariaSnapshot().catch(() => '(snapshot unavailable)');
  writeFileSync(snapshotPath, `URL: ${page.url()}\n\n${snapshot}`);
  log(`diagnostics written: ${screenshotPath} and ${snapshotPath}`);
};

const printSnapshot = async (page, label) => {
  const snapshot = await page.locator('body').ariaSnapshot().catch(() => '(snapshot unavailable)');
  console.log(`--- ${label} snapshot (${page.url()}) ---\n${snapshot}\n--- end ${label} snapshot ---`);
};

/** Prints whether each credential is present — never the values — and returns the exit code. */
const runPreflightCheck = () => {
  const missing = CREDENTIAL_VARIABLE_NAMES.filter((name) => !isSet(process.env[name]));
  for (const name of CREDENTIAL_VARIABLE_NAMES) {
    log(`${name}: ${missing.includes(name) ? 'MISSING' : 'set'}`);
  }
  if (missing.length > 0) {
    log(`missing: ${missing.join(', ')} — copy .env.example to .env and fill it in, or set them in the shell`);
    return 1;
  }
  log('preflight OK');
  return 0;
};

// ---------------------------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------------------------

const requireEnvironmentVariable = (name) => {
  const value = process.env[name];
  if (!isSet(value)) {
    throw new Error(`Missing ${name}: set it in the shell or in .env (copy .env.example)`);
  }
  return value;
};

/**
 * Fills a credential field. Playwright's error messages include the value being filled, so a
 * failure is rethrown with only the first line of the message and never the value.
 */
const fillCredential = async (field, value, label) => {
  try {
    await field.fill(value);
  } catch (error) {
    throw new Error(`could not fill the ${label} field: ${String(error.message).split('\n')[0]}`);
  }
};

const dismissCookieBannerIfPresent = async (page) => {
  const consentButton = page.getByRole('button', { name: /accept( all)?( cookies)?|agree|got it/i }).first();
  if (await consentButton.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await consentButton.click();
  }
};

const emailField = (page) =>
  page
    .getByLabel(/e-?mail|username/i)
    .or(page.getByPlaceholder(/e-?mail|username/i))
    .or(page.locator('input[type="email"], input[name*="email" i], input[autocomplete="username"]'))
    .first();

const passwordField = (page) =>
  page
    .getByLabel(/password/i)
    .or(page.getByPlaceholder(/password/i))
    .or(page.locator('input[type="password"], input[autocomplete="current-password"]'))
    .first();

const submitButton = (page) =>
  page
    .getByRole('button', { name: /log ?in|sign ?in|continue|^next$/i })
    .or(page.locator('form button[type="submit"], form input[type="submit"]'))
    .first();

const isLoggedIn = async (page) => {
  await page.goto(CANTEEN_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  return !page.url().includes('/authentication/login');
};

const login = async (page) => {
  const email = requireEnvironmentVariable('EATFIRST_EMAIL');
  const password = requireEnvironmentVariable('EATFIRST_PASSWORD');

  log('opening login page');
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
  await dismissCookieBannerIfPresent(page);
  await emailField(page).waitFor({ state: 'visible', timeout: 15_000 });
  await fillCredential(emailField(page), email, 'email');
  if (!(await passwordField(page).isVisible({ timeout: 1_000 }).catch(() => false))) {
    // Two-step login: the password field only appears after the email is submitted with "Next".
    await clickFirstMatching(page, [/^next$/i, /continue/i], { roles: ['button'] });
    await passwordField(page).waitFor({ state: 'visible', timeout: 15_000 });
  }
  await fillCredential(passwordField(page), password, 'password');
  await Promise.all([
    page.waitForURL((url) => !url.pathname.includes('/authentication/login'), { timeout: 30_000 }),
    submitButton(page).click(),
  ]);
  await page.context().storageState({ path: STORAGE_STATE_PATH });
  log(`logged in, landed on ${page.url()}`);
};

const ensureLoggedIn = async (page) => {
  if (existsSync(STORAGE_STATE_PATH) && (await isLoggedIn(page))) {
    log('reused saved session');
    return;
  }
  await login(page);
};

// ---------------------------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------------------------

/** Clicks the first visible control whose accessible name matches any of the patterns. */
const clickFirstMatching = async (page, patterns, { timeout = 5_000, roles = ['button', 'link', 'tab'] } = {}) => {
  for (const pattern of patterns) {
    for (const role of roles) {
      const candidate = page.getByRole(role, { name: pattern }).first();
      if (await candidate.isVisible({ timeout }).catch(() => false)) {
        await candidate.click();
        return true;
      }
    }
  }
  return false;
};

const anyDialog = (page) => page.getByRole('dialog').or(page.getByRole('alertdialog')).first();

const closeDialogs = async (page) => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (!(await anyDialog(page).isVisible({ timeout: 500 }).catch(() => false))) return;
    await page.keyboard.press('Escape');
    await anyDialog(page).waitFor({ state: 'hidden', timeout: 3_000 }).catch(() => undefined);
  }
};

/** Clicks the "+" that follows a quantity readout `times` times. `scope` is the dialog, or an item's name element in the cart. */
const clickPlus = async (scope, times, { anchoredOnItem = false } = {}) => {
  for (let click = 0; click < times; click += 1) {
    const axis = anchoredOnItem ? 'following' : 'descendant';
    await scope.locator(`xpath=${axis}::${DIGITS_ONLY_PARAGRAPH}[1]/following-sibling::button[1]`).first().click();
  }
};

// ---------------------------------------------------------------------------------------------
// Orders dashboard: history, existing orders, cancellation
// ---------------------------------------------------------------------------------------------

/** Reads every order row from the dashboard grid (upcoming and past), most recent first. */
const readSiteOrders = async (page) => {
  await page.goto(ORDERS_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.getByRole('grid').first().waitFor({ state: 'visible', timeout: 15_000 });
  const rawRows = await page.evaluate(() =>
    [...document.querySelectorAll('[role="row"]')]
      .map((row) => {
        const cells = [...row.querySelectorAll('[role="gridcell"]')];
        if (cells.length < 3) return null;
        const itemCell = cells.find((cell) => cell.getAttribute('data-field') === 'item') ?? cells[2];
        const items = [...itemCell.querySelectorAll('p')].map((paragraph) => ({
          text: paragraph.textContent.trim(),
          optionsLabel: paragraph.nextElementSibling?.getAttribute('aria-label') ?? null,
        }));
        const cancelButton = cells.at(-1).querySelector('button');
        return {
          dateText: cells[0].textContent.trim(),
          items,
          cancellable: cancelButton !== null && !cancelButton.disabled,
        };
      })
      .filter((row) => row !== null),
  );
  return rawRows
    .map((row) => {
      const date = parseLongDate(row.dateText);
      if (date === null) return null;
      return {
        date: describeDate(date).iso,
        weekday: describeDate(date).weekday,
        dateText: row.dateText,
        items: row.items.map((item) => ({ ...parseItemLine(item.text), options: parseOptionsLabel(item.optionsLabel) })),
        cancellable: row.cancellable,
      };
    })
    .filter((row) => row !== null)
    .sort((left, right) => right.date.localeCompare(left.date));
};

const ordersOn = (siteOrders, targetDate) => siteOrders.filter((order) => order.date === describeDate(targetDate).iso);

const cancelExistingOrder = async (page, targetDate) => {
  const dayLabel = formatDay(targetDate);
  const existing = ordersOn(await readSiteOrders(page), targetDate);
  if (existing.length === 0) {
    log(`no order found for ${dayLabel}`);
    return false;
  }
  if (!existing.some((order) => order.cancellable)) {
    throw new Error(`the order for ${dayLabel} can no longer be cancelled: the cut-off has passed`);
  }
  const row = page.getByRole('row', { name: new RegExp(`^${escapeRegExp(formatLongDate(targetDate))}\\b`) }).first();
  const cancelButton = row.getByRole('button', { name: /cancel order/i }).first();
  await cancelButton.waitFor({ state: 'visible', timeout: 5_000 });
  await cancelButton.click();
  const dialog = anyDialog(page);
  if (await dialog.isVisible({ timeout: 3_000 }).catch(() => false)) {
    const dialogText = (await dialog.innerText()).replace(/\s+/g, ' ').trim();
    log(`cancel confirmation: ${dialogText.slice(0, 200)}`);
    const confirmed = await clickFirstMatching(dialog, [/^yes/i, /confirm/i, /^ok$/i, /cancel order/i], { roles: ['button'], timeout: 1_000 });
    if (!confirmed) throw new Error(`cancel confirmation dialog has no recognisable confirm button: ${dialogText.slice(0, 200)}`);
  }
  await page.waitForLoadState('networkidle').catch(() => undefined);
  const remaining = ordersOn(await readSiteOrders(page), targetDate).filter((order) => order.cancellable);
  if (remaining.length > 0) {
    throw new Error(`the order for ${dayLabel} is still listed after cancelling`);
  }
  log(`cancelled the existing order for ${dayLabel}: ${describeItems(existing[0].items)}`);
  return true;
};

// ---------------------------------------------------------------------------------------------
// Canteen menu and cart
// ---------------------------------------------------------------------------------------------

const menuUrl = (targetDate) => `${CANTEEN_URL}?meal=${MEAL}&date=${describeDate(targetDate).iso}`;

const openMenu = async (page, targetDate) => {
  await page.goto(menuUrl(targetDate), { waitUntil: 'domcontentloaded' });
  await dismissCookieBannerIfPresent(page);
  await page.waitForLoadState('networkidle').catch(() => undefined);
  const orderingFor = page.getByRole('heading', { name: /ordering for/i }).first();
  if (!(await orderingFor.isVisible({ timeout: 10_000 }).catch(() => false))) {
    throw new Error(`the canteen page did not load a menu for ${formatDay(targetDate)}`);
  }
  const dateButton = page.getByRole('button', { name: new RegExp(`${describeDate(targetDate).dayOfMonth}(st|nd|rd|th)?\\s+${capitalise(describeDate(targetDate).month)}`, 'i') }).first();
  if (!(await dateButton.isVisible({ timeout: 3_000 }).catch(() => false))) {
    const shownDate = await page.getByRole('heading', { name: /ordering for/i }).locator('xpath=following::button[1]').innerText().catch(() => '(unknown)');
    throw new Error(`the canteen page is showing "${shownDate.trim()}" instead of ${formatDay(targetDate)}; there may be no menu that day`);
  }
};

/** Lists the menu cards on the open canteen page: name, price and whether adding needs options. */
const readMenu = async (page) =>
  page.evaluate(() => {
    const cards = [];
    for (const title of document.querySelectorAll('.MuiCardHeader-title')) {
      let card = title.parentElement;
      while (card !== null && card.querySelector('button') === null) card = card.parentElement;
      if (card === null) continue;
      const buttonLabels = [...card.querySelectorAll('button')].map((button) => button.textContent.trim());
      if (buttonLabels.includes('Cancel')) continue; // an existing order in the "Your Order" section, not a menu item
      const price = [...card.querySelectorAll('p')].map((paragraph) => paragraph.textContent.trim()).find((text) => /credits/i.test(text)) ?? '';
      cards.push({ name: title.textContent.trim(), price, hasOptions: buttonLabels.includes('Show Options') });
    }
    return cards;
  });

/** The menu card whose title is exactly the item name, skipping the "Your Order" cards. */
const menuCardFor = async (page, itemName) => {
  const titles = page.locator('.MuiCardHeader-title').filter({ hasText: exactly(itemName) });
  const count = await titles.count();
  for (let index = 0; index < count; index += 1) {
    const card = titles.nth(index).locator('xpath=ancestor::*[.//button][1]');
    if ((await card.count()) === 0) continue;
    if ((await card.getByRole('button', { name: /^cancel$/i }).count()) > 0) continue;
    return card;
  }
  return null;
};

const requiredOptionGroups = async (dialog) => {
  const text = await dialog.innerText().catch(() => '');
  return [...text.matchAll(/([^\n]+)\n\s*Select \d+ \(maximum \d+\)/g)].map((match) => match[1].trim());
};

const addItemToCart = async (page, item) => {
  const card = await menuCardFor(page, item.name);
  if (card === null) throw new Error(`"${item.name}" is not on the menu for this day`);
  await card.getByRole('button').last().click();
  const dialog = anyDialog(page);
  await dialog.waitFor({ state: 'visible', timeout: 10_000 });
  const addButton = dialog.getByRole('button', { name: /add to cart/i }).first();
  if ((await addButton.count()) > 0) {
    for (const option of item.options) {
      const checkbox = dialog.getByRole('checkbox', { name: exactly(option) }).first();
      if (!(await checkbox.isVisible({ timeout: 3_000 }).catch(() => false))) {
        throw new Error(`option "${option}" was not offered for "${item.name}"`);
      }
      await checkbox.check();
    }
    await clickPlus(dialog, item.quantity - 1);
    if (await addButton.isDisabled()) {
      const groups = await requiredOptionGroups(dialog);
      throw new Error(`"${item.name}" needs options before it can be added (${groups.join('; ') || 'see the item dialog'}); pass them with --option`);
    }
    await addButton.click();
    await page.getByRole('dialog').filter({ hasText: /checkout/i }).first().waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined);
  } else {
    // Simple item: the cart dialog opened directly with the item at quantity 1.
    const itemInCart = dialog.getByText(exactly(item.name)).first();
    await itemInCart.waitFor({ state: 'visible', timeout: 5_000 });
    await clickPlus(itemInCart, item.quantity - 1, { anchoredOnItem: true });
  }
  log(`added ${item.quantity}x "${item.name}"${item.options.length > 0 ? ` [${item.options.join(', ')}]` : ''}`);
  await closeDialogs(page);
};

const openCart = async (page) => {
  const cart = page.getByRole('dialog').filter({ hasText: /checkout/i }).first();
  if (await cart.isVisible({ timeout: 1_000 }).catch(() => false)) return cart;
  await page.getByRole('button', { name: /\d+ items?,/ }).first().click();
  await cart.waitFor({ state: 'visible', timeout: 10_000 });
  return cart;
};

const checkout = async (page, items, { dryRun }) => {
  const cart = await openCart(page);
  const cartText = (await cart.innerText()).replace(/\s+/g, ' ');
  for (const item of items) {
    if (!new RegExp(escapeRegExp(item.name), 'i').test(cartText)) throw new Error(`"${item.name}" is not in the cart`);
  }
  const subtotal = /Subtotal \([^)]*\)\s*[\d.]+ credits/i.exec(cartText)?.[0] ?? '(subtotal not shown)';
  const total = /Total to pay\s*[\d.]+ credits/i.exec(cartText)?.[0] ?? '(total not shown)';
  log(`cart: ${subtotal}; ${total}`);
  if (dryRun) {
    await saveDiagnostics(page, 'dry-run-before-checkout');
    log('dry run: stopping before Checkout');
    return false;
  }
  await cart.getByRole('button', { name: /^checkout$/i }).first().click();
  await page.waitForLoadState('networkidle').catch(() => undefined);
  const finalButton = page.getByRole('button', { name: /place order|confirm order|confirm & pay|pay now|complete order/i }).first();
  if (await finalButton.isVisible({ timeout: 5_000 }).catch(() => false)) {
    log(`second checkout step: clicking "${(await finalButton.innerText()).trim()}"`);
    await finalButton.click();
    await page.waitForLoadState('networkidle').catch(() => undefined);
  }
  return true;
};

const placeOrder = async (page, targetDate, items, options, existing) => {
  const dayLabel = formatDay(targetDate);
  let replaced = false;
  if (existing.length > 0) {
    if (options.dryRun) log('dry run: leaving the existing order in place');
    else replaced = await cancelExistingOrder(page, targetDate);
  }
  await openMenu(page, targetDate);
  for (const item of items) {
    await addItemToCart(page, item);
  }
  const placed = await checkout(page, items, options);
  if (!placed) {
    log(`DRY RUN OK: ${describeItems(items)} for ${dayLabel} is in the cart`);
    return;
  }
  const confirmedOrders = ordersOn(await readSiteOrders(page), targetDate);
  const confirmed = confirmedOrders.find((order) => order.items.some((ordered) => ordered.name.toLowerCase() === items[0].name.toLowerCase()));
  if (!confirmed) {
    throw new Error(`Checkout was clicked but the dashboard shows no order for ${dayLabel}; check the confirmation email before retrying so the order isn't placed twice`);
  }
  const { iso, weekday } = describeDate(targetDate);
  recordHistory({ action: 'placed', date: iso, weekday, items: confirmed.items, replaced, at: new Date().toISOString() });
  log(`ORDER PLACED: ${describeItems(confirmed.items)} for ${dayLabel}${replaced ? ' (replaced the previous order)' : ''}`);
};

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

const runOrders = async (page, targetDate) => {
  const siteOrders = await readSiteOrders(page);
  const lastWeek = addDays(targetDate, -7);
  log(`orders on the site (most recent first): ${siteOrders.length}`);
  for (const order of siteOrders) {
    console.log(`  ${order.date} (${order.weekday}): ${describeItems(order.items)}${order.cancellable ? '' : ' — cut-off passed'}`);
  }
  const existing = ordersOn(siteOrders, targetDate);
  log(`target day ${formatDay(targetDate)}: ${existing.length > 0 ? `existing order: ${describeItems(existing[0].items)}${existing[0].cancellable ? ' (cancellable)' : ' (cut-off passed, cannot be changed)'}` : 'no order yet'}`);
  log(`same weekday last week (${formatDay(lastWeek)}): ${ordersOn(siteOrders, lastWeek).map((order) => describeItems(order.items)).join(' | ') || 'no order'}`);
  const repeat = chooseRepeat(siteOrders, targetDate);
  if (repeat) {
    log(`repeat would place the ${repeat.source}: ${describeItems(repeat.order.items)}`);
    log(`equivalent: node scripts/eatfirst.mjs order --day ${describeDate(targetDate).iso} ${itemsAsArguments(repeat.order.items)}`);
  } else {
    log('NO HISTORY: nothing to repeat');
  }
  log(`local history: ${describeHistory(readHistory())}`);
  if (siteOrders.length === 0) await printSnapshot(page, 'orders page');
};

const runMenu = async (page, targetDate) => {
  await openMenu(page, targetDate);
  const menu = await readMenu(page);
  log(`menu for ${formatDay(targetDate)}: ${menu.length} items`);
  for (const item of menu) {
    console.log(`  ${item.name} — ${item.price}${item.hasOptions ? ' (needs options)' : ''}`);
  }
  if (menu.length === 0) await printSnapshot(page, 'menu');
};

const runRepeat = async (page, targetDate, options) => {
  const siteOrders = await readSiteOrders(page);
  const existing = ordersOn(siteOrders, targetDate);
  if (existing.length > 0 && !options.replace) {
    log(`an order for ${formatDay(targetDate)} already exists: ${describeItems(existing[0].items)} — nothing to do (pass --replace to change it)`);
    return;
  }
  const repeat = chooseRepeat(siteOrders, targetDate);
  if (repeat === null) {
    log('NO HISTORY: there are no previous orders on the site to repeat — ask the user what to order, then use `order --item ...`');
    return;
  }
  log(`repeating the ${repeat.source}: ${describeItems(repeat.order.items)}`);
  await placeOrder(page, targetDate, repeat.order.items, options, existing);
};

const runOrder = async (page, targetDate, options) => {
  if (options.items.length === 0) throw new Error('order needs at least one --item "<menu item name>"');
  const existing = ordersOn(await readSiteOrders(page), targetDate);
  if (existing.length > 0 && !options.replace) {
    log(`an order for ${formatDay(targetDate)} already exists: ${describeItems(existing[0].items)} — nothing to do (pass --replace to change it)`);
    return;
  }
  await placeOrder(page, targetDate, options.items, options, existing);
};

const runCancel = async (page, targetDate) => {
  const cancelled = await cancelExistingOrder(page, targetDate);
  if (!cancelled) {
    log(`nothing to cancel for ${formatDay(targetDate)}`);
    return;
  }
  const { iso, weekday } = describeDate(targetDate);
  recordHistory({ action: 'cancelled', date: iso, weekday, items: null, at: new Date().toISOString() });
  log(`ORDER CANCELLED for ${formatDay(targetDate)}`);
};

const main = async () => {
  let options;
  let targetDate;
  try {
    options = parseArguments(process.argv.slice(2));
    targetDate = resolveTargetDate(options.day);
  } catch (error) {
    console.error(`[eatfirst] FAILED: ${error.message}`);
    process.exit(1);
  }
  if (options.command === 'check') {
    process.exit(runPreflightCheck());
  }

  const browser = await chromium.launch({
    headless: process.env.EATFIRST_HEADED !== '1',
    executablePath: existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined,
  });
  const context = await browser.newContext({
    locale: 'en-AU',
    timezoneId: SYDNEY_TIME_ZONE,
    storageState: existsSync(STORAGE_STATE_PATH) ? STORAGE_STATE_PATH : undefined,
  });
  const page = await context.newPage();
  let exitCode = 0;

  try {
    if (options.command === 'inspect') {
      await ensureLoggedIn(page);
      await page.goto(options.url ?? CANTEEN_URL, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle').catch(() => undefined);
      await saveDiagnostics(page, 'inspect');
      await printSnapshot(page, 'inspect');
    } else if (options.command === 'login') {
      await login(page);
    } else if (options.command === 'orders') {
      await ensureLoggedIn(page);
      await runOrders(page, targetDate);
    } else if (options.command === 'menu') {
      await ensureLoggedIn(page);
      await runMenu(page, targetDate);
    } else if (options.command === 'repeat') {
      await ensureLoggedIn(page);
      await runRepeat(page, targetDate, options);
    } else if (options.command === 'order') {
      await ensureLoggedIn(page);
      await runOrder(page, targetDate, options);
    } else if (options.command === 'cancel') {
      await ensureLoggedIn(page);
      await runCancel(page, targetDate);
    } else {
      throw new Error(`unknown command "${options.command}"`);
    }
  } catch (error) {
    exitCode = 1;
    console.error(`[eatfirst] FAILED: ${String(error.message).split('\n')[0]}`);
    await saveDiagnostics(page, 'failure');
  } finally {
    await browser.close();
  }
  process.exit(exitCode);
};

export {
  resolveTargetDate, describeDate, addDays, formatLongDate, parseLongDate, parseArguments,
  parseItemLine, parseOptionsLabel, chooseRepeat, itemsAsArguments,
};

const isDirectRun = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirectRun) await main();
