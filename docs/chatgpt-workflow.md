# ChatGPT ↔ Sheet workflow

ChatGPT uses the shared Google Sheet as infrastructure. You should not manually manage rows during normal use after setup.

## Action scope (required)

A command may name one `gmail_message_id`. That does **not** always mean only that message changes.

| Action | Scope | Effect |
|---|---|---|
| `MARK_READ`, `MARK_UNREAD`, `STAR`, `UNSTAR` | message | Only the targeted message |
| `TRASH` | message | Only the targeted message (`TRASH_ENABLED` must be TRUE) |
| `LABEL`, `REMOVE_LABEL` | thread | The **entire thread** gets or loses the label |
| `ARCHIVE`, `MOVE_TO_INBOX` | thread | The **entire thread** leaves or re-enters Inbox |

If a thread has five messages and the user says “label this message,” write a `LABEL` command only if applying the label to the whole thread is acceptable. Say so in the reply: “This will label the whole thread (N messages).” `Audit_Log.scope` and `Commands.result` include `thread-level` or `message-level`.

## Reading (triage)

1. Ensure each account’s Apps Script has been syncing (`scheduledMessageSync` or a `SYNC_NOW` command). Scheduled sync also reconciles rows that left Inbox (archived/trashed) so **Messages** does not stay stale.
2. In ChatGPT (with Sheets/Drive connected to the control spreadsheet), ask e.g. “Check all my inboxes and tell me what needs action.”
3. ChatGPT should group by `account_id` / `account_email` from the **Messages** tab.
4. If a snippet is insufficient, ChatGPT appends a **Commands** row:

| account_id | action | gmail_message_id | status | requested_by |
|---|---|---|---|---|
| school | FETCH_FULL_TEXT | `<id>` | PENDING | ChatGPT |

5. After Apps Script processes it, re-read **Messages.body_text** for that `sync_id` before `body_text_expires_at` (default 24 hours). Expired full text is cleared automatically on the next sync.
6. Prefer `CLEAR_FULL_TEXT` when finished; do not rely on it as the only cleanup.

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
- If `Settings.DRY_RUN` is TRUE, commands are logged only — tell the user live mutations are still off.

## Checking results

- **Commands.status** / **result** / **error** for per-command outcomes (look for `[thread-level]` vs `[message-level]`).
- **Audit_Log** for every attempted mutation (including dry-run); `scope` is `message`, `thread`, or `infra`.
- Re-read **Messages** after sync/reconcile to confirm labels/read/archive state (`INBOX` / `ARCHIVED` / `TRASH` tags in `labels`).

## Example user phrases

- “Find my recent conference emails and tell me which should be archived.”
- “Archive the low-priority ones in my school account.” (thread-level)
- “Put the ASBH emails under Research/Conferences.” (thread-level labels)
- “Mark everything from this sender as read.” (message-level)
- “What email actions succeeded?”
