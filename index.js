if (!process.env.GITHUB_ACTIONS) {
  require('dotenv').config({ quiet: true });
}

const fs = require('fs/promises');
const path = require('path');
const axios = require('axios');
const { chromium } = require('playwright');

const REGITRA_URL = 'https://www.eregitra.lt/services/vehicle-registration/data-search';

function requireEnv(name) {
  const value = process.env[name];
  if (!value || !String(value).trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function validateRequiredEnv() {
  requireEnv('REG_DOC_NUMBER');
  requireEnv('PLATE_NUMBER');
  requireEnv('TELEGRAM_BOT_TOKEN');
  requireEnv('TELEGRAM_CHAT_ID');
}

function parseStatus(text) {
  const compact = text.replace(/\s+/g, ' ').trim();
  const formatStatus = (value) => value.replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2').replace(/\s+/g, ' ').trim();

  return {
    insurance:
      formatStatus(compact.match(/Draudimas\s*(Galioja|Negalioja|Yra|Nėra)/i)?.[0] || '') ||
      'Nepavyko rasti draudimo statuso',
    technicalInspection:
      formatStatus(compact.match(/Technin[ėe]s?\s*apžiūra\s*(Galioja|Negalioja|Yra|Nėra)/i)?.[0] || '') ||
      'Nepavyko rasti techninės apžiūros statuso',
    trafficAllowance:
      formatStatus(compact.match(/Dalyvavimas\s*viešajame\s*eisme\s*(Leidžiamas|Draudžiamas)/i)?.[0] || '') ||
      'Nepavyko rasti leidimo dalyvauti eisme statuso',
  };
}

async function fillInputByLabel(page, labels, value) {
  for (const labelText of labels) {
    const input = page.locator(`label:has-text("${labelText}")`).locator('..').locator('input').first();
    if (await input.count()) {
      await input.fill(value);
      return true;
    }
  }
  return false;
}

async function fillFirstVisible(page, selectors, value) {
  for (const selector of selectors) {
    const input = page.locator(selector).first();
    if (await input.count()) {
      await input.fill(value);
      return true;
    }
  }
  return false;
}

async function acceptCookieBanner(page) {
  const selectors = ['button:has-text("Leisti visus slapukus")', 'button:has-text("Leisti pasirinkti")'];

  for (const selector of selectors) {
    const button = page.locator(selector).first();
    if (await button.count()) {
      await button.click();
      await page.waitForTimeout(1000);
      return;
    }
  }
}

async function checkAllBoxes(page) {
  const checkboxes = page.locator('input[type="checkbox"]');
  const count = await checkboxes.count();

  for (let i = 0; i < count; i += 1) {
    const checkbox = checkboxes.nth(i);
    if (!(await checkbox.isChecked())) {
      await checkbox.check();
    }
  }
}

async function runRegitraCheck() {
  const regDocNumber = requireEnv('REG_DOC_NUMBER');
  const plateNumber = requireEnv('PLATE_NUMBER');

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const context = await browser.newContext({
    locale: 'lt-LT',
    timezoneId: 'Europe/Vilnius',
    viewport: { width: 1280, height: 1600 },
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();

  try {
    await page.goto(REGITRA_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2000);

    await acceptCookieBanner(page);

    let filledRegDoc = false;
    let filledPlate = false;

    const registrationInput = page.locator('#registrationNo').first();
    if (await registrationInput.count()) {
      await registrationInput.fill(regDocNumber);
      filledRegDoc = true;
    }

    const plateInput = page.locator('#plateNo').first();
    if (await plateInput.count()) {
      await plateInput.fill(plateNumber);
      filledPlate = true;
    }

    if (!filledRegDoc) {
      filledRegDoc = await fillInputByLabel(
        page,
        ['Registracijos dokumento numeris', 'Registracijos dokumento Nr.'],
        regDocNumber
      );
    }

    if (!filledPlate) {
      filledPlate = await fillInputByLabel(
        page,
        ['Valstybinis numeris', 'Valstybinis registracijos numeris', 'Valst. numeris'],
        plateNumber
      );
    }

    if (!filledRegDoc) {
      filledRegDoc = await fillFirstVisible(
        page,
        [
          'input[name*="registration" i]',
          'input[id*="registration" i]',
          'input[name*="document" i]',
          'input[id*="document" i]',
          'input[placeholder*="Registracijos" i]',
        ],
        regDocNumber
      );
    }

    if (!filledPlate) {
      filledPlate = await fillFirstVisible(
        page,
        [
          'input[name*="plate" i]',
          'input[id*="plate" i]',
          'input[name*="number" i]',
          'input[id*="number" i]',
          'input[placeholder*="Valstybinis" i]',
        ],
        plateNumber
      );
    }

    if (!filledRegDoc || !filledPlate) {
      const pageTitle = await page.title().catch(() => 'unknown');
      const currentUrl = page.url();
      throw new Error(
        `Could not locate registration document or plate number fields. URL: ${currentUrl}. Title: ${pageTitle}`
      );
    }

    await checkAllBoxes(page);

    const submitButton = page
      .locator('button:has-text("Ieškoti"), button:has-text("Tikrinti"), input[type="submit"]')
      .first();

    if (!(await submitButton.count())) {
      throw new Error('Could not locate submit button.');
    }

    await Promise.all([
      page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {}),
      submitButton.click(),
    ]);

    await page.waitForTimeout(2500);

    const content = await page.textContent('body');
    const compactContent = (content || '').toLowerCase();
    if (
      compactContent.includes('what code is in the image') ||
      compactContent.includes('captcha') ||
      compactContent.includes('cloudflare') ||
      compactContent.includes('just a moment') ||
      compactContent.includes('verify you are human')
    ) {
      throw new Error('Automation blocked by anti-bot/CAPTCHA page on GitHub runner.');
    }

    return {
      checkedAt: new Date().toISOString(),
      status: parseStatus(content || ''),
    };
  } catch (error) {
    const debugDir = path.join(process.cwd(), 'debug');
    await fs.mkdir(debugDir, { recursive: true });

    try {
      await page.screenshot({ path: path.join(debugDir, 'failed-page.png'), fullPage: true });
      await fs.writeFile(path.join(debugDir, 'failed-page.html'), await page.content(), 'utf8');
    } catch (debugError) {
      console.error(`Debug capture failed: ${debugError.message}`);
    }

    throw error;
  } finally {
    await context.close();
    await browser.close();
  }
}

function buildMessage(result) {
  const insuranceStatus = (result.status.insurance || '').trim();
  const needsAttention = insuranceStatus !== 'Draudimas Galioja';

  return [
    needsAttention ? 'ATTENTION: Regitra status update' : 'Regitra status update',
    `Checked at: ${result.checkedAt}`,
    `Car insurance: ${result.status.insurance}`,
    `Tech apziura: ${result.status.technicalInspection}`,
    `Allowed in traffic: ${result.status.trafficAllowance}`,
  ].join('\n');
}

async function sendTelegram(message) {
  const token = requireEnv('TELEGRAM_BOT_TOKEN');
  const chatId = requireEnv('TELEGRAM_CHAT_ID');

  await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
    chat_id: chatId,
    text: message,
  });
}

async function main() {
  try {
    validateRequiredEnv();
    const result = await runRegitraCheck();
    await sendTelegram(buildMessage(result));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`Run failed: ${error.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  runRegitraCheck,
  sendTelegram,
  buildMessage,
};
