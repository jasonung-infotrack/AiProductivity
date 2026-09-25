#!/usr/bin/env node
/**
 * EatFirst automation: log in, then place the order described in a config file.
 *
 * Usage:
 *   node scripts/eatfirst.mjs login                       # log in, save session, exit
 *   node scripts/eatfirst.mjs order --config order.json   # log in and place the order
 *   node scripts/eatfirst.mjs order --config order.json --dry-run   # stop before the final confirm
 *   node scripts/eatfirst.mjs inspect [url]               # dump a page snapshot for debugging
 *
 * Environment:
 *   EATFIRST_EMAIL, EATFIRST_PASSWORD   credentials (never printed)
 *   EATFIRST_HEADED=1                   run with a visible browser
 *   EATFIRST_ARTIFACTS=dir              where screenshots/snapshots go (default ./artifacts)
 *
 * Every failure writes a screenshot and an ARIA snapshot to the artifacts directory and
 * exits non-zero, so a driving agent can read them and finish the flow by hand.
 */
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

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
const STORAGE_STATE_PATH = resolve('eatfirst-storage-state.json');
const ARTIFACTS_DIR = resolve(process.env.EATFIRST_ARTIFACTS ?? 'artifacts');

const log = (message) => console.log(`[eatfirst] ${message}`);

const parseArguments = (argv) => {
  const [command = 'order', ...rest] = argv;
  const options = { command, config: 'order.json', dryRun: false, url: undefined };
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === '--config') options.config = rest[++index];
    else if (argument === '--dry-run') options.dryRun = true;
    else if (!argument.startsWith('--')) options.url = argument;
  }
  return options;
};

const requireEnvironmentVariable = (name) => {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing environment variable ${name}`);
  }
  return value;
};

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
    .getByRole('button', { name: /log ?in|sign ?in|continue/i })
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
  await emailField(page).fill(email);
  await passwordField(page).fill(password);
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

const loadOrderConfig = (path) => {
  const config = JSON.parse(readFileSync(resolve(path), 'utf8'));
  if (!Array.isArray(config.items) || config.items.length === 0) {
    throw new Error('order config needs a non-empty "items" array (in order of preference)');
  }
  return config;
};

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

const selectDayIfConfigured = async (page, config) => {
  if (!config.day) return;
  const dayPattern = new RegExp(config.day, 'i');
  const clicked = await clickFirstMatching(page, [dayPattern], { roles: ['tab', 'button', 'link', 'radio'] });
  log(clicked ? `selected day "${config.day}"` : `no day selector matched "${config.day}", continuing`);
};

const alreadyOrdered = async (page, config) => {
  if (!config.ordersUrl || !config.day) return false;
  await page.goto(config.ordersUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  const existing = page.getByText(new RegExp(config.day, 'i')).first();
  return existing.isVisible({ timeout: 3_000 }).catch(() => false);
};

/**
 * Finds the menu item by its visible name, then the nearest "add" control in the same card.
 * Items are tried in order of preference; the first one available is added.
 */
const addFirstAvailableItem = async (page, config) => {
  const addPatterns = [/add to (cart|basket|order)/i, /^add$/i, /^\+$/, /order now/i, /select/i];
  for (const item of config.items) {
    const quantity = item.quantity ?? 1;
    const itemText = page.getByText(new RegExp(item.name, 'i')).first();
    if (!(await itemText.isVisible({ timeout: 3_000 }).catch(() => false))) {
      log(`"${item.name}" not on the menu, trying next preference`);
      continue;
    }
    const card = itemText.locator('xpath=ancestor-or-self::*[.//button or .//a][1]');
    const addButton = card
      .getByRole('button', { name: addPatterns[0] })
      .or(card.getByRole('button', { name: addPatterns[1] }))
      .or(card.getByRole('button', { name: addPatterns[2] }))
      .or(card.getByRole('button', { name: addPatterns[3] }))
      .or(card.getByRole('button', { name: addPatterns[4] }))
      .or(card.getByRole('button'))
      .first();
    if (!(await addButton.isVisible({ timeout: 3_000 }).catch(() => false))) {
      await itemText.click();
      if (!(await clickFirstMatching(page, addPatterns, { roles: ['button'] }))) {
        log(`found "${item.name}" but no add control, trying next preference`);
        continue;
      }
    } else {
      await addButton.click();
    }
    for (let extra = 1; extra < quantity; extra += 1) {
      await clickFirstMatching(page, [/increase|plus|^\+$/i], { roles: ['button'] });
    }
    log(`added "${item.name}" x${quantity}`);
    return item;
  }
  throw new Error('none of the configured items were available on the menu');
};

const checkout = async (page, { dryRun }) => {
  await clickFirstMatching(page, [/cart|basket|view order|checkout/i]);
  await page.waitForLoadState('networkidle').catch(() => undefined);
  if (dryRun) {
    await saveDiagnostics(page, 'dry-run-before-confirm');
    log('dry run: stopping before the final confirm');
    return false;
  }
  const confirmed = await clickFirstMatching(page, [/place order|confirm order|pay now|complete order|confirm/i], { roles: ['button'] });
  if (!confirmed) throw new Error('could not find a place-order/confirm button');
  await page.waitForLoadState('networkidle').catch(() => undefined);
  const success = page.getByText(/order (placed|confirmed|received)|thank you/i).first();
  if (!(await success.isVisible({ timeout: 15_000 }).catch(() => false))) {
    throw new Error('no order confirmation text appeared after confirming');
  }
  await saveDiagnostics(page, 'order-confirmation');
  return true;
};

const main = async () => {
  const options = parseArguments(process.argv.slice(2));
  const browser = await chromium.launch({
    headless: process.env.EATFIRST_HEADED !== '1',
    executablePath: existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined,
  });
  const context = await browser.newContext({
    locale: 'en-AU',
    timezoneId: 'Australia/Sydney',
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
    } else if (options.command === 'login') {
      await login(page);
    } else if (options.command === 'order') {
      const config = loadOrderConfig(options.config);
      await ensureLoggedIn(page);
      if (await alreadyOrdered(page, config)) {
        log(`an order for "${config.day}" already exists, nothing to do`);
      } else {
        await page.goto(config.menuUrl ?? CANTEEN_URL, { waitUntil: 'domcontentloaded' });
        await dismissCookieBannerIfPresent(page);
        await selectDayIfConfigured(page, config);
        const item = await addFirstAvailableItem(page, config);
        const placed = await checkout(page, options);
        log(placed ? `ORDER PLACED: ${item.name}` : `DRY RUN OK: ${item.name} is in the cart`);
      }
    } else {
      throw new Error(`unknown command "${options.command}"`);
    }
  } catch (error) {
    exitCode = 1;
    console.error(`[eatfirst] FAILED: ${error.message}`);
    await saveDiagnostics(page, 'failure');
  } finally {
    await browser.close();
  }
  process.exit(exitCode);
};

await main();
