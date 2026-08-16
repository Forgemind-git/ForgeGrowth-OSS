# Putting a domain on an install that does not own ports 80 and 443

This is for servers that already run something on the public ports — Traefik, nginx, Caddy, another
app. `install.sh` detects that case and records `TLS_MODE=proxy` in `.env`, which means the bundled
Caddy is **not** started and this install cannot obtain its own certificate. It is reachable only at
`http://<server>:<WEB_PORT>` until you route a domain to it.

If your server had the ports free, you do not need any of this: `install.sh` set `TLS_MODE=caddy`,
and adding a domain in **Admin Settings → Domain** is the whole job — DNS, then open it in a
browser.

---

## What actually has to happen

Exactly one thing, and it is smaller than it looks:

> Something that already holds port 443 must accept `crm.example.com` and forward it to this
> install's **`web` container on port 80**.

Everything else — the certificate, HTTP→HTTPS redirects, compression — belongs to that existing
proxy and is not this install's business. There is nothing to configure inside the app beyond
adding the domain in Admin Settings so the API accepts requests from it.

Two routes into the container, in order of preference:

| | How the proxy reaches `web` | When to use it |
|---|---|---|
| **Docker network** | joins this install's `web` to the proxy's network, talks to it as `web:80` | the proxy runs in Docker on the same host — almost always the case |
| **Host port** | `http://127.0.0.1:${WEB_PORT}` | the proxy runs outside Docker (system nginx, for example) |

Prefer the network. A host port has to stay published, and a published port is one more way for
someone to reach the app over plain HTTP — see the warning about `WEB_BIND` at the end.

---

## Wiring it in without editing files this install owns

`install.sh` **re-downloads and overwrites `docker-compose.yml` on every upgrade**. Labels added
there survive until the next `./install.sh` and then vanish, usually months later, with no
connection between cause and effect. So server-specific configuration goes in a separate file that
Compose merges on top:

```bash
# in your install's .env — NOT exported in a shell
COMPOSE_FILE=docker-compose.yml:/opt/forge-growth-proxy.yml
```

The first entry must stay `docker-compose.yml`. Compose reads `.env` on every invocation, so
`docker compose`, `./up.sh` and `./install.sh` all pick the overlay up with nobody having to
remember a flag.

> **Why `.env` and not `export COMPOSE_FILE=…`?** An exported variable lives in one shell. The next
> person — or the same person after a reboot — runs `docker compose up -d` without it, and the stack
> comes up **healthy with no domain attached**: every container green, the site a 404. Nothing
> inside the stack can detect that, because from the inside nothing is wrong.

There is a ready-made Traefik overlay at [`examples/traefik-overlay.yml`](../examples/traefik-overlay.yml).

---

## Traefik

Traefik discovers routes from container labels over the Docker socket, so no Traefik restart is
needed and no Traefik file is edited. Copy the example, change the two hostnames, point
`COMPOSE_FILE` at it, then `docker compose up -d web`.

### The mistake that costs an afternoon

Writing one service per router looks obvious and silently breaks **both** routers:

```yaml
# ✗ WRONG — two services on one container
- traefik.http.services.mysite.loadbalancer.server.port=80
- traefik.http.services.mysite-alt.loadbalancer.server.port=80
```

Traefik links a router to a service automatically only when the container declares exactly one.
With two it cannot choose, so it discards both routers and logs a single line:

```
Router mysite-alt cannot be linked automatically with multiple Services: ["mysite-alt" "mysite"]
```

Every container stays healthy, and both hostnames return 404 from Traefik's catch-all — including
the one that worked a minute earlier. One service, named explicitly on each router:

```yaml
# ✓ RIGHT — one service, pointed at from both routers
- traefik.http.services.mysite.loadbalancer.server.port=80
- traefik.http.routers.mysite.service=mysite
- traefik.http.routers.mysite-alt.service=mysite
```

### Certificates, and when a `certresolver` is actively harmful

Traefik's ACME resolvers usually use **TLS-ALPN-01**, which proves ownership over a TLS connection
to port 443 of your server.

- **Domain resolves straight to your server** → keep `tls.certresolver`. It works.
- **Domain sits behind a CDN or proxy that terminates TLS** (Cloudflare's orange cloud, for
  example) → **remove `tls.certresolver`**. The challenge connection stops at the CDN and can never
  reach Traefik, so it fails on every attempt, forever. Those failures are rate-limited **per ACME
  account**, so enough of them leave every *other* domain on that server unable to renew. Use
  `tls=true` with no resolver: Traefik serves its self-signed default to the CDN, which accepts it,
  and the CDN gives the browser its own valid certificate.

A quick way to tell which situation you are in, from any machine:

```bash
dig +short crm.example.com          # your server's IP, or a CDN's?
echo | openssl s_client -connect <your-server-ip>:443 -servername crm.example.com 2>/dev/null \
  | openssl x509 -noout -issuer     # who issued what your server presents
```

If that prints `CN = TRAEFIK DEFAULT CERT` while the site loads fine in a browser, a CDN is
supplying the certificate and a `certresolver` on that router is pure waste.

---

## nginx

For an nginx that runs outside Docker, against the published host port:

```nginx
server {
    listen 443 ssl;
    server_name crm.example.com;

    ssl_certificate     /etc/letsencrypt/live/crm.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/crm.example.com/privkey.pem;

    # Media uploads. nginx defaults to 1 MB, which rejects files the app accepts.
    client_max_body_size 100M;

    location / {
        proxy_pass http://127.0.0.1:8080;          # WEB_PORT from .env

        # The app builds absolute URLs — payment links, public form pages — from
        # these. Without them it emits http:// links on an https:// site.
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host  $host;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;

        # Chat updates stream over a long-lived connection.
        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 600s;
    }
}
```

---

---

## Optional: let the app publish its own routes

Everything above is per-domain manual work. If this server's Traefik is yours to
configure, one setup makes it automatic: adding a domain in Admin Settings → Domain
then needs no shell at all, the same as on a server that owns ports 80/443.

Traefik can watch a **directory** for route files alongside the container labels it
already reads. Give it one this install can write to, and the app publishes a route
per domain you add — and deletes it when you remove the domain.

### What it can and cannot do

This matters more than the setup, because the directory is honoured by a Traefik
that also serves your other sites.

| | |
|---|---|
| Routes are generated from | `custom_domains` only — nothing reachable from a request, header or webhook |
| Route priority | **1**, the lowest Traefik accepts |
| Can it take a hostname another site already serves? | **No.** A router's default priority is its rule length (~30), so any existing router wins. The route applies only where nothing else claims the name |
| Can it delete other route files? | **No.** Only files carrying this install's own prefix, which is derived from its upstream container |
| Certificates | never requested on this path — a file-provider route cannot tell whether a CDN fronts the name, and guessing wrong burns a per-account ACME rate limit |

So it takes the domain you entered, and cannot take anybody else's.

### Setup — once per server

**1. Give Traefik a file provider.** Add to its flags:

```
--providers.file.directory=/dynamic
--providers.file.watch=true
```

and mount the directory into it:

```yaml
    volumes:
      - /opt/forgegrowth-routes:/dynamic
```

Traefik has to restart once for the flags (about five seconds). It keeps its
certificates — they live in its own volume.

**2. Point this install at the same directory**, in your `.env`:

```bash
TRAEFIK_DYNAMIC_DIR=/dynamic
PROXY_UPSTREAM=http://forgegrowth-web-1:80
PROXY_ROUTES_DIR=/opt/forgegrowth-routes
```

`PROXY_UPSTREAM` is how Traefik reaches this install over the shared network —
use the **container name**, not the compose service name. A service alias is not
unique once two installs share a network, and `web` would then resolve to
whichever container answered first.

Find it with:

```bash
docker compose ps --format '{{.Name}}' | grep web
```

**3. Mount the directory into this install** and join the proxy network, in an
overlay kept outside the install directory:

```yaml
# /opt/forgegrowth-routing.yml
services:
  backend:
    volumes:
      - ${PROXY_ROUTES_DIR}:${TRAEFIK_DYNAMIC_DIR}
  web:
    networks: [default, proxy_default]

networks:
  proxy_default:
    external: true
```

```bash
echo 'COMPOSE_FILE=docker-compose.yml:/opt/forgegrowth-routing.yml' >> .env
docker compose up -d
```

The route directory is deliberately **not** mounted by the shipped compose files:
the path exists only on a server whose proxy watches it, and it belongs in the same
overlay that adds the proxy's own flags so the two halves cannot drift apart.

### Confirming it is on

Admin Settings → Domain no longer offers a **Setup file** button, and the wording
changes to say routes are published automatically. Add a domain, point its DNS
here, press **Check**.

If a route does not appear, the backend log says why — a directory that is
read-only or unmounted is reported there and never turned into a failed request:

```bash
docker compose logs backend | grep '\[traefik\]'
```

---

## Finish in the app, then verify

1. **Admin Settings → Domain → add the hostname.** Until you do, the API refuses browser requests
   from it and sign-in fails with a generic error. It takes effect within ten seconds; nothing
   restarts.
2. **Press Check on that row.** The server fetches the domain from the outside and reports what
   came back:

   | Result | Meaning |
   |---|---|
   | Working over HTTPS | done — and it reached *this* install, not another one |
   | Reachable over plain HTTP only | routing is right, the certificate is missing |
   | Something answered, but it is not this install | the proxy has no route for it — usually a typo in the `Host` rule |
   | Another install answered | more than one install on this machine; the domain is on the wrong one |
   | Does not resolve | DNS |

Do not skip step 2 for a working page in your own browser. A page that loads proves the SPA was
served; it does not prove the API accepts that origin, and that is the half that breaks logins.

---

## One thing to change if you are strict about HTTPS

`install.sh` leaves `WEB_BIND=0.0.0.0` when it configures a plain-HTTP address, so
`http://<server>:<WEB_PORT>` keeps answering after you add a domain. That is safe **only while the
login cookie is not marked `Secure`**, which is the default in that configuration.

If you set `COOKIE_SECURE=true`, set `WEB_BIND=127.0.0.1` in the same change. Otherwise someone
signs in over the plain port, the browser silently discards the `Secure` cookie, and the app appears
to log them out on every refresh — with nothing in any log.

```bash
# in .env
WEB_BIND=127.0.0.1
COOKIE_SECURE=true
```

Then `./up.sh`.
