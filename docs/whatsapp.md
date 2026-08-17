# Connecting WhatsApp

The app does nothing useful until a WhatsApp Business number is attached. This page covers a server
install and the tunnel loop a laptop needs.

## What you need from Meta

A Meta app with the WhatsApp product enabled, and from it:

| | |
|---|---|
| **Phone Number ID** | the number that will send and receive |
| **WABA ID** | the WhatsApp Business Account it belongs to |
| **System User access token** | a long-lived token, not the 24-hour one on the API Setup screen |

## Three steps

### 1. Add the account

**Admin Settings → WhatsApp Accounts → Add.** Paste the display number (digits only), Phone Number
ID, WABA ID, App ID and access token. The token is encrypted at rest with AES-256-GCM.

### 2. Point Meta's webhook at this install

In **Meta Business Suite → WhatsApp → Configuration**:

| Field | Value |
|---|---|
| Callback URL | `https://<your-domain>/api/webhook/whatsapp` |
| Verify token | the value of `META_WEBHOOK_VERIFY_TOKEN` in `.env` |
| Subscribe to | `messages` |

That single `messages` field covers messages, statuses, echoes and template events. You do not need
the others.

### 3. Prove it works

**Admin Settings → Webhooks → Send Test Webhook**, and pick "Incoming text message". A row should
appear in the audit log with `processed` status and `records_extracted=1`.

Multiple numbers are supported. Each carries its own encrypted token and its own webhook verify
token.

---

## Connecting WhatsApp to a laptop — ngrok

Meta will not accept a `localhost` or plain-HTTP callback, so a laptop needs a public HTTPS address
borrowed from a tunnel.

> **Use Meta's test number, not a live one.** Every Meta app includes one free, on its own WhatsApp
> Business Account. Because `override_callback_uri` is set per WABA rather than per phone number, that
> keeps your experiment independent of any production number. A laptop also sleeps, and inbound
> messages arriving then are **lost rather than queued**.

### 1. Install and authenticate ngrok

```bash
brew install ngrok                        # macOS; on Windows install it inside WSL2
ngrok config add-authtoken <your-token>   # dashboard.ngrok.com → Your Authtoken
```

### 2. Claim a static domain

At *dashboard.ngrok.com → Domains → New Domain*. **The free tier includes one, and you want it** —
without it the URL changes on every restart and you re-point the Meta webhook each time.

```bash
ngrok http --url=your-name.ngrok-free.app 8080     # use the port your install reported
```

### 3. Run Meta's handshake yourself, before touching Meta

This is byte-for-byte the request Meta sends when you press *Verify and save*. It turns a slow silent
failure into a one-second answer:

```bash
cd ~/forge-growth
TOKEN=$(grep '^META_WEBHOOK_VERIFY_TOKEN=' .env | cut -d= -f2-)
curl -s "https://your-name.ngrok-free.app/api/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=$TOKEN&hub.challenge=42"
```

It should print exactly `42`.

This works with **no WhatsApp account configured yet** — the check falls back to the token in `.env`
— so you can prove the tunnel before credentials are involved. That separates "my tunnel is wrong"
from "my credentials are wrong", which is otherwise the same silent failure.

### 4. Configure Meta

| Field | Value |
|---|---|
| Callback URL | `https://your-name.ngrok-free.app/api/webhook/whatsapp` |
| Verify token | the `META_WEBHOOK_VERIFY_TOKEN` you just used |
| Subscribe to | `messages` |

### 5. Watch the traffic

Open **`http://127.0.0.1:4040`** — ngrok's inspector shows each request with its full body and lets
you replay them. It is the most useful tool in this loop by a distance.

---

## Three things that bite

**Opening the interface *through the tunnel*** rather than through `localhost` requires adding
`your-name.ngrok-free.app` in **Admin Settings → Domain**. Otherwise API calls from that origin are
refused, and the refusal reaches the login screen as *"Incorrect email or password"* — which sends
you looking at the wrong thing entirely.

**Closing the ngrok terminal kills the tunnel silently.** Nothing in the app will tell you.

**The token on Meta's API Setup screen expires after 24 hours.** When inbound stops for no apparent
reason, that is usually why. Use a System User token for anything you intend to keep.
