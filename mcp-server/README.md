# Forge Growth — local MCP server (stdio)

A local MCP server for MCP clients that start a command rather than connect to a URL. It exposes the
same tools as the hosted connector — WhatsApp flows, templates and AI agents, Instagram automations,
flows and agents, contacts, follow-ups, Google Sheets and the rest — by calling your install's
key-authenticated API (`/api/mcp/v1`).

> **Most people do not need this.** Claude (web, desktop, mobile) and Claude Code connect directly
> to `https://<your-domain>/api/mcp` with your Forge Growth login — see **Settings → Claude & MCP**.
> Use this server only for a client that cannot do remote MCP.

It runs **from a checkout of this repository**: the Instagram and Sales tools are declared once in
`backend/src/services/mcpRouteTools.js` and loaded from there, so the two transports cannot drift.

## Install

```bash
cd forge-growth/mcp-server     # inside your clone of this repository
npm install
```

## Configure a client

1. In Forge Growth, go to **Settings → Claude & MCP**. Turn on **Allow access** and the tool
   categories you want, then under **Access & keys** generate an API key and copy the `fck_live_…`
   value (shown once).
2. Add the server to your client's config. For Claude Desktop that is **Settings → Developer → Edit
   Config**:

```json
{
  "mcpServers": {
    "forge-growth": {
      "command": "node",
      "args": ["/absolute/path/to/forge-growth/mcp-server/src/index.js"],
      "env": {
        "FORGECHAT_API_URL": "https://crm.example.com/api/mcp/v1",
        "FORGECHAT_API_KEY": "fck_live_PASTE_YOUR_KEY"
      }
    }
  }
}
```

Settings → Claude & MCP → **Advanced** shows this snippet with your install's own `FORGECHAT_API_URL`
filled in. (The variable names keep the product's earlier name so existing configs keep working.)

3. Restart the client. Ask, for example, *"draft a WhatsApp flow for course enquiries"* or *"draft a
   comment-to-DM automation on my latest reel"*.

> The client can run on a different machine from the server: point `FORGECHAT_API_URL` at the public
> address. The API key works over the internet; the login cookie is not involved.

## What it can do

The same tool categories as the hosted connector, gated by the same switches in
**Settings → Claude & MCP** — a category that is off returns a refusal naming it, which the assistant
relays. Anything that builds an automation, flow or agent saves it **switched off**.

## Develop / debug

```bash
FORGECHAT_API_URL=… FORGECHAT_API_KEY=… npm run inspect   # MCP Inspector
```
