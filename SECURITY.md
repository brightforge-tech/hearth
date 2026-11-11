# Security policy

Hearth stores health records: patient details, clinical notes and billing. A
vulnerability in it can expose some of the most sensitive data people have.
We take security reports seriously and appreciate responsible disclosure.

## Reporting a vulnerability

**Please do not report security problems in public issues, discussions or
pull requests.**

1. Preferred: use GitHub's private reporting — go to the **Security** tab of
   this repository and choose **Report a vulnerability**.
2. Or email [info@brightforgett.com](mailto:info@brightforgett.com) with the
   subject line `SECURITY: Hearth`.

Please include:

- what the problem is and what an attacker could do with it (for example:
  read another clinic user's patient records, bypass a role, avoid the audit
  log);
- steps to reproduce, or a proof of concept;
- the Hearth version or commit, Node.js and PostgreSQL versions, and how it is
  run (Docker, Node behind a reverse proxy, development server).

**Never include real patient data** in a report. Reproduce with the fictional
demo data (`node scripts/demo-data.mjs`) or records you made up. If you came
across real health data while testing someone else's install, stop, do not
keep copies, and tell us and the operator.

## What to expect

- We acknowledge reports within **3 business days**.
- We aim to confirm the issue and share a fix plan within **14 days**.
- We will credit you in the release notes unless you prefer to stay
  anonymous.
- Please give us reasonable time to release a fix before disclosing the
  issue publicly. We aim for no more than **90 days**.

## Supported versions

Security fixes are made on the latest release only.

## Scope

In scope: this repository's code — the API, the web app, the database
migrations (including the audit-log protections), the Docker image and
compose file, and the scripts in `scripts/`.

Out of scope: vulnerabilities in Node.js, PostgreSQL, npm packages we have not
modified, or your hosting provider (report those to their vendors — but do
tell us if Hearth is affected); installs that ignore the deployment guide (no
HTTPS, a database reachable from the internet, a missing or weak
`JWT_SECRET`); attacks that need an already signed-in administrator account
or direct database access; and the absence of features listed as known
limitations in [docs/PRIVACY-AND-SECURITY.md](docs/PRIVACY-AND-SECURITY.md#9-known-limitations)
(such as two-factor sign-in).

## Hardening checklist for operators

- Serve Hearth only over HTTPS, through one reverse proxy.
- Never expose the PostgreSQL port; only Hearth may connect to the database.
- Use a long random `JWT_SECRET` and keep `.env` readable only by the service
  account.
- Change the seed account passwords (Hearth forces this at first sign-in) and
  give each person their own account with the lowest role that works.
- Leave `ALLOW_SELF_SIGNUP` off.
- Encrypt disks and backups; keep backups off-site and test restores.
- Never load `scripts/demo-data.mjs` into a live clinic database.
- Keep the OS, Node.js, PostgreSQL and Hearth up to date.

The full guide is in [docs/PRIVACY-AND-SECURITY.md](docs/PRIVACY-AND-SECURITY.md)
and [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
