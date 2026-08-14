# Issue: Gmail MCP missing `gmail.settings.basic` scope + Railway deploy stuck

**Status:** OPEN — blocked on user action (generate refresh token)
**Opened:** 2026-08-14
**Server:** https://gmail-mcp-server-production-9172.up.railway.app (live, v2.1.1, 35 tools)

## Problem
The filter tools (`gmail_create_filter`, `gmail_delete_filter`, `gmail_list_filters`)
return 403 because the current `GMAIL_REFRESH_TOKEN` was minted with only
`https://mail.google.com/`. That scope does NOT include Gmail Settings API access.

## Root cause
Scopes are fixed at consent time, not runtime. The code (`src/gmail-client.ts`)
just feeds the refresh token to an OAuth2 client. No code change fixes this —
a NEW refresh token with the settings scopes is required.

## Required scopes (all three)
```
https://mail.google.com/
https://www.googleapis.com/auth/gmail.settings.basic
https://www.googleapis.com/auth/gmail.settings.sharing
```

## Correct OAuth client
The correct CLIENT_ID / CLIENT_SECRET are the ones currently set as env vars on
the Railway service (read them via Railway, do NOT hardcode here). The client id
begins `58553721095-...`. IMPORTANT: earlier chat notes citing a `626809725375-...`
client id were STALE and WRONG — do not use them.

## Fix procedure
1. Generate a new refresh token at https://developers.google.com/oauthplayground
   using the CORRECT client id/secret (from Railway env) and all three scopes.
2. Update `GMAIL_REFRESH_TOKEN` env var on Railway
   (project 43a3e7b1-55e5-4da1-86ad-c96bc4e40dc9,
    env 8ef82bb5-034b-4abf-8c40-aa55f28b6fda,
    service ef8bca66-1694-4aa4-92b7-09242f852271).
3. Railway restarts the service on env change (~30s). Verify /health, then
   test gmail_create_filter.

## Secondary issue: Railway not deploying HEAD
`trigger_latest_deploy` keeps building commit 074e483 (v2.1.1, Aug 4) instead of
HEAD. The GitHub->Railway webhook for this service is disconnected, so the
v2.2.0 self-hosted OAuth endpoints (src/gmail-oauth.ts, wired into src/index.ts)
never shipped. Fixing requires reconnecting the GitHub trigger in Railway UI
or deploying via Railway CLI. NOTE: the env-var fix above does NOT depend on
this — updating GMAIL_REFRESH_TOKEN works regardless.
