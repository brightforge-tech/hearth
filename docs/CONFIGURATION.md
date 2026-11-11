# Configuration

Hearth reads its configuration from environment variables. A `.env` file in
the project root is loaded at start-up; a variable already set in the
environment wins over the line in the file. [`.env.example`](../.env.example)
is the template. Never commit `.env`.

Changing a variable needs a restart. The `VITE_*` variables are compiled into
the web app and need a rebuild (`npm run build`, or
`docker compose up -d --build`).

## Required

| Variable | Description |
|---|---|
| `DATABASE_URL` | `postgresql://user:password@host:5432/database`. If unset, the standard `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` are used. Hearth exits at start-up if the database is unreachable. |
| `JWT_SECRET` | Secret that signs session tokens; at least 32 random bytes, e.g. `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Without it every sign-in is refused. Changing it signs everyone out. |

## Server

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8787` | Port for the API and web app. `--port` on the command line overrides it. |
| `HOST` | `127.0.0.1` | Bind address. The Docker image sets `0.0.0.0` (inside the container); `docker-compose.yml` still publishes it on `127.0.0.1` of the host. |
| `ALLOWED_ORIGINS` | — | Comma-separated list of browser origins allowed to call the API, e.g. `https://clinic.example.com`. `*` is refused. |
| `APP_BASE_URL` | — | Public URL of the install, used to build password-reset links (`<APP_BASE_URL>/reset-password?token=…`). |
| `UPLOAD_DIR` | `var/uploads` | Directory for signature images and other uploads. Back it up with the database. Docker: `/data/uploads`. |

## Clinic details

| Variable | Description |
|---|---|
| `CLINIC_NAME` | Clinic name the API uses, for example in e-mails. |
| `VITE_CLINIC_NAME` | Full clinic name on the landing page. *Build-time.* |
| `VITE_CLINIC_SHORT_NAME` | Short name for headers and small screens. *Build-time.* |
| `VITE_CLINIC_PHONE`, `VITE_CLINIC_EMAIL`, `VITE_CLINIC_ADDRESS`, `VITE_CLINIC_HOURS` | Contact details on the landing page. *Build-time.* |

Unset values fall back to a fictional demo clinic. Currency, tax, working
hours and services are set in the app under **Settings**.

## Sign-in and sessions

| Variable | Default | Description |
|---|---|---|
| `SESSION_IDLE_MINUTES` | `30` | A session ends after this many minutes without a request. |
| `SESSION_MAX_HOURS` | `12` | A session ends this many hours after sign-in, active or not. |
| `LOGIN_MAX_FAILURES` | `5` | Failed sign-ins for one account before it is locked. Lockouts grow 1, 2, 4, 8 … up to 60 minutes; a successful sign-in resets the count. |
| `LOGIN_IP_MAX_FAILURES` | `20` | Failed sign-ins from one IP address within 15 minutes before that address is blocked. |
| `ALLOW_SELF_SIGNUP` | off | Keep off. When off, only administrators create accounts. |

Password rules are fixed: at least 12 characters, not only digits, not a
common password, not the same as the e-mail address.

## Seed accounts

On every start Hearth creates these accounts **if they do not exist**. An
existing account is never changed, so a password changed in the app survives
restarts.

| Variable | Default | Description |
|---|---|---|
| `SEED_ADMIN_EMAIL` | `admin@example.test` | First administrator. |
| `SEED_ADMIN_PASSWORD` | see `.env.example` | Its initial password. Set your own. |
| `SEED_STAFF_EMAIL` | `staff@example.test` | First clinical staff account. |
| `SEED_STAFF_PASSWORD` | see `.env.example` | Its initial password. Set your own. |
| `SEED_FORCE_PASSWORD_CHANGE` | on | Seeded accounts must choose a new password at first sign-in. Leave on. |

## Online booking

| Variable | Default | Description |
|---|---|---|
| `BOOKING_RATE_LIMIT_PER_HOUR` | `5` | Booking requests accepted from one IP address per hour. |

## Audit log

The audit log has no settings: it is always on, admin-only and append-only.
Hearth never prunes it; see [PRIVACY-AND-SECURITY.md](PRIVACY-AND-SECURITY.md#7-retention)
and [DEPLOYMENT.md](DEPLOYMENT.md#audit-log-retention) for retention.

## Network

| Variable | Default | Description |
|---|---|---|
| `TRUST_PROXY` | `loopback, linklocal, uniquelocal` | Which proxies may set `X-Forwarded-For` (the client IP feeds login throttling and the audit log). `false` trusts none; a number trusts that many hops. |

## E-mail (optional)

Off unless `RESEND_API_KEY` is set. When on, invoice and receipt e-mails
(containing the patient's name and billing details) and password-reset links
are sent through [Resend](https://resend.com), a third-party service.
Self-service password reset by e-mail is only offered when e-mail is on;
otherwise an administrator resets passwords.

| Variable | Description |
|---|---|
| `RESEND_API_KEY` | Resend API key. |
| `RESEND_FROM_INVOICE` | Verified sender for invoice e-mails, e.g. `Clinic Billing <billing@clinic.example.com>`. |
| `RESEND_FROM_RECEIPT` | Verified sender for receipt e-mails. |
| `RESEND_FROM_SYSTEM` | Verified sender for password-reset e-mails. |

## Receipt scanning (optional)

Off unless `RECEIPT_AI_API_KEY` is set. When on, the Expenses page offers
**Scan receipt**: the image is sent to the configured provider, which returns
suggested values for the form. Staff review them before saving.

| Variable | Default | Description |
|---|---|---|
| `RECEIPT_AI_API_KEY` | — | API key for the provider. |
| `RECEIPT_AI_BASE_URL` | `https://api.openai.com/v1` | Any OpenAI-compatible API, including a local model server (for example `http://127.0.0.1:11434/v1`). |
| `RECEIPT_AI_MODEL` | `gpt-4o-mini` | A model that accepts images. |

## Development and tests

| Variable | Description |
|---|---|
| `TEST_DATABASE_URL` | Database `npm test` resets. Default: `DATABASE_URL` with `_test` appended to the database name. Only names ending in `_test` are ever reset. |
| `JUNIT_OUTPUT` | Where `npm test` writes its JUnit report (default `reports/junit.xml`). |

## Docker Compose only

| Variable | Description |
|---|---|
| `POSTGRES_PASSWORD` | Password for the bundled PostgreSQL. Required. `docker-compose.yml` builds `DATABASE_URL` from it. |
