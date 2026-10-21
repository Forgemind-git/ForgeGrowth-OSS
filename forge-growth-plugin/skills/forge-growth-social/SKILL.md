---
name: forge-growth-social
description: >-
  Read and run Forge Growth's Social workspace — Instagram numbers, follower trends,
  the content library, DMs and comments, and especially Instagram automations (comment-to-DM and keyword
  rules), multi-step Instagram flows and Social AI agents: list, create, update, switch
  on/off and delete. Use whenever the user asks about social media performance, posts,
  comments, DMs, or wants an Instagram automation, flow or Social agent built or changed.
---

# Social

Every tool here starts with `social_`. They are switched on in five groups (Admin
Settings → MCP Tools → **Social**), plus deletes, which live in **Admin → Delete & remove**:

| Group | What it lets you do |
|---|---|
| Social analytics | `social_get_overview`, `social_get_platform_stats`, `social_get_followers_trend`, `social_get_audience`, `social_get_executive_summary`, `social_get_content_themes`, `social_list_posts` (content library), `social_list_accounts`, `social_get_token_health` |
| Social inbox & contacts | `social_list_messages` (Instagram DMs), `social_list_comments`, `social_list_contacts` |
| Social replies | `social_reply_to_comment`, `social_send_dm` — **seen by real people** |
| Instagram automations & flows | rules: `social_get_automation_options`, `social_list_automations`, `social_list_instagram_posts`, `social_create_automation`, `social_update_automation`, `social_get_automation_results`, `social_list_automation_leads`; flows: `social_list_flows`, `social_get_flow`, `social_create_flow`, `social_update_flow`, `social_get_flow_results` |
| Social AI agents | `social_list_agents`, `social_get_agent`, `social_list_agent_models`, `social_create_agent`, `social_update_agent`, `social_add_agent_tool`, `social_update_agent_tool`, `social_get_agent_runs` |
| Delete & remove (Admin) | `social_delete_automation`, `social_delete_flow`, `social_delete_agent`, `social_delete_agent_tool` |

A refusal naming a group means that switch is off — tell the user which one.

## Reading numbers

All analytics come from the **synced database**, never live platform calls, so every
answer is as fresh as the last sync (each response says when). Start with
`social_get_overview`, then one platform with `social_get_platform_stats`.

- Only **growth %, engagement rate and posting cadence** compare across platforms.
  Reach, impressions and the 1-99 content score are defined differently per platform —
  never rank platforms on them.
- There is no competitor data here. Anything about competitors comes from your own research.
- `account` = a connected account id from `social_list_accounts`, or `"all"`.

## Instagram automations (rules)

A rule is one trigger → one response: a comment on a post (or any post), a DM keyword,
a story reply or mention, or a button tap. It can reply publicly, DM, gate on "follow
first", collect name/email/phone, log to a Google Sheet and send one follow-up.

1. `social_list_accounts` → the Instagram `accountId` (sent as `account_id`).
2. `social_get_automation_options` → allowed triggers and field types.
3. For "only on this post", `social_list_instagram_posts` → `media_id`.
4. Summarise the rule in plain words and get a yes.
5. `social_create_automation` with **`active: false`**, show it, then
   `social_update_automation {changes:{active:true}}` once the user agrees.

An active rule sends real DMs on its own, capped per hour. Turning it off
(`active:false`) is always safer than deleting it.

## Instagram flows

A flow is a multi-step DM conversation drawn on a canvas: a graph of steps joined by
edges, with **exactly one `trigger` step**. Step types and their `data` are specific to
the builder — **read an existing flow with `social_get_flow` and copy its shapes**;
never invent a step type. Create with `active:false`, confirm, then switch on with
`social_update_flow`. Switching a flow off also stops every run still waiting on a reply.

## Social AI agents

Agents that answer Instagram DMs and/or comments. Gather: purpose → name and
system prompt → `platform` + `accountId` (`social_list_accounts`) → `replyDms` /
`replyComments` → model (`social_list_agent_models`: `aiModelId` + `llmModel`) →
trigger (`any` or `keyword`) → handoff. Create as `status:"draft"`, confirm, then
`social_update_agent {changes:{status:"active", isActive:true}}`.
Read `social_get_agent_runs` to answer "what did it say" or "why is it quiet".

## Rules

- Confirm before anything that reaches people (replies, DMs) and before switching
  an automation, flow or agent ON.
- Confirm twice before any `social_delete_*` — there is no undo.
- Social logins, credentials and settings are not reachable from here on purpose.
