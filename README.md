# Gmail MCP Server

A comprehensive MCP (Model Context Protocol) server for Gmail API with 35 tools covering all major Gmail operations.

## Tools

### Messages (14 tools)
| Tool | Description |
|---|---|
| `gmail_list_messages` | List messages with Gmail search query support |
| `gmail_get_message` | Fetch full message content with decoded body |
| `gmail_send_message` | Send new email (plain text + HTML multipart, attachments) |
| `gmail_reply_to_message` | Threaded reply with proper In-Reply-To headers |
| `gmail_forward_message` | Forward email with original content quoted |
| `gmail_get_attachment` | Download an attachment by messageId + attachmentId |
| `gmail_trash_message` | Move to trash (recoverable) |
| `gmail_untrash_message` | Restore from trash |
| `gmail_delete_message` | Permanently delete (irreversible) |
| `gmail_modify_labels` | Add/remove labels on a message |
| `gmail_mark_as_read` | Mark message as read |
| `gmail_mark_as_unread` | Mark message as unread |
| `gmail_star_message` | Star or unstar a message |
| `gmail_batch_modify` | Modify labels on multiple messages at once |

### Drafts (6 tools)
| Tool | Description |
|---|---|
| `gmail_list_drafts` | List all drafts |
| `gmail_get_draft` | Fetch full draft content |
| `gmail_create_draft` | Create a new draft (with attachments) |
| `gmail_update_draft` | Update existing draft (with attachments) |
| `gmail_send_draft` | Send a draft |
| `gmail_delete_draft` | Delete a draft |

### Labels (5 tools)
| Tool | Description |
|---|---|
| `gmail_list_labels` | List all labels (system and user) |
| `gmail_get_label` | Get label details and counts |
| `gmail_create_label` | Create new label with optional color |
| `gmail_update_label` | Update label name/visibility/color |
| `gmail_delete_label` | Delete a user label |

### Threads (5 tools)
| Tool | Description |
|---|---|
| `gmail_list_threads` | List threads with query support |
| `gmail_get_thread` | Fetch full thread with all messages |
| `gmail_trash_thread` | Move entire thread to trash |
| `gmail_delete_thread` | Permanently delete thread |
| `gmail_modify_thread` | Modify labels on all thread messages |

### Profile, Filters & History (5 tools)
| Tool | Description | Extra scope |
|---|---|---|
| `gmail_get_profile` | Get Gmail profile info and stats | - |
| `gmail_list_filters` | List all Gmail filters | `gmail.settings.basic` |
| `gmail_create_filter` | Create automatic email filter | `gmail.settings.basic` |
| `gmail_delete_filter` | Delete a filter | `gmail.settings.basic` |
| `gmail_list_history` | List mailbox changes since a history ID | - |

## Setup

### Required Environment Variables

```
GMAIL_CLIENT_ID=your-oauth2-client-id.apps.googleusercontent.com
GMAIL_CLIENT_SECRET=your-oauth2-client-secret
GMAIL_REFRESH_TOKEN=your-refresh-token
PORT=3000
```

### Required OAuth Scopes

The refresh token MUST be issued with ALL of the following scopes, otherwise Filter tools and any future Settings tools will return `403 Permission denied`:

```
https://mail.google.com/
https://www.googleapis.com/auth/gmail.settings.basic
https://www.googleapis.com/auth/gmail.settings.sharing
```

Important: `https://mail.google.com/` (full Gmail access) does NOT include the Settings scopes. They must be requested explicitly.

| Scope | Enables |
|---|---|
| `https://mail.google.com/` | Full read/send/modify/delete on messages, drafts, threads, labels |
| `gmail.settings.basic` | Filters, vacation responder, POP/IMAP, forwarding, language, display |
| `gmail.settings.sharing` | Send-as aliases, sensitive forwarding, delegates |

### Getting a Refresh Token with All Scopes

1. Go to [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services → Library → enable **Gmail API**.
2. Go to Credentials → create **OAuth 2.0 Client ID** (Web application).
3. Add authorized redirect URI: `https://developers.google.com/oauthplayground`.
4. Open [OAuth 2.0 Playground](https://developers.google.com/oauthplayground).
5. Click the gear icon (top right) → check **"Use your own OAuth credentials"** → paste your Client ID and Secret.
6. In "Step 1 - Select & authorize APIs", scroll to the bottom and paste ALL scopes in "Input your own scopes":
   ```
   https://mail.google.com/ https://www.googleapis.com/auth/gmail.settings.basic https://www.googleapis.com/auth/gmail.settings.sharing
   ```
7. Click **Authorize APIs** → approve on Google.
8. In "Step 2", click **Exchange authorization code for tokens**.
9. Copy the **Refresh token** and set it as `GMAIL_REFRESH_TOKEN`.

### Claude.ai Connector

Add this SSE endpoint as a custom connector in Claude.ai:

```
https://your-railway-deployment.up.railway.app/sse
```

## Development

```bash
npm install
npm run build
npm start
```

## Deployment (Railway)

1. Push to GitHub
2. Create new Railway project from GitHub repo
3. Set environment variables: `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`
4. Railway auto-deploys on push
