# Together

An independent browser-installed app for a shared daily money check-in on Windows and macOS. No ChatGPT login or Apple Developer membership required.

## Install
Open https://alextheweick-creator.github.io/together-money/ in Chrome or Edge and use Install app. Each person uses their own Together email/password account. One person creates a household and gives its one-use, 24-hour invite code to their partner.

Supabase's default email service restricts recipients. Configure custom SMTP for self-signup, or create the two confirmed accounts in Supabase Authentication > Users. Never send passwords or secret keys through chat or commit them here.

## Daily workflow
- Each newly connected bank starts with the previous 48 hours (including the boundary date when the bank supplies no time). Older unreviewed history stays stored outside the queue. New bank arrivals join batches on a shared 24-hour schedule. Released, unreviewed transactions remain indefinitely, newest first, even after missed days. Manual entries enter immediately.
- Done for today records a check-in without clearing unfinished work.
- Review purchase, refund, income, transfer, or repayment; choose a category and each person's share.
- Reports and budgets use reviewed transactions. Balances distinguish who paid from whose expense it was.
- Pending transactions wait for posting. Bank corrections reopen affected reviews.
- Transfers and card payments do not inflate spending. For a repayment appearing in both accounts, mark one side repayment and its matching side transfer.
- Amounts use integer cents with exact allocation of rounding.
- Reminders require notification permission and the app to remain open; they stop when you close it.

## Privacy
Financial data lives in the private Supabase database. GitHub Pages serves public code and public connection settings. The service worker caches only static interface files, never financial or authentication responses. Internet is required. Sample mode is disposable and does not save.

Authentication persists in your browser profile. Bank credentials go through Plaid Hosted Link; bank access tokens are encrypted on the server. The household function validates Supabase authentication and membership for every request. Direct table access is denied to browser roles. Its verify_jwt=false setting disables only the legacy gateway check; authentication is enforced inside the function.

## Plaid
Set Supabase Edge Function secrets:
- PLAID_CLIENT_ID
- PLAID_SECRET (Production secret for real banks)
- PLAID_ENV=production (sandbox is only for fake test banks)
- TOKEN_ENCRYPTION_KEY: 32 random bytes as base64. Already set for this deployment. Keep it stable; replacing it without re-encrypting existing tokens breaks bank connections.

Each person connects their own institutions while signed in. USD only. Do not connect a joint account twice. Each institution connection has one assigned payer. Opening the app, reaching a daily batch boundary while open, or pressing Sync retrieves transactions; sync does not run while both apps are closed. Accumulated history is retrieved on the next sync. Visible household state refreshes every 30 seconds. Disconnect banks before changing Plaid environments.

## Development and updates
Node 24:

```sh
npm ci
npm test
npm run build
npx vite preview --host 127.0.0.1 --port 5180
```

Build configuration comes from SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY, or ignored local desktop/service.json (see its example). Only publishable keys are accepted. Never bundle service-role or Plaid secrets. An optional Electron wrapper remains in source, but browser installation is the supported delivery path.

Pushing tested changes to main publishes via GitHub Pages. Increment the package version for patches. Open installations check on focus or hourly and show Update available / Apply. Applying reloads; save unfinished edits first. Running check-ins are not silently interrupted. Closed apps may start directly on the latest release when reopened.

Backend migrations and Edge Functions deploy separately. Keep changes compatible with the previous client. Browser origins are explicit in supabase/functions/household/index.ts; auth redirects are in supabase/config.toml. Free projects may pause after inactivity. Maintain independent database backups.

## Verification
Tests cover expense allocation, refunds, repayments, reviewed-only reports, persistent backlog, invitations, direct-table denial, stale edits, pending transactions, idempotent imports, and atomic sync cursors. The hosted service was tested with isolated temporary users and cleaned up. Real bank linking must be completed by each owner. Mac installation needs verification on a Mac.
