# ChatGPT ↔ Sheet workflow

ChatGPT uses the shared Google Sheet as infrastructure. You should not manually manage rows during normal use after setup.

## Reading (triage)

1. Ensure each account’s Apps Script has been syncing (`scheduledMessageSync` or a `SYNC_NOW` command).
2. In ChatGPT (with Sheets/Drive connected to the control spreadsheet), ask e.g. “Check all my inboxes and tell me what needs action.”
3. ChatGPT should group by `account_id` / `account_email` from the **Messages** tab.
4. If a snippet is insufficient, ChatGPT appends a **Commands** row:

| account_id | action | gmail_message_id | status | requested_by |
|---|---|---|---|---|
| school | FETCH_FULL_TEXT | `<id>` | PENDING | ChatGPT |

5. After Apps Script processes it, re-read **Messages.body_text** for that `sync_id`.
6. Optionally enqueue `CLEAR_FULL_TEXT` when finished to minimize retained content.

## Writing (actions)

Prefer exact IDs from **Messages**:

| account_id | action | gmail_message_id | label_name | status | requested_by |
|---|---|---|---|---|---|
| school | ARCHIVE | `<id>` | | PENDING | ChatGPT |
| research | LABEL | `<id>` | Research/Ochsner | PENDING | ChatGPT |
| personal | MARK_READ | `<id>` | | PENDING | ChatGPT |

Rules of thumb for ChatGPT:

- Always set `account_id` to the owning account from Messages — never guess across accounts.
- Prefer `gmail_message_id` over `search_query`.
- If using `search_query`, make it narrow enough to match exactly one message; otherwise the system marks `NEEDS_REVIEW`.
- Do not ask Apps Script to “decide” what to archive; put explicit command rows.

## Checking results

- **Commands.status** / **result** / **error** for per-command outcomes.
- **Audit_Log** for every attempted mutation (including dry-run).
- Re-read **Messages** after the next sync to confirm labels/read/archive state.

## Example user phrases

- “Find my recent conference emails and tell me which should be archived.”
- “Archive the low-priority ones in my school account.”
- “Put the ASBH emails under Research/Conferences.”
- “Mark everything from this sender as read.”
- “What email actions succeeded?”
