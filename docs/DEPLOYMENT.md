# Deploying Hearth

Hearth is one Node.js process (API under `/api`, web app on the same port)
plus a PostgreSQL database. A production install needs four things:

1. Hearth bound to a private address (`127.0.0.1` by default).
2. A reverse proxy that serves it over **HTTPS**.
3. A PostgreSQL database that **only Hearth can reach**.
4. Encrypted, off-site **backups** that you have restored at least once.

Read [PRIVACY-AND-SECURITY.md](PRIVACY-AND-SECURITY.md) first.

## Option A — Docker Compose

```bash
git clone https://github.com/brightforge-tech/hearth.git
cd hearth
cp .env.example .env
chmod 600 .env
```

Edit `.env`:

- `POSTGRES_PASSWORD` — a long random password for the bundled database.
- `JWT_SECRET` — `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
- `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, `SEED_STAFF_EMAIL`,
  `SEED_STAFF_PASSWORD` — your first accounts (both must change their password
  at first sign-in).
- `ALLOWED_ORIGINS` and `APP_BASE_URL` — your public URL, e.g.
  `https://clinic.example.com`.
- `CLINIC_NAME` and the `VITE_CLINIC_*` landing-page details.

`DATABASE_URL` and `HOST` are set by `docker-compose.yml`; you do not need them
in `.env`.

```bash
docker compose up -d --build
docker compose logs -f app       # wait for "api: listening on ..."
```

The app is published on `127.0.0.1:8787` only, and the database is not
published at all. Data lives in two named volumes: `hearth-db` (PostgreSQL)
and `hearth-data` (`/data/uploads`).

`VITE_CLINIC_*` values are baked into the web app when the image is built;
after changing them run `docker compose up -d --build` again.

**Updating:** `git pull && docker compose up -d --build`. Migrations run
automatically at start-up. Take a backup first.

## Option B — Node.js on a server

```bash
sudo useradd --system --home /opt/hearth --shell /usr/sbin/nologin hearth
sudo -u hearth git clone https://github.com/brightforge-tech/hearth.git /opt/hearth
cd /opt/hearth
sudo -u hearth npm ci
sudo -u hearth cp .env.example .env && sudo chmod 600 .env   # then edit it
sudo -u hearth npm run build
```

Create the database and a dedicated role (as the `postgres` superuser):

```sql
CREATE ROLE hearth LOGIN PASSWORD 'a-long-random-password';
CREATE DATABASE hearth OWNER hearth;
```

Set `DATABASE_URL=postgresql://hearth:…@127.0.0.1:5432/hearth` in `.env`. In
`postgresql.conf` keep `listen_addresses = 'localhost'` (or a private address)
and in `pg_hba.conf` allow only the Hearth host.

A systemd unit, `/etc/systemd/system/hearth.service`:

```ini
[Unit]
Description=Hearth
After=network.target postgresql.service

[Service]
User=hearth
WorkingDirectory=/opt/hearth
ExecStart=/usr/bin/node api/server.mjs
Environment=NODE_ENV=production
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/hearth/var
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now hearth
journalctl -u hearth -f
```

If you move `UPLOAD_DIR` outside `/opt/hearth/var`, add it to
`ReadWritePaths`.

**Updating:** back up, `git pull`, `npm ci`, `npm run build`,
`systemctl restart hearth`.

## Reverse proxy and HTTPS

Hearth expects to sit behind a proxy that terminates TLS. The live queue uses
a long-lived Server-Sent Events stream (`/api/realtime`), so the proxy must not
buffer responses.

### Caddy

Caddy obtains and renews certificates automatically:

```caddyfile
clinic.example.com {
    encode gzip
    reverse_proxy 127.0.0.1:8787 {
        flush_interval -1
    }
    header {
        Strict-Transport-Security "max-age=31536000"
        X-Content-Type-Options nosniff
        Referrer-Policy no-referrer
        X-Frame-Options DENY
    }
}
```

### nginx

```nginx
server {
    listen 80;
    server_name clinic.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name clinic.example.com;

    ssl_certificate     /etc/letsencrypt/live/clinic.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/clinic.example.com/privkey.pem;

    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy no-referrer always;
    add_header X-Frame-Options DENY always;

    client_max_body_size 10m;   # receipt images and signatures

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;          # live queue (Server-Sent Events)
        proxy_read_timeout 1h;
    }
}
```

Hearth reads the client address from `X-Forwarded-For` only when the request
comes from a proxy on the same host or a private network (`TRUST_PROXY`,
default `loopback, linklocal, uniquelocal`). It uses that address for sign-in
throttling, booking rate limits and the audit log. Run your reverse proxy on
the same host or private network, and never expose Hearth's port directly to
the internet.

Then set `ALLOWED_ORIGINS=https://clinic.example.com` and
`APP_BASE_URL=https://clinic.example.com` and restart Hearth.

For a clinic that only needs Hearth on its own network, the same applies:
use an internal hostname and a certificate from your internal CA, or reach
Hearth over a VPN. Do not serve health records over plain HTTP, even on a LAN.

## Backups

Back up **both** the database and the upload directory. Encrypt the result and
copy it off the server.

### Database

```bash
# Node install
pg_dump --format=custom --file=hearth-$(date +%F).dump "$DATABASE_URL"

# Docker Compose install
docker compose exec -T db pg_dump -U hearth --format=custom hearth > hearth-$(date +%F).dump
```

### Uploads

```bash
# Node install (default UPLOAD_DIR)
tar czf hearth-uploads-$(date +%F).tar.gz -C /opt/hearth var/uploads

# Docker Compose install
docker compose exec -T app tar czf - -C /data uploads > hearth-uploads-$(date +%F).tar.gz
```

### Encrypt and ship

For example with [age](https://age-encryption.org/) and a key kept off the
server:

```bash
age -r age1yourpublickey... -o hearth-$(date +%F).dump.age hearth-$(date +%F).dump
rm hearth-$(date +%F).dump
# then copy *.age to off-site storage (rclone, restic, your backup provider)
```

Run this daily from cron or a systemd timer, and rotate old copies according
to your retention policy.

### Restore test

At least every few months, restore the latest backup into a scratch database
and check that it opens:

```bash
createdb hearth_restore_check
pg_restore --no-owner --dbname=hearth_restore_check hearth-YYYY-MM-DD.dump
psql hearth_restore_check -c "select count(*) from patients;"
dropdb hearth_restore_check
```

To restore for real: stop Hearth, restore into an empty database with
`pg_restore --clean --if-exists`, restore the uploads archive into
`UPLOAD_DIR`, start Hearth.

## Audit log retention

The audit log is append-only: a trigger blocks `UPDATE` and `DELETE` for
everyone, including Hearth itself. If your retention policy requires removing
old entries, a database owner can do it deliberately, after exporting what
will be removed:

```sql
BEGIN;
ALTER TABLE audit_log DISABLE TRIGGER USER;
DELETE FROM audit_log WHERE at < now() - interval '3650 days';
ALTER TABLE audit_log ENABLE TRIGGER USER;
COMMIT;
```

Record that you did this, and why, in your own records.

## Checklist

- [ ] HTTPS in front; Hearth bound to `127.0.0.1` or a private network
- [ ] Database port not reachable from anywhere but Hearth
- [ ] `JWT_SECRET` long and random; `.env` mode `600`
- [ ] Seed passwords changed (Hearth forces this at first sign-in)
- [ ] `ALLOWED_ORIGINS` and `APP_BASE_URL` set to the public URL
- [ ] Disk / volume encryption on the server
- [ ] Daily encrypted off-site backups of database **and** uploads; a restore
      has been tested
- [ ] OS, Node.js, PostgreSQL and Docker images patched
- [ ] Optional integrations (e-mail, receipt scanning) switched on only with a
      provider agreement in place
