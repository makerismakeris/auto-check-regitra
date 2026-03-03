require('dotenv').config();

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

  const page = await browser.newPage({
    viewport: { width: 1280, height: 1600 },
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  });

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

    if (!filledRegDoc || !filledPlate) {
      filledRegDoc = await fillInputByLabel(
        page,
        ['Registracijos dokumento numeris', 'Registracijos dokumento Nr.'],
        regDocNumber
      );

      filledPlate = await fillInputByLabel(
        page,
        ['Valstybinis numeris', 'Valstybinis registracijos numeris', 'Valst. numeris'],
        plateNumber
      );
    }

    if (!filledRegDoc || !filledPlate) {
      throw new Error('Could not locate registration document or plate number fields.');
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
    if ((content || '').toLowerCase().includes('what code is in the image')) {
      throw new Error('Automation blocked by anti-bot CAPTCHA challenge.');
    }

    return {
      checkedAt: new Date().toISOString(),
      status: parseStatus(content || ''),
    };
  } finally {
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
