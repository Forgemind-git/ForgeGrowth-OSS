# Connecting Claude to Forge Growth (MCP over OAuth)

Forge Growth exposes its data and actions to Claude as a **custom connector** over MCP. This is the
setup guide plus the things that will bite you if you change the implementation.

- **Server URL:** `https://growth.example.com/api/mcp`
- **Auth:** OAuth 2.1 (authorization code + PKCE `S256`), or a legacy key in the URL
- **Tools exposed:** 44, each gated by a capability toggle

---

## Setting it up

1. **Admin Settings → MCP Tools.** Turn on the master switch, then enable only the capabilities you
   want. They are global — turning one off later applies immediately to every connected client.
2. **Create an OAuth client** in the *OAuth clients* panel. The Client Secret is displayed **once**;
   only a SHA-256 hash is stored, so it cannot be recovered afterwards.
3. **In Claude → Settings → Connectors → Add custom connector:**
   - *Remote MCP server URL* → `https://growth.example.com/api/mcp`
   - *Advanced settings* → paste the **OAuth Client ID** and **OAuth Client Secret**
4. Press **Add**, then **Connect**. A Forge Growth window opens asking you to allow access — you must
   already be signed in to Forge Growth in that browser. Approving returns Claude to its callback
   with an authorization code, which it exchanges for a token.

Revoking is immediate: disable or delete the client in the OAuth clients table and every token it
issued stops working on the next request.

---

## What the connector can reach

Nothing by default. Each capability is a separate toggle, and the token carries no permissions of its
own — every request re-reads the current settings.

| Group | Examples |
|---|---|
| Discovery / read | `list_wa_accounts`, `list_models`, `list_templates`, `list_media`, `list_agents` |
| Funnel | `list_leads`, `move_lead_stage`, `get_campaign_performance`, `get_bda_activity` |
| Money | `list_payments`, `list_products`, `get_product_revenue` |
| Messaging | `list_conversations`, `read_messages`, `send_message`, `send_template`, `send_media`, `send_bulk_message` |
| Building | `create_agent`, `add_http_tool`, `create_automation`, `create_template`, `create_lead_form`, `upload_media` |
| Escape hatch | `forgechat_request` — any internal API path, still gated per area |

---

## Implementation notes (read before changing anything)

### Requirements that fail *silently* if wrong

- **`client_credentials` is not supported by Claude.** It requires an interactive browser flow, so
  the server offers only `authorization_code` + `refresh_token`. Advertising client_credentials would
  also mean handing out admin-equivalent access with no human in the loop.
- **PKCE `S256` must be advertised** in the authorization-server metadata. A server that doesn't is
  rejected before any redirect happens. A missing or `plain` challenge is **refused, not downgraded** —
  accepting it reopens exactly the interception attack PKCE closes.
- **Redirect URI is `https://claude.ai/api/mcp/auth_callback`** for web, desktop and mobile. Claude
  Code uses a **loopback** redirect on an ephemeral port, so localhost must be matched
  port-agnostically (RFC 8252). Everything else is compared byte-for-byte — a prefix match here is an
  open-redirect hole.
- **Discovery lives at the origin, not under `/api`.** RFC 8414/9728 anchor `/.well-known/...` at the
  root and append the resource path, so `frontend/nginx.conf` proxies
  `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource` and
  `/.well-known/openid-configuration` to the backend. Both the bare and path-suffixed forms are
  served, because clients differ on which they request.
- **A 401 from the MCP endpoint must carry `WWW-Authenticate`** with `resource_metadata=...`. Without
  it the client cannot discover the authorization server and just reports that the connector failed.

### ⚠ The nginx trap this replaced

`frontend/nginx.conf` used to return a hard **404** for every `/.well-known/oauth*` path, on purpose:
there was no OAuth server, and the SPA catch-all (`try_files … /index.html`) was answering discovery
probes with `200` + HTML. Connectors read that as "an authorization server exists", attempted Dynamic
Client Registration against an HTML page, and failed with:

> Couldn't register with forge growth's sign-in service.

If discovery ever starts returning the SPA again, check nginx first — **a 200 of HTML there is worse
than a 404.**

### Security properties (all verified against the live deployment)

| Property | Behaviour |
|---|---|
| Replayed authorization code | Refused **and** every token already issued from it is revoked |
| Wrong PKCE verifier | `invalid_grant` |
| Unregistered `redirect_uri` | Refused on our own page, **before** any redirect happens |
| Missing PKCE | Refused, never downgraded to `plain` |
| Wrong client secret | `invalid_client` |
| Refresh token reuse | Rotated on use; the old one dies immediately |
| Token for another resource | Rejected on audience (RFC 8707), not passed through |
| Client disabled or deleted | Live tokens stop working on the next request |

### Deliberate design choices

- **Capabilities are global (`mcp_settings`), never copied onto a token.** An admin turning a
  capability off must apply instantly to a client already holding a token minted before the change.
- **Authorization codes are reaped an hour *after* expiry, not immediately.** Deleting on expiry would
  turn a replay attempt into an indistinguishable "unknown code" and lose the chance to revoke the
  tokens it produced.
- **Dynamic Client Registration is supported** (`POST /api/mcp/oauth/register`) for clients that can
  self-register, and is gated on the MCP master switch.
- **The legacy key-in-URL transport (`/api/mcp/http/<key>`) still works** so existing connectors keep
  running. Prefer OAuth for anything new: there, the whole URL is the password, so it ends up in
  browser history, proxy logs and referrer headers.

---

## Troubleshooting

**"Couldn't register with … sign-in service"** — discovery is returning HTML instead of JSON. Check
the nginx `.well-known` block proxies to the backend.

**Connector added but "Connect" fails** — confirm the MCP master switch is on; `/authorize` returns a
403 page while it is off. Also confirm you are signed in to Forge Growth in the same browser.

**Tokens work, but every tool says a capability is disabled** — that is the capability toggles, not
auth. Enable what you need in Admin Settings → MCP Tools.

**Claude Code can't connect** — it uses a loopback redirect on a random port. The client's registered
redirect list must contain a `http://localhost/...` entry with the same *path*; the port is ignored on
purpose.
