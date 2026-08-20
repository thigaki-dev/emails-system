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
9. **Run `runInitialSync()` once** to backfill recent messages (larger one-time pull). Do **not** repeatedly run full/manual syncs afterward.
10. **Run a dry-run test** via `runDryRunTest()`. Confirm `Commands` / `Audit_Log` update and that Gmail is unchanged. **`DRY_RUN` defaults to TRUE** so live mutations are off until you opt in.
11. **Confirm the time-driven triggers** exist (Triggers in the left sidebar): `processPendingCommands` (~every 5 min), `scheduledMessageSync` (~every 30 min), and `scheduledMessageReconciliation` (~every 6 hours). `setupSystem()` already installs them; use `recreateTriggers()` / `removeAllTriggers()` to change them.
12. **Repeat steps 4–11 for every additional Gmail account** (new Apps Script project while signed into that account, same code, different `ACCOUNT_ID` / `ACCOUNT_EMAIL`).
13. **Share the control Sheet** with every account that needs to execute commands (Edit access).
14. **Inspect Audit_Log**, then set `DRY_RUN` to **FALSE** in the Settings tab. Test one harmless `MARK_READ` command for each account before enabling archive/trash. Keep `TRASH_ENABLED=FALSE` until you are ready.

Optional: [clasp](https://github.com/google/clasp) users can push from `apps-script/` after `clasp login` / `clasp create` / linking the script project.

### Upgrading an existing deployment

You do **not** need to recreate the shared Sheet. In each Apps Script project:

1. Paste/replace the updated `.gs` files (keep your edited `ACCOUNT_*` / `CONTROL_SHEET_ID` values).
2. Run **`setupSystem()`** — migrates missing Settings keys and Commands columns (`retry_count`, `next_retry_at`) without overwriting your current setting values or destroying existing data.
3. Run **`recreateTriggers()`** — removes obsolete/duplicate triggers and installs the quota-efficient schedule (30‑minute sync + 6‑hour reconciliation).
4. Optionally run **`runInitialSync()`** once if Messages looks thin; otherwise let scheduled sync catch up.

---

## Gmail quota posture (read this)

Apps Script Gmail daily quotas are easy to exhaust. This project is intentionally conservative in steady state:

| Workload | Old default | New default |
|---|---|---|
| Scheduled message sync | every **15** min, up to **200** msgs + up to **200** reconcile lookups | every **30** min, up to **75** priority/incremental msgs, **no** broad reconcile |
| Background reconciliation | bundled into every sync | separate trigger every **~6 hours**, **25** rows/run, cursor progresses |
| Initial / backfill | same path as scheduled sync | **`runInitialSync()`** once (up to `INITIAL_MAX_MESSAGES_PER_SYNC`, default 200) |

**Do not** repeatedly run `syncRecentMessages` / `SYNC_NOW` / `runInitialSync` “just to refresh” — that burns quota. Prefer waiting for `scheduledMessageSync`, or enqueue a targeted `REFRESH_MESSAGE` / `FETCH_FULL_TEXT` for one id.

### What scheduled sync does

1. Searches a small priority/incremental set (inbox / unread / starred, plus mail newer than the last successful sync).
2. Upserts those messages into **Messages** (snippet metadata; no full-body reads under `SNIPPET_ONLY`).
3. Does **not** individually re-fetch hundreds of old rows.

### What reconciliation does

`scheduledMessageReconciliation` (or manual `reconcileMessageState`) walks existing Messages rows in batches of `MAX_RECONCILE_PER_SYNC`, advancing a PropertiesService cursor so later rows are covered over successive runs. Use this for detecting mail archived/trashed/moved directly in Gmail — not as part of every 30‑minute sync.

### Quota errors → `RETRY_LATER`

If Gmail returns daily quota / rate-limit / temporary service errors (e.g. `Service invoked too many times for one day: gmail`):

- The command is marked **`RETRY_LATER`** (not permanent `FAILED`).
- `error` text is preserved; an **Audit_Log** row is written.
- `retry_count` increments and `next_retry_at` is set with backoff (default **30m → 2h → 6h+**).
- The processor only reclaims `RETRY_LATER` rows when `next_retry_at <= now`.
- Terminal validation failures (bad `account_id`, missing `label_name`, ambiguous search, etc.) stay **`FAILED`** / **`NEEDS_REVIEW`**.

If scheduled sync itself hits quota, it logs, stops cleanly, does **not** mark existing Messages as `REMOVED`, and preserves the last successful sync timestamp.

### Quota-related Settings

| Setting | Default | Notes |
|---|---|---|
| `SYNC_POLL_MINUTES` | 30 | Steady-state sync cadence (Apps Script: 1/5/10/15/30) |
| `MAX_MESSAGES_PER_SYNC` | 75 | Cap per scheduled/steady-state sync |
| `INITIAL_MAX_MESSAGES_PER_SYNC` | 200 | Cap for `runInitialSync` only |
| `MAX_RECONCILE_PER_SYNC` | 25 | Cap per reconciliation run |
| `RECONCILE_INTERVAL_HOURS` | 6 | Reconciliation cadence (Apps Script: 1/2/4/6/8/12) |
| `RETRY_BACKOFF_MINUTES_1/2/3` | 30 / 120 / 360 | `RETRY_LATER` backoff ladder |
| `BODY_SYNC_POLICY` | `SNIPPET_ONLY` | Avoids full-body reads unless `FULL_TEXT` / `FETCH_FULL_TEXT` |

Change values in the **Settings** tab, then run **`recreateTriggers()`** if you changed poll/reconcile intervals.

**Snippet / attachments:** normal sync uses Advanced Gmail metadata for snippets and attachment filenames when available. It does **not** call `getPlainBody()` or `getAttachments()` on the `SNIPPET_ONLY` path. If metadata is unavailable, `snippet` may fall back to the subject and `attachment_names` may be empty while `has_attachments` stays conservative. Full body text is only loaded for `BODY_SYNC_POLICY=FULL_TEXT` or `FETCH_FULL_TEXT`.

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
- **Settings** — runtime knobs (`DRY_RUN`, `TRASH_ENABLED`, sync windows, quota caps, etc.)

### Commands columns

`command_id`, `created_at`, `account_id`, `action`, `gmail_message_id`, `gmail_thread_id`, `search_query`, `label_name`, `status`, `requested_by`, `processed_at`, `result`, `error`, `retry_count`, `next_retry_at`

**Mutation actions:** `LABEL`, `REMOVE_LABEL`, `ARCHIVE`, `MOVE_TO_INBOX`, `MARK_READ`, `MARK_UNREAD`, `STAR`, `UNSTAR`, `TRASH`

**Infrastructure actions:** `SYNC_NOW`, `REFRESH_MESSAGE`, `FETCH_FULL_TEXT`, `CLEAR_FULL_TEXT`

**Statuses:** `PENDING` → `PROCESSING` → `SUCCESS` | `FAILED` | `NEEDS_REVIEW` | `RETRY_LATER`

### Messages columns

`sync_id`, `account_id`, `account_email`, `gmail_message_id`, `gmail_thread_id`, `received_at`, `from_address`, `to_addresses`, `cc_addresses`, `subject`, `snippet`, `body_text`, `body_text_expires_at`, `labels`, `is_unread`, `is_starred`, `has_attachments`, `attachment_names`, `last_synced_at`, `sync_state`

Default sync: priority Inbox/unread/starred plus incremental window, body policy **`SNIPPET_ONLY`**, no attachment binaries. ChatGPT can request `FETCH_FULL_TEXT` for one message when needed. Stored full text expires automatically after **24 hours** (`FULL_TEXT_TTL_HOURS`) even without `CLEAR_FULL_TEXT`.

### Action scope (read this before enqueueing commands)

GmailApp is thread-oriented for some operations. A command may name one `gmail_message_id` and still affect the whole thread.

| Action | Scope | What actually changes |
|---|---|---|
| `MARK_READ`, `MARK_UNREAD`, `STAR`, `UNSTAR` | **message** | Only the targeted message |
| `TRASH` | **message** | Only the targeted message (still gated by `TRASH_ENABLED`) |
| `LABEL`, `REMOVE_LABEL` | **thread** | Every message in that thread receives/loses the label |
| `ARCHIVE`, `MOVE_TO_INBOX` | **thread** | The whole thread leaves or re-enters Inbox |

Do not tell the user that `LABEL`/`ARCHIVE` apply to “this one message” when the thread has multiple messages. Command results and `Audit_Log.scope` record `message` or `thread`. After mutations, Apps Script refreshes **only** the affected message (or thread’s messages) — not the whole mailbox.

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
| Gmail quota errors | RETRY_LATER | Deferred with backoff; not permanent FAILED |
| Locking | LockService | Prevents double execution |

Credentials, OAuth tokens, and secrets are **never** stored in the Sheet.

---

## ChatGPT usage model

Typical conversation flow:

1. Ask: “Check all my inboxes and tell me what needs action.”
2. ChatGPT reads the **Messages** tab (across `account_id` values).
3. If a snippet is not enough, ChatGPT writes a `FETCH_FULL_TEXT` command for that `gmail_message_id`.
4. You approve actions like “archive these newsletters in school” — ChatGPT writes explicit **Commands** rows with `account_id` + `gmail_message_id` (preferred) or a narrow `search_query`.
5. Each account’s Apps Script polls and executes only its rows; results land in `Commands` + `Audit_Log`; targeted refresh updates **Messages**.

See `docs/chatgpt-workflow.md` for prompt patterns and column mapping.

Safe onboarding sequence:

1. Install each account and run `setupSystem()`.
2. Run `runInitialSync()` once, then let scheduled sync keep Messages fresh (or enqueue occasional `SYNC_NOW` sparingly).
3. Issue test commands while `DRY_RUN=TRUE`.
4. Inspect **Audit_Log**.
5. Explicitly set `DRY_RUN=FALSE` in Settings before live mutations.

You should **not** need to manually edit the Sheet during normal use after setup.

If you already ran `setupSystem()` when `DRY_RUN` defaulted to FALSE, set Settings `DRY_RUN` to TRUE until you have inspected Audit_Log and are ready for live mutations.

---

## Manual test functions (Apps Script editor)

| Function | Purpose |
|---|---|
| `setupSystem` | Create/migrate tabs + install triggers |
| `runInitialSync` | One-time / backfill sync (larger cap) |
| `runDryRunTest` | Safe end-to-end harness |
| `runCommandProcessorOnce` | Process pending commands now |
| `runMessageSyncOnce` / `syncPriorityMessages` / `syncRecentMessages` | Steady-state sync now |
| `reconcileMessageState` / `scheduledMessageReconciliation` | Bounded reconcile with cursor |
| `seedSampleCommands` | Insert sample PENDING rows |
| `recreateTriggers` / `removeAllTriggers` | Manage triggers (run after Settings interval changes) |

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
- [ ] Scheduled sync stays within `MAX_MESSAGES_PER_SYNC` and does not broad-reconcile  
- [ ] Gmail quota errors become `RETRY_LATER` with backoff, not permanent `FAILED`  
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
4. **Quota efficiency** — Conservative scheduled sync, separate reconciliation, `RETRY_LATER` backoff

Design principle: **ChatGPT decides; the shared Sheet communicates; Apps Script executes; each original Gmail account remains authoritative.**
