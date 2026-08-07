# Forge Growth plugin

Configure **Forge Growth** (your Marketing → Sales → Chats funnel on WhatsApp) end-to-end by
talking to Claude. Give Claude a plain-language **game plan** — "get a template approved by
Meta, then message my hot leads" — and it drives the Forge Growth MCP connector to do it,
showing you a preview and asking for a yes before anything goes live.

## What's in here

- `.mcp.json` — the connector. A pointer at *your* Forge Growth server, not the tools
  themselves: those live in the Forge Growth backend and arrive automatically.
- `skills/forge-growth-marketer/SKILL.md` — the orchestration brain (the game-plan loop,
  preview patterns, playbooks). Auto-activates when you talk about your funnel.
- `commands/game-plan.md` — a `/game-plan <your plan>` command to kick things off.

## One-time setup

### 1. Point the connector at your instance

Edit `.mcp.json` and replace `YOUR-FORGE-GROWTH-HOST` with your own domain. **That is the
only edit.** There is no key to paste — authentication is OAuth, so nothing secret ever
goes in this file.

```
https://your-instance.example.com/api/mcp
```

### 2. Turn MCP on and choose what Claude may do

In Forge Growth → **Admin Settings → MCP Tools**: switch the master toggle **on**, then
enable the categories you want. Each is one switch over one process; expand a card to see
exactly which tools it controls.

| Category | Lets Claude… | Tier |
|---|---|---|
| Setup & Connections | see your WhatsApp numbers, AI models and reachable areas | reads only |
| Template Builder | draft, submit to Meta and re-sync WhatsApp templates | builds |
| Media Library | list and upload posters, images, video, documents | builds |
| AI Agents | create and configure the agents that talk to customers | builds |
| Automations | build automation flows | builds |
| Lead Forms | create lead-capture forms and read submissions | builds |
| Leads & Funnel | read leads and move them between stages | builds |
| Message Formats | generate trackable click-to-chat links | builds |
| Conversations | read chats and 24-hour window status | reads only |
| Marketing Analytics | read campaigns, spend, webinars, BDA activity | reads only |
| Products & Payments | read products, revenue and the payment ledger | reads only |
| Google Workspace | search connected Drive spreadsheets and read tabs | reads only |
| **Send Messages** | **send real WhatsApp messages to one person** | reaches customers |
| **Broadcasts** | **message a whole uploaded list at once** | reaches customers |
| **Delete & remove** | **permanently delete an agent or its tools** | cannot be undone |
| Direct API access | call any internal endpoint, scoped by the API-area switches | full API |

The last four are the higher-trust ones — Send Messages and Broadcasts cost money and reach
real people, Delete cannot be undone. Enable only what you're comfortable with; every switch
is global and takes effect immediately on already-connected clients.

### 3. Connect Claude

**Claude Code** — drop this folder into your plugins (or a marketplace) and enable it. On
first use Claude registers itself with your server and opens a browser window to approve.
You must already be signed in to Forge Growth in that browser.

**claude.ai** — Settings → Connectors → **Add custom connector**, and paste
`https://your-instance.example.com/api/mcp`. If it asks for credentials, create an OAuth
client in Admin Settings → MCP Tools (the secret is shown **once**) and paste the Client ID
and Secret under *Advanced settings*.

Revoking is immediate: disable or delete the client and every token it issued stops working
on the next request.

## Using it

```
/game-plan Launch my new course. Use the poster already in my Media Library called
"aug-launch". Get a WhatsApp template approved for it, then send it to every lead
that arrived in the last 24 hours.
```

Claude will find the poster, draft and preview the template, submit it to Meta, poll for
approval, pull your recent leads, show you the audience, and — once you say yes — send.

## Notes

- Claude always **previews and asks** before creating, submitting or sending.
- **File uploads: do not attach the file to the chat and expect Claude to upload it.**
  Claude cannot stream an attachment's raw bytes into a tool argument — the call hangs
  rather than failing. Either upload it once in Forge Growth → Media Library and refer to
  it by name, or give Claude a public `https://` URL.
- Templates must be **approved by Meta** before they can be sent, and only from the number
  they were approved on.
- If Claude says a tool category is switched off, flip it in Admin Settings → MCP Tools.
  Claude cannot enable it itself, by design.
