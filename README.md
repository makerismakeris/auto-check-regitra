# AUTO-CHECK (simple version)

Minimal Regitra checker:
- Opens Regitra page
- Checks vehicle status
- Sends Telegram message

No Docker, no AWS, no Lambda.

## 1) Local setup

```bash
npm install
npx playwright install chromium
cp .env.example .env
```

Then edit `.env` with:

```env
REG_DOC_NUMBER=your_registration_document_number
PLATE_NUMBER=your_plate_number
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
TELEGRAM_CHAT_ID=your_telegram_chat_id
```

Run once:

```bash
npm run check
```

## 2) Free hosting + daily schedule at 07:00

Use GitHub Actions (free for personal projects).

1. Push this project to GitHub.
2. In your repo, open `Settings -> Secrets and variables -> Actions`.
3. Add these secrets:
   - `REG_DOC_NUMBER`
   - `PLATE_NUMBER`
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
4. The included workflow file runs daily.

Workflow file:
- `.github/workflows/daily-check.yml`

Important time note:
- GitHub schedules are in UTC.
- Current schedule is `0 5 * * *` (05:00 UTC), which is:
  - 07:00 in Lithuania during winter (EET, UTC+2)
  - 08:00 in summer (EEST, UTC+3)

If you want exact 07:00 Lithuania all year, use two seasonal cron entries or switch to a scheduler with timezone support.
