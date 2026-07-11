# Relay

`steward-relay` converts GitHub App review, review-comment, and review-thread webhooks into the stable `pr-review-state-changed` repository dispatch used by Steward Governance and Matrix workflows.

The Worker derives repository identity from the signed webhook payload, creates an installation token restricted to that repository ID, and reads `.github/steward.json` from the repository default branch. It dispatches only when the strict Manifest parser accepts the document and `features.webhookRelay` is `true`.

SQLite Durable Objects serialize `<repository_id>:<delivery_id>` claims. Successful dispatches remain deduplicated for 24 hours; rejected opt-in checks and failed GitHub operations release the claim so a later corrected redelivery can retry. The Worker has no `TARGET_REPOSITORY`, scheduled trigger, polling loop, or consumer-specific repository policy.

Runtime secrets:

- `GITHUB_WEBHOOK_SECRET`
- `GITHUB_APP_ID`
- `GITHUB_APP_PRIVATE_KEY` (PKCS#8 PEM for Worker WebCrypto compatibility)

Deployment credentials are repository Actions Secrets `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`. Deploy with `npm run deploy:relay`; deployment does not overwrite runtime secrets.

The GitHub App needs Pull requests read for subscribed review events and Contents write for repository dispatch. Each Worker installation token requests only Contents write and is restricted to the signed payload repository ID.

Local validation:

```text
npm run test:relay
npm run typecheck
npm run verify:workflows
```
