# Contributing to Hearth

Thanks for helping make Hearth better. Bug reports, ideas, translations,
documentation and code are all welcome.

## Never share real patient data

This applies to everything you post or commit: issues, discussions, pull
requests, commit messages, test fixtures, seed and demo data, screenshots,
logs and database dumps. **No real patient data, ever** — not names, not
dates of birth, not notes, not "anonymised" exports from a live clinic.
Use the fictional demo data (`node scripts/demo-data.mjs`) or invent obviously
fake records: `example.test` e-mail addresses and `555` phone numbers. If you
spot real data anywhere in the project, tell us privately at
[info@brightforgett.com](mailto:info@brightforgett.com) so we can remove it.

## Before you start

- **Questions and ideas:** open a [Discussion](../../discussions).
- **Bugs:** open an [Issue](../../issues/new/choose) with steps to reproduce,
  your Node.js and PostgreSQL versions, and how you run Hearth (Docker, Node
  behind a proxy, development server).
- **Security problems:** do **not** open a public issue — see
  [SECURITY.md](SECURITY.md).
- **Bigger changes:** open an issue or discussion first so we can agree on the
  approach before you spend time on it.
- **Out of scope:** clinical decision support of any kind (diagnosis,
  treatment, dosing or interaction advice). Hearth is administrative
  software and stays that way.

## Development setup

Requirements: Node.js 20+ (CI uses 22) and PostgreSQL 13+ (CI uses 17).

```bash
npm ci
cp .env.example .env          # set DATABASE_URL and JWT_SECRET
npm run build                 # once, so the API has a web app to serve
npm start                     # API + built app on http://127.0.0.1:8787
npm run dev                   # in a second terminal: Vite dev server with hot reload
node scripts/demo-data.mjs    # optional fictional demo clinic
```

The API applies migrations from `db/migrations/` and creates the seed accounts
on start-up. The dev server runs on <http://127.0.0.1:8080> and proxies `/api`
to the API on port 8787 (`VITE_DEV_API_URL` overrides the target); add
`http://127.0.0.1:8080` to `ALLOWED_ORIGINS` when using it.

### Checks

```bash
npm run lint
npm run typecheck
npm run build
npm test
```

`npm test` needs a reachable PostgreSQL. It uses `TEST_DATABASE_URL`, or
`DATABASE_URL` with `_test` appended to the database name, and **resets that
database** — it refuses to touch any database whose name does not end in
`_test`. A JUnit report is written to `reports/junit.xml`.

To get a throwaway PostgreSQL with Docker:

```bash
docker run --rm -d --name hearth-pg -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:5432:5432 postgres:17-alpine
```

## Pull requests

1. Fork the repo and create a branch from `main`.
2. Keep each PR focused on one change. Add or update tests in `tests/` for
   behaviour you change.
3. Make sure lint, typecheck, build and tests pass; CI runs all of them plus a
   Docker smoke test.
4. Describe *what* changed and *why* in the PR description, and link the
   issue it addresses.
5. Never commit `.env`, secrets, database dumps, uploads, logs — or real
   patient data.

### Rules the code must keep

- **Authorization lives in the API.** Every endpoint checks the session and
  role on the server; hiding a button in the web app is not access control.
- **Audit what touches patient data.** New writes to patient, clinical,
  billing, user or settings data, and new screens that open an individual
  patient record or note, must write an audit entry. Audit summaries list
  field *names*, never values.
- **The audit log is append-only.** Never add code that updates or deletes
  audit rows.
- **No new outside services by default.** Anything that sends data off the
  server must be off until the operator configures it, and must be documented
  in [docs/PRIVACY-AND-SECURITY.md](docs/PRIVACY-AND-SECURITY.md).
- **Schema changes are new migrations** in `db/migrations/` (next number);
  never edit a migration that has shipped.
- **Parameterised SQL only**; never build SQL from user input.
- **CSV output goes through `api/lib/csv.mjs`**, which neutralises
  spreadsheet formulas.
- **Never log request bodies, tokens or patient data.**

## Contributor Licence Agreement

Before we can merge your first pull request, you need to agree to the
[Contributor Licence Agreement](CLA.md). The CLA bot will comment on your PR
with a one-line sentence to post; you only do this once.

**Why a CLA?** Hearth is offered under the AGPL-3.0 and also under commercial
terms, which funds its development. The CLA lets BrightForge Technologies
include your contribution in both. You keep the copyright in your work.

## Code of conduct

Everyone taking part in this project is expected to follow our
[Code of Conduct](CODE_OF_CONDUCT.md).
