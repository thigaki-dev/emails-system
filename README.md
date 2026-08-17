# Multi-Account Gmail Control via ChatGPT + Google Apps Script

ChatGPT is the interface and reasoning layer. A shared Google Sheet is the transport/state layer. Google Apps Script (installed separately in each Gmail account) is the authenticated execution and sync layer. **Each original Gmail inbox remains the source of truth.**

No OpenAI API key is required. ChatGPT itself reasons; Apps Script only executes deterministic commands and syncs message metadata.

> **Important limitation:** This does **not** make ChatGPT directly connect to multiple Gmail accounts. ChatGPT talks to the shared Sheet. Each independently authorized Apps Script deployment acts only on the Gmail account that authorized it.

---

## Where you enter your email accounts (TWO places)

### A. Central account registry in the Google Sheet (`Accounts` tab)

| account_id | email_address | display_name | enabled |
|---|---|---|---|
| personal | `TYPE_EMAIL_1_HERE` | Personal Gmail | TRUE |
| school | `TYPE_EMAIL_2_HERE` | School Gmail | TRUE |
| research | `TYPE_EMAIL_3_HERE` | Research Gmail | TRUE |

**Replace TYPE_EMAIL_1_HERE, TYPE_EMAIL_2_HERE, etc. with your actual Gmail addresses.**

Do not leave the `TYPE_EMAIL_*` placeholders in place.

### B. Each Apps Script deployment (`Config.gs`)

At the top of `apps-script/Config.gs`:

```javascript
ACCOUNT_ID = "TYPE_ACCOUNT_ID_HERE"
ACCOUNT_EMAIL = "TYPE_THIS_DEPLOYMENT_EMAIL_HERE"
CONTROL_SHEET_ID = "TYPE_SHARED_GOOGLE_SHEET_ID_HERE"
```

Example: the script authorized while signed into `school@example.edu` should use `ACCOUNT_ID = "school"` and `ACCOUNT_EMAIL = "school@example.edu"`. Install the **same code separately** for every Gmail account.

---

## Numbered setup procedure

1. **Create one Google Sheet** to act as the control plane (any blank spreadsheet).
2. **Copy its spreadsheet ID** from the URL:  
   `https://docs.google.com/spreadsheets/d/`**`THIS_IS_THE_ID`**`/edit`
3. **Enter every Gmail address** in the `Accounts` tab (after step 8 creates it, or paste the sample rows from below).  
   Replace `TYPE_EMAIL_1_HERE`, `TYPE_EMAIL_2_HERE`, etc. with your actual Gmail addresses.
4. **For Gmail Account #1**, open [script.google.com](https://script.google.com) while **signed into that account** and create a new project (or open the Apps Script editor from Drive).
5. **Paste/deploy the shared codebase** from `apps-script/` — create one script file per `.gs` file (`Config.gs`, `Setup.gs`, `Main.gs`, `CommandQueue.gs`, `GmailExecutor.gs`, `Validation.gs`, `AuditLog.gs`, `Utilities.gs`, `MessageSync.gs`). Also set `appsscript.json` (enable the Advanced Gmail service if prompted).
6. **Set** `ACCOUNT_ID`, `ACCOUNT_EMAIL`, and `CONTROL_SHEET_ID` in `Config.gs`.
7. **Authorize** Gmail and Google Sheets permissions when Apps Script prompts you.
8. **Run `setupSystem()`** from the editor (select function → Run). This creates tabs: `Accounts`, `Messages`, `Commands`, `Audit_Log`, `Settings`, and installs triggers.
9. **Run a dry-run test** via `runDryRunTest()`. Confirm `Commands` / `Audit_Log` update and that Gmail is unchanged. **`DRY_RUN` defaults to TRUE** so live mutations are off until you opt in.
10. **Confirm the time-driven triggers** exist (Triggers in the left sidebar): `processPendingCommands` (~every 5 min) and `scheduledMessageSync` (~every 15 min). `setupSystem()` already installs them; use `recreateTriggers()` / `removeAllTriggers()` to change them.
11. **Repeat steps 4–10 for every additional Gmail account** (new Apps Script project while signed into that account, same code, different `ACCOUNT_ID` / `ACCOUNT_EMAIL`).
12. **Share the control Sheet** with every account that needs to execute commands (Edit access).
13. **Inspect Audit_Log**, then set `DRY_RUN` to **FALSE** in the Settings tab. Test one harmless `MARK_READ` command for each account before enabling archive/trash. Keep `TRASH_ENABLED=FALSE` until you are ready.

Optional: [clasp](https://github.com/google/clasp) users can push from `apps-script/` after `clasp login` / `clasp create` / linking the script project.

---

## Architecture

```
READ PATH:  Gmail account → Apps Script sync → Messages tab → ChatGPT → you
WRITE PATH: you → ChatGPT → Commands tab → Apps Script → original Gmail account
```

| Layer | Role |
|---|---|
| ChatGPT | Human UI + reasoning/classification (no separate OpenAI API) |
| Google Sheet | Command queue, account registry, message bridge, audit log |
| Apps Script per account | Sync + execute only for the authorizing mailbox |
| Original Gmail | Source of truth for labels, archive, trash, read state |

---

## Control Sheet tabs

Created automatically by `setupSystem()`:

- **Accounts** — registry (`account_id`, `email_address`, `display_name`, `enabled`)
- **Messages** — synchronized metadata/content ChatGPT can inspect
- **Commands** — actions ChatGPT wants executed
- **Audit_Log** — immutable record of attempted/completed actions
- **Settings** — runtime knobs (`DRY_RUN`, `TRASH_ENABLED`, sync windows, etc.)

### Commands columns

`command_id`, `created_at`, `account_id`, `action`, `gmail_message_id`, `gmail_thread_id`, `search_query`, `label_name`, `status`, `requested_by`, `processed_at`, `result`, `error`

**Mutation actions:** `LABEL`, `REMOVE_LABEL`, `ARCHIVE`, `MOVE_TO_INBOX`, `MARK_READ`, `MARK_UNREAD`, `STAR`, `UNSTAR`, `TRASH`

**Infrastructure actions:** `SYNC_NOW`, `REFRESH_MESSAGE`, `FETCH_FULL_TEXT`, `CLEAR_FULL_TEXT`

**Statuses:** `PENDING` → `PROCESSING` → `SUCCESS` | `FAILED` | `NEEDS_REVIEW`

### Messages columns

`sync_id`, `account_id`, `account_email`, `gmail_message_id`, `gmail_thread_id`, `received_at`, `from_address`, `to_addresses`, `cc_addresses`, `subject`, `snippet`, `body_text`, `body_text_expires_at`, `labels`, `is_unread`, `is_starred`, `has_attachments`, `attachment_names`, `last_synced_at`, `sync_state`

Default sync: last **30 days**, priority Inbox/unread/starred, body policy **`SNIPPET_ONLY`**, no attachment binaries. ChatGPT can request `FETCH_FULL_TEXT` for one message when needed. Stored full text expires automatically after **24 hours** (`FULL_TEXT_TTL_HOURS`) even without `CLEAR_FULL_TEXT`.

### Action scope (read this before enqueueing commands)

GmailApp is thread-oriented for some operations. A command may name one `gmail_message_id` and still affect the whole thread.

| Action | Scope | What actually changes |
|---|---|---|
| `MARK_READ`, `MARK_UNREAD`, `STAR`, `UNSTAR` | **message** | Only the targeted message |
| `TRASH` | **message** | Only the targeted message (still gated by `TRASH_ENABLED`) |
| `LABEL`, `REMOVE_LABEL` | **thread** | Every message in that thread receives/loses the label |
| `ARCHIVE`, `MOVE_TO_INBOX` | **thread** | The whole thread leaves or re-enters Inbox |

Do not tell the user that `LABEL`/`ARCHIVE` apply to “this one message” when the thread has multiple messages. Command results and `Audit_Log.scope` record `message` or `thread`.

---

## Safety defaults

| Setting | Default | Meaning |
|---|---|---|
| `DRY_RUN` | **TRUE** | Log intended actions only. Turn FALSE after you inspect Audit_Log. |
| `TRASH_ENABLED` | FALSE | Trash commands fail until you opt in |
| `AUTO_CREATE_LABELS` | TRUE | Create missing labels on `LABEL` (thread-level) |
| `FULL_TEXT_TTL_HOURS` | 24 | Auto-clear `Messages.body_text` after FETCH_FULL_TEXT |
| Permanent delete | never | Out of scope |
| Ambiguous `search_query` | NEEDS_REVIEW | Will not guess among multiple matches |
| Idempotency | enforced | `SUCCESS` commands never run twice |
| Locking | LockService | Prevents double execution |

Credentials, OAuth tokens, and secrets are **never** stored in the Sheet.

---

## ChatGPT usage model

Typical conversation flow:

1. Ask: “Check all my inboxes and tell me what needs action.”
2. ChatGPT reads the **Messages** tab (across `account_id` values).
3. If a snippet is not enough, ChatGPT writes a `FETCH_FULL_TEXT` command for that `gmail_message_id`.
4. You approve actions like “archive these newsletters in school” — ChatGPT writes explicit **Commands** rows with `account_id` + `gmail_message_id` (preferred) or a narrow `search_query`.
5. Each account’s Apps Script polls and executes only its rows; results land in `Commands` + `Audit_Log`; the next sync updates **Messages**.

See `docs/chatgpt-workflow.md` for prompt patterns and column mapping.

Safe onboarding sequence:

1. Install each account and run `setupSystem()`.
2. Let sync populate **Messages** (or enqueue `SYNC_NOW`).
3. Issue test commands while `DRY_RUN=TRUE`.
4. Inspect **Audit_Log**.
5. Explicitly set `DRY_RUN=FALSE` in Settings before live mutations.

You should **not** need to manually edit the Sheet during normal use after setup.

If you already ran `setupSystem()` when `DRY_RUN` defaulted to FALSE, set Settings `DRY_RUN` to TRUE until you have inspected Audit_Log and are ready for live mutations.

---

## Manual test functions (Apps Script editor)

| Function | Purpose |
|---|---|
| `setupSystem` | Create tabs + install triggers |
| `runDryRunTest` | Safe end-to-end harness |
| `runCommandProcessorOnce` | Process pending commands now |
| `runMessageSyncOnce` / `syncPriorityMessages` / `syncRecentMessages` | Sync now |
| `reconcileMessageState` | Refresh label/read/star; mark missing as `REMOVED` |
| `seedSampleCommands` | Insert sample PENDING rows |
| `recreateTriggers` / `removeAllTriggers` | Manage triggers |

Sample CSV rows: `samples/sample_commands.csv`.

---

## Acceptance checklist

- [ ] Label/archive on Account A changes only Account A’s mailbox  
- [ ] Account A’s script ignores commands for Account B  
- [ ] `ARCHIVE` removes Inbox without deleting  
- [ ] `TRASH` blocked while `TRASH_ENABLED=FALSE`  
- [ ] Completed (`SUCCESS`) commands do not run twice  
- [ ] Ambiguous searches → `NEEDS_REVIEW`  
- [ ] Every mutation attempt writes `Audit_Log`  
- [ ] `DRY_RUN` produces no Gmail changes  
- [ ] Failure in one account does not block others (separate deployments)  
- [ ] Inbox messages appear in **Messages** with correct `account_id` after sync  
- [ ] Re-sync updates rows; no duplicates for same `account_id` + `gmail_message_id`  
- [ ] `FETCH_FULL_TEXT` fills only the requested message’s `body_text`  
- [ ] Stored full text expires (or is cleared) without relying on ChatGPT to remember `CLEAR_FULL_TEXT`  
- [ ] `LABEL`/`ARCHIVE` results state they are thread-level  
- [ ] No OpenAI API key anywhere in the project  

---

## Repository layout

```
apps-script/          Google Apps Script source (deploy per account)
  Config.gs           ★ edit ACCOUNT_ID / ACCOUNT_EMAIL / CONTROL_SHEET_ID
  Setup.gs            Sheet init + triggers
  Main.gs             processPendingCommands + dry-run harness
  CommandQueue.gs     claim/update Commands rows
  GmailExecutor.gs    deterministic Gmail actions
  MessageSync.gs      Messages tab sync / full-text / prune
  Validation.gs       account/action/target validation
  AuditLog.gs         append-only audit writer
  Utilities.gs        IDs, locks, helpers
  appsscript.json     V8 + Advanced Gmail service
docs/                 ChatGPT workflow notes
samples/              Sample command rows
```

## Phase map (PRD)

1. **Phase 1** — Reliable `LABEL`, `ARCHIVE`, `MARK_READ`, `MARK_UNREAD`, `MOVE_TO_INBOX`
2. **Phase 2** — Safer `TRASH`, batch caps, auditing, error recovery, `REMOVE_LABEL` / `STAR` / `UNSTAR`
3. **Phase 3 + bidirectional bridge** — Messages sync, infra commands, dual triggers, ChatGPT Sheet workflow

Design principle: **ChatGPT decides; the shared Sheet communicates; Apps Script executes; each original Gmail account remains authoritative.**
