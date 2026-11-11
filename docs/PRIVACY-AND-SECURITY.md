# Privacy and security

This document is for the people who run Hearth: the clinic owner, practice
manager or IT provider. It explains what Hearth stores, what it logs, which
outside services it can talk to, and what you need to do to host it safely.

## 1. What Hearth is — and is not

Hearth is **administrative software** for a small clinic: patient register,
appointments, intake, visit notes, billing and expenses.

- **It is not a medical device.** It has not been certified or registered as
  one anywhere.
- **It gives no clinical decision support.** It does not diagnose, suggest
  treatment, check doses, allergies or interactions, or interpret results. It
  stores what your staff type.
- **It is provided without warranty** under the GNU AGPL v3.0 (sections 15
  and 16).

## 2. Who is responsible

The clinic (or other organisation) that runs Hearth is the **data controller**
for everything stored in it. You decide who has an account, where Hearth is
hosted, how long records are kept, and which optional integrations are
switched on.

You are responsible for complying with the health-record, data-protection and
privacy laws that apply to you — for example HIPAA, the GDPR, or your local
data-protection act — including any requirements on consent, patient access
requests, breach notification, record retention, hosting location and
contracts with service providers. Hearth gives you tools (roles, an audit log,
exports, deletion) but installing it does not make a clinic compliant. Take
advice where you need it.

BrightForge Technologies does not receive any data from installs of the open
source software. If BrightForge hosts Hearth for you under a separate
agreement, that agreement sets out its role.

## 3. What data Hearth stores

All of it lives in your PostgreSQL database, except uploaded files, which live
in `UPLOAD_DIR`.

| Data | Examples |
|---|---|
| **Patients** | Name, date of birth, sex, phone, e-mail, address, national ID and driver's permit numbers (optional). |
| **Appointments** | Date and time, status, reason for the visit, walk-in or booked, intake notes. |
| **Visit notes** | Clinical notes, signature image (file in `UPLOAD_DIR`), time of signing. |
| **Billing** | Invoices and line items, payments, payment references. |
| **Expenses** | Description, amount, category, date, reference, notes. Receipt images are sent to the AI provider only if scanning is on; Hearth does not keep them. |
| **Booking requests** | What a member of the public typed on the landing page: name, e-mail, phone, date of birth, reason, preferred date and time — plus the review outcome. |
| **Staff accounts** | E-mail, role, Doctor tag, scrypt password hash, last sign-in, server-side sessions, sign-in throttling counters, hashed password-reset tokens. |
| **Audit log** | See below. |
| **Settings** | Currency, tax, working hours, services and prices. |

Visit notes, intake notes and the reason for a visit are free text: anything a
clinician types there is stored as written. Hearth does not encrypt individual
fields; protect the database and its disk (section 5).

## 4. What is logged

### Audit log (in the database)

The `audit_log` table records:

- **who** (user id, e-mail and role at the time), **when**, and the **IP
  address**;
- the **action**: `view`, `create`, `update`, `delete`, `export`, `login`,
  `login_failed` or `logout`;
- the **record**: entity type and id;
- a **summary** listing the *names* of the fields that changed — never their
  old or new values, and never clinical content.

What is recorded:

- every create, update and delete of patients, appointments, visit notes,
  intake notes, invoices, payments, expenses, users and roles, settings and
  booking requests (including approvals and declines);
- every opening of an individual patient record, visit note or intake note;
- every CSV export (including export of the audit log itself);
- every sign-in, failed sign-in and sign-out.

The table is append-only: a database trigger rejects `UPDATE` and `DELETE`, so
rows cannot be changed or removed through the application or by an ordinary
SQL client. Administrators can search it (by date, user, action and record) on
the **Audit log** page and export it to CSV.

### Server request log (standard output)

One line per HTTP request: method, path, status code and duration. Request
and response bodies, headers, cookies and tokens are never logged. Paths can
contain record ids (UUIDs) but not names or clinical content. Where this log
goes and how long it is kept depends on how you run Hearth (systemd journal,
`docker compose logs`, your log collector) — set a retention period there.

## 5. Hosting guidance

Hearth is only as safe as the server it runs on. As a minimum:

- **HTTPS only.** Put a reverse proxy (Caddy, nginx) in front of Hearth that
  terminates TLS; keep Hearth itself bound to `127.0.0.1` or a private
  network. See [DEPLOYMENT.md](DEPLOYMENT.md).
- **No public database.** Hearth does not use PostgreSQL row-level security —
  all access control is in the API. Anyone who can connect to the database can
  read everything. Never publish port 5432; allow only the Hearth server to
  connect, with a strong password. The supplied `docker-compose.yml` does not
  publish the database port.
- **Encrypt at rest.** Use full-disk or volume encryption for the database,
  `UPLOAD_DIR` and backups.
- **Encrypted, off-site backups — and test restores.** Back up the database
  and `UPLOAD_DIR` daily, encrypt the backups, keep a copy off the server, and
  restore one into a scratch database regularly to prove it works.
- **Patch.** Keep the OS, Node.js, PostgreSQL, Docker images and Hearth itself
  up to date.
- **Secrets.** Keep `JWT_SECRET`, database passwords and API keys in `.env`
  (readable only by the service account) or a secrets manager — never in git,
  tickets or chat. Rotating `JWT_SECRET` signs everyone out.
- **Least privilege.** Give each person their own account with the lowest role
  that lets them work (Clinical staff, Billing/front office, Administrator).
  Keep administrators few. Visit notes can be read and written only by
  administrators and accounts with the **Doctor** tag; tag only the clinicians
  who need them. Disable accounts of people who leave. Run Hearth as
  an unprivileged OS user (the Docker image runs as `node`).
- **CORS and links.** Set `ALLOWED_ORIGINS` to exactly your Hearth URL and
  `APP_BASE_URL` to the same, so password-reset links point at the right site.
- **Shared screens.** Leave the idle timeout (`SESSION_IDLE_MINUTES`) short
  on reception PCs, and lock screens when stepping away.

## 6. Third parties

**By default Hearth contacts no outside service.** Two optional integrations
can be switched on; each sends data to a third party, so check that you have a
lawful basis and an appropriate agreement with that provider first.

| Integration | Switched on by | What is sent |
|---|---|---|
| **E-mail via Resend** | `RESEND_API_KEY` | The recipient's address and the e-mail content: for invoices and receipts that includes the **patient's name**, invoice lines, amounts and payment details; for password resets, the staff member's address and a reset link. |
| **Receipt scanning** | `RECEIPT_AI_API_KEY` | The **receipt image** you upload on the Expenses page, sent to `RECEIPT_AI_BASE_URL` (default OpenAI). Point it at a model server on your own network to keep images in-house. Do not scan documents that show patient information. |

The web app loads no third-party scripts, fonts or analytics.

## 7. Retention

Hearth does not delete anything on a schedule by itself. Decide, document and
apply retention periods that meet your legal obligations:

- **Patient and clinical records.** Many jurisdictions require medical records
  to be kept for a minimum number of years (often longer for minors). Keep
  them for that period; delete them when it ends and nothing requires you to
  keep them.
- **Audit log.** Keep it at least as long as your law or policy requires
  access to be accountable — often the same period as the records it covers.
  Hearth never deletes audit rows itself; the log is kept for ever unless you
  prune it. Because the table is append-only, pruning is a deliberate
  database-administrator task (see [DEPLOYMENT.md](DEPLOYMENT.md#audit-log-retention)).
- **Booking requests.** These come from members of the public who may never
  become patients. Delete **declined** and stale pending requests once you no
  longer need them — for example after 30–90 days.
- **Uploads.** Signature images belong to their visit notes; delete them with
  the record. Expense receipt images are not stored.
- **Backups.** Rotate them (for example 30 daily, 12 monthly) and remember
  that a deleted record survives in older backups until those expire.
- **Server logs.** Keep request logs for a short, fixed period.

## 8. If something goes wrong

If you suspect a breach — a lost laptop with a session open, a leaked
password, a database exposed to the internet, unexpected entries in the audit
log:

1. **Contain.** Disable affected accounts or reset their passwords (this
   revokes their sessions). To sign everyone out at once, change `JWT_SECRET`
   and restart. Close any exposed port.
2. **Preserve evidence.** Export the audit log for the relevant period and
   keep the server logs before they rotate. Do not wipe the server.
3. **Assess.** Use the audit log to work out which records were viewed,
   changed or exported, by whom and from where.
4. **Notify.** Follow your legal duties — many laws require telling a
   regulator and the affected patients within a fixed time.
5. **Fix and review.** Patch, rotate secrets, restore from a known-good
   backup if needed, and record what you learned.

If you believe the problem is a vulnerability in Hearth itself, report it
privately as described in [SECURITY.md](../SECURITY.md).

## 9. Known limitations

- **No two-factor sign-in yet.** Use long, unique passwords and keep Hearth
  behind HTTPS. Two-factor sign-in is on the roadmap; until then you can add a
  second factor in front of Hearth (VPN, or an identity-aware proxy).
- **No field-level encryption.** Clinical notes are stored as plain text in
  the database; protection relies on database access control and disk
  encryption.
- **Administrators can see everything**, including the audit log. Their
  actions are logged too, but they are trusted users.
- **Reads in list views are logged at summary level.** Opening an individual
  patient record, visit note or intake note is logged per record; lists and
  screens that show many patients at once (queue, calendar, patient search)
  are not logged row by row.
- **Database administrators bypass the application.** Anyone with direct
  database access can read data without an audit entry, and a database
  superuser can disable the audit trigger. Restrict and monitor such access.
- **Single clinic per install.** There is no separation between branches.
- **Session tokens are held by the browser** for the life of the session;
  sign out on shared computers.
