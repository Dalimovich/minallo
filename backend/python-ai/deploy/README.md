# Hetzner deployment

This package runs the Minallo AI service behind Caddy on a single Ubuntu VPS.
Caddy obtains and renews TLS certificates automatically. The API's port 8080 is
available only inside the Docker network; only ports 80 and 443 are public.

Keep Fly.io running until this deployment has passed production smoke tests.
This package does not migrate Supabase or change the frontend service URL.

## One-time server setup

Create an Ubuntu 24.04 server with at least 2 vCPU and 4 GB RAM. Point an `A`
record such as `ai.example.com` to its public IPv4 address. Allow inbound TCP
22, 80, and 443 and UDP 443 in the Hetzner firewall. Restrict SSH to your own IP
when possible.

Install Docker from Docker's official Ubuntu repository (including the Compose
plugin), then clone the repository as a non-root deployment user:

```bash
sudo mkdir -p /opt/minallo
sudo chown "$USER:$USER" /opt/minallo
git clone YOUR_REPOSITORY_URL /opt/minallo
cd /opt/minallo/backend/python-ai
cp .env.example .env
chmod 600 .env
```

For a private repository, use a read-only deploy key. Do not put a personal
access token in the clone URL or shell history.

## Environment

Edit `.env` and replace every placeholder. These deployment values are also
required:

```dotenv
AI_DOMAIN=ai.example.com
ACME_EMAIL=admin@example.com
ENVIRONMENT=production
```

`INTERNAL_SECRET` must exactly match the value used by the Cloudflare Functions
layer. The Supabase service-role and OpenAI keys must remain server-side. Never
commit `.env`.

Before the first deployment, verify that DNS resolves to this server:

```bash
getent ahosts ai.example.com
```

## Deploy and update

Make the updater executable once, then run it from the repository checkout:

```bash
chmod +x backend/python-ai/deploy/update.sh
cd backend/python-ai
./deploy/update.sh
```

The updater refuses tracked local changes, fast-forwards from the current Git
branch, builds a revision-tagged image, starts the services, and checks the
public HTTPS health endpoint. If health fails and the prior image remains on
the server, it restores that API image. It does not roll back source files.

Useful operations:

```bash
docker compose --env-file .env ps
docker compose --env-file .env logs -f --tail=100 api caddy
curl --fail https://ai.example.com/health
docker compose --env-file .env restart api
```

Do not run `docker compose down -v`; `-v` deletes Caddy's certificate data.

## Cutover and rollback

After testing health, streaming, PDF indexing, OCR, and content generation,
change the Cloudflare production `AI_SERVICE_URL` to this HTTPS hostname and
deploy the frontend/functions. Keep Fly available for 48-72 hours so changing
that variable back provides a quick rollback.

The application currently runs indexing work in its own processes. Do not use
scale-to-zero, and avoid restarting during indexing. Compose allows 150 seconds
for graceful shutdown, but an indexing background task can run longer and may
still be interrupted; the application's recovery queue must remain enabled. A
4 GB server is a starting size; watch memory during OCR and move to a larger
instance if the kernel logs out-of-memory kills. The initial configuration
permits only one indexing operation per API worker process; because Gunicorn
runs two workers, the host-wide maximum is two.

## Backups and monitoring

Enable Hetzner server backups, but treat them as only one recovery layer. The
application remains dependent on Supabase data and storage, whose backup policy
must be managed separately. Configure uptime monitoring for `/health`, Docker
log collection, and disk/memory alerts before production traffic.
