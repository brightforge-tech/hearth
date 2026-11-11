## What and why

<!-- What does this change, and what problem does it solve? Link the issue: "Fixes #123". -->

## How I tested it

<!-- Tests added or updated, and anything you checked by hand in the browser. -->

## Checklist

- [ ] **No real patient data** anywhere in this PR — code, fixtures, screenshots, logs or description
- [ ] `npm run lint`, `npm run typecheck`, `npm run build` and `npm test` pass
- [ ] New behaviour has tests
- [ ] Role checks are enforced in the API, not only in the web app
- [ ] New writes to patient, clinical, billing, user or settings data (and new single-record reads) are audit-logged, with field names only
- [ ] Schema changes are a new migration in `db/migrations/`
- [ ] No new outside service is contacted unless the operator configures it (and it is documented in `docs/PRIVACY-AND-SECURITY.md`)
- [ ] No secrets, `.env`, dumps or uploads are included
- [ ] I have signed the [CLA](../CLA.md) (the bot will ask on your first PR)
