# Together

An independent Windows and macOS desktop app for a short, shared daily money check-in. No ChatGPT login is used.

## Daily workflow
- The review inbox contains **every unreviewed transaction**, oldest first, regardless of age.
- Missed days accumulate. “Done for today” records a check-in without clearing unfinished work.
- Confirm purchase, refund, income, transfer, or repayment; select a category and each person's percentage.
- Approved transactions drive monthly budgets, category charts, cumulative spending, and the all-history balance between partners.
- Pending bank transactions wait for posting before review. Bank corrections re-open affected reviews.
- Transfers and card payments do not inflate spending. A repayment appearing in both connected accounts must be counted once: categorize one side as repayment and its matching side as transfer.
- Amounts are stored in integer cents. Split rounding always preserves the original total.

## Install and sign in
Get installers from this repository's Releases page. Each person has a separate email/password login. The first person creates the household and gives its one-use, 24-hour invite code to their partner.

The household data lives in your Supabase project, not on ChatGPT. Internet is required for real data. Sample mode uses disposable, clearly labeled data and does not save. Authentication tokens are encrypted by the operating system's secure storage. Bank credentials are entered in Plaid's hosted flow in your browser; long-lived Plaid tokens remain encrypted on the server.

**Current release limitations:** Windows test builds are not publisher-signed. macOS distribution and built-in automatic updates need Apple Developer signing and notarization before a supported Mac release can be published. Live Plaid syncing requires credentials and Trial or Production access; without them, manual transactions and sample mode work.

## Household service
1. Create a Supabase project.
2. Authenticate the official Supabase CLI.
3. Link the project, apply `supabase/migrations`, and deploy the `household` function:
   ```sh
   npx supabase link --project-ref YOUR_PROJECT
   npx supabase db push
   npx supabase functions deploy household --use-api
   ```
4. Keep the function's `verify_jwt = false` configuration. This disables the legacy gateway JWT check only; the function **independently validates every request with Supabase Auth getUser** and checks household membership. Financial tables deny direct access to anon and authenticated roles. Only the authenticated function uses the server-side service role.
5. Configure email authentication. Supabase's built-in email service may restrict recipients; for this two-person app you can create confirmed users in Authentication > Users, or configure custom SMTP for self-signup and password recovery. No paid Supabase tier is required merely for two users.
6. Set app public configuration as shown in `desktop/service.example.json`. The publishable key is not a server secret. Never include service-role, Plaid, signing, or GitHub tokens in the app.

Free-tier projects can pause during inactivity. Maintain separate database backups. Your backlog remains in the database; it does not depend on daily app use.

## Plaid setup
Set these **Supabase Edge Function secrets**, not desktop settings:
- `PLAID_CLIENT_ID`
- `PLAID_SECRET`
- `PLAID_ENV=production` for real banks, or `sandbox` for test data
- `TOKEN_ENCRYPTION_KEY`: 32 random bytes encoded as base64. Set once and keep it stable. Rotating it without re-encrypting tokens breaks existing bank connections.

The initial deployment configured the encryption key already. Do not overwrite it.

Each person connects their own bank while signed into their own app account. The app opens Plaid Hosted Link in the system browser and polls for completion. USD accounts only; connect each account once and do not connect a joint account twice. Each connected institution is assigned one owner in this first version. Transactions sync on app opening and on demand, not continuously while both apps are closed. Plaid's cursor sync retrieves the accumulated history at the next check-in. State refreshes every 30 seconds while the app is visible.

Sandbox and Production use separate tokens. Do not switch an existing household's Plaid environment after connecting banks; disconnect those connections first.

## Development
Node 24 and npm:
```sh
npm ci
npm test
npm run build
npm start
```
`npm run dev` runs a browser preview of sample mode. Native sign-in, secure credentials, notifications, and updater APIs only exist in Electron.

`npm run dist:win` produces an NSIS installer. `npm run dist:mac` must run on macOS with signing/notarization configured for a supported release.

## Patches and automatic updates
The source is in this repository. Ask your coding assistant to open this repository and make a patch; it needs GitHub publishing authorization, not access to your bank password.

1. Implement the patch, run tests, and increment `package.json` and the lockfile version.
2. Build Windows and Mac installers. The supplied GitHub Actions workflow runs on tags `v*`.
3. Review the draft release and publish it only after its installers and update manifests have finished uploading.
4. Running apps check on launch, focus, and hourly. The banner says **Update available**. Download it, then choose **Restart & install**. It does not silently interrupt an unfinished review.
5. Database migrations and Edge Function changes deploy separately; use additive migrations compatible with the previous client before publishing a new client.

Repository variables: `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`.
Mac release secrets: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`.
`CSC_LINK` contains or refers to a Developer ID Application certificate exported as .p12. Do not commit it.
GitHub's workflow token is used only during release publishing, never installed on either computer. Code and installers are public; private financial records and secrets are not in this repository.

Mac release publishing deliberately stops if signing credentials are missing. Windows unsigned builds are suitable for evaluating the app, but publisher signing is recommended before wider distribution.

## Verification
Automated tests cover money allocation, refunds, repayments, pending/removed transactions, monthly reports, one-use invites, two-person household limits, direct-table denial, stale edits, persistent backlog, idempotent imports, and atomic cursor advancement. The initial hosted service was also checked with isolated temporary users, then cleaned up. Real bank connections and Mac installation require their respective external setup before end-to-end validation.

