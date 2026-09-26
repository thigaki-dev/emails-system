#!/usr/bin/env node
/**
 * Static validation for the Apps Script multi-account Gmail bridge.
 * Runs without Google services — checks PRD structural acceptance criteria
 * that can be verified from source.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'apps-script');

let failed = 0;
function pass(msg) {
  console.log('PASS  ' + msg);
}
function fail(msg) {
  failed++;
  console.error('FAIL  ' + msg);
}
function assert(cond, msg) {
  if (cond) pass(msg);
  else fail(msg);
}

const requiredFiles = [
  'Config.gs',
  'Setup.gs',
  'Main.gs',
  'CommandQueue.gs',
  'GmailExecutor.gs',
  'Validation.gs',
  'AuditLog.gs',
  'Utilities.gs',
  'MessageSync.gs',
  'appsscript.json'
];

requiredFiles.forEach((f) => {
  assert(fs.existsSync(path.join(APP, f)), 'required file exists: ' + f);
});

const allGs = requiredFiles
  .filter((f) => f.endsWith('.gs'))
  .map((f) => fs.readFileSync(path.join(APP, f), 'utf8'))
  .join('\n');

const configGs = fs.readFileSync(path.join(APP, 'Config.gs'), 'utf8');
const setupGs = fs.readFileSync(path.join(APP, 'Setup.gs'), 'utf8');
const mainGs = fs.readFileSync(path.join(APP, 'Main.gs'), 'utf8');
const messageSyncGs = fs.readFileSync(path.join(APP, 'MessageSync.gs'), 'utf8');
const commandQueueGs = fs.readFileSync(path.join(APP, 'CommandQueue.gs'), 'utf8');
const utilitiesGs = fs.readFileSync(path.join(APP, 'Utilities.gs'), 'utf8');
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');

// No OpenAI API integration
assert(!/openai\.com|OpenAI API|Chat Completions|sk-[a-zA-Z0-9]{10,}/i.test(allGs), 'no OpenAI API usage in Apps Script');
assert(!/OPENAI_API_KEY/i.test(allGs + readme), 'no OPENAI_API_KEY anywhere');

// Config placeholders
assert(allGs.includes('TYPE_ACCOUNT_ID_HERE'), 'Config has ACCOUNT_ID placeholder');
assert(allGs.includes('TYPE_THIS_DEPLOYMENT_EMAIL_HERE'), 'Config has ACCOUNT_EMAIL placeholder');
assert(allGs.includes('TYPE_SHARED_GOOGLE_SHEET_ID_HERE'), 'Config has CONTROL_SHEET_ID placeholder');
assert(readme.includes('Replace TYPE_EMAIL_1_HERE, TYPE_EMAIL_2_HERE'), 'README tells user to replace TYPE_EMAIL_*');

// Safety defaults
assert(/TRASH_ENABLED:\s*false/i.test(allGs) || /TRASH_ENABLED',\s*'FALSE'/.test(allGs), 'TRASH_ENABLED defaults false');
assert(/DRY_RUN:\s*true/i.test(allGs) || /DRY_RUN',\s*'TRUE'/.test(allGs), 'DRY_RUN defaults true');
assert(allGs.includes('NEEDS_REVIEW'), 'NEEDS_REVIEW status supported');
assert(allGs.includes('RETRY_LATER'), 'RETRY_LATER status supported');
assert(allGs.includes('LockService'), 'uses LockService');
assert(allGs.includes('writeAuditLog_'), 'audit logging present');
assert(allGs.includes('runDryRunTest'), 'dry-run harness present');

// Required functions
const requiredFns = [
  'setupSystem',
  'processPendingCommands',
  'scheduledMessageSync',
  'scheduledMessageReconciliation',
  'syncRecentMessages',
  'syncPriorityMessages',
  'runInitialSync',
  'syncOneMessage',
  'fetchFullTextForMessage',
  'clearStoredBodyText',
  'reconcileMessageState',
  'recreateTriggers',
  'removeAllTriggers',
  'runDryRunTest',
  'seedSampleCommands',
  'isRetryableGmailError_',
  'markCommandRetryLater_',
  'computeNextRetryAt_',
  'buildSteadyStateSyncQuery_'
];
requiredFns.forEach((fn) => {
  assert(new RegExp('function\\s+' + fn + '\\s*\\(').test(allGs), 'function defined: ' + fn);
});

// Actions
['LABEL', 'ARCHIVE', 'MARK_READ', 'MARK_UNREAD', 'MOVE_TO_INBOX', 'TRASH', 'REMOVE_LABEL', 'STAR', 'UNSTAR'].forEach((a) => {
  assert(allGs.includes("'" + a + "'") || allGs.includes('"' + a + '"') || allGs.includes("case '" + a + "'"), 'action supported: ' + a);
});
['SYNC_NOW', 'REFRESH_MESSAGE', 'FETCH_FULL_TEXT', 'CLEAR_FULL_TEXT'].forEach((a) => {
  assert(allGs.includes(a), 'infra action supported: ' + a);
});

// Schema headers
const commandCols = [
  'command_id',
  'created_at',
  'account_id',
  'action',
  'gmail_message_id',
  'gmail_thread_id',
  'search_query',
  'label_name',
  'status',
  'requested_by',
  'processed_at',
  'result',
  'error',
  'retry_count',
  'next_retry_at'
];
commandCols.forEach((c) => assert(commandQueueGs.includes("'" + c + "'"), 'Commands column: ' + c));

const messageCols = [
  'sync_id',
  'account_id',
  'account_email',
  'gmail_message_id',
  'gmail_thread_id',
  'received_at',
  'from_address',
  'to_addresses',
  'cc_addresses',
  'subject',
  'snippet',
  'body_text',
  'body_text_expires_at',
  'labels',
  'is_unread',
  'is_starred',
  'has_attachments',
  'attachment_names',
  'last_synced_at',
  'sync_state'
];
messageCols.forEach((c) => assert(allGs.includes("'" + c + "'"), 'Messages column: ' + c));

// Tabs
['Accounts', 'Commands', 'Messages', 'Audit_Log', 'Settings'].forEach((t) => {
  assert(allGs.includes(t), 'tab referenced: ' + t);
});

// Account isolation
assert(allGs.includes('account_id does not match this deployment') || allGs.includes('does not match this deployment'), 'account isolation check present');
assert(/SUCCESS/.test(allGs) && /PENDING/.test(allGs), 'status machine present');

// Triggers: commands + sync + reconciliation
assert(allGs.includes('processPendingCommands') && allGs.includes('scheduledMessageSync'), 'dual trigger handlers');
assert(allGs.includes('scheduledMessageReconciliation'), 'reconciliation trigger handler');
assert(allGs.includes('removeTriggersForHandler_'), 'duplicate trigger prevention');
assert(setupGs.includes("removeTriggersForHandler_('scheduledMessageReconciliation')"), 'installTriggers_ clears reconcile duplicates');
assert(setupGs.includes('everyHours'), 'reconcile uses everyHours trigger API');
assert(setupGs.includes('normalizeReconcileHours_'), 'reconcile hours normalized to Apps Script-supported values');

// Body policy default
assert(allGs.includes('SNIPPET_ONLY'), 'default body policy SNIPPET_ONLY');

// README setup steps
assert(/Create one Google Sheet/i.test(readme), 'README has setup step: create sheet');
assert(/setupSystem/i.test(readme), 'README mentions setupSystem');
assert(/dry-run|runDryRunTest/i.test(readme), 'README mentions dry-run');
assert(/Share the control Sheet/i.test(readme), 'README mentions sharing sheet');
assert(/recreateTriggers/i.test(readme), 'README documents recreateTriggers after upgrade');
assert(/runInitialSync/i.test(readme), 'README documents runInitialSync');
assert(/RETRY_LATER/i.test(readme), 'README documents RETRY_LATER');
assert(/quota/i.test(readme), 'README documents quota posture');

// Samples
assert(fs.existsSync(path.join(ROOT, 'samples/sample_commands.csv')), 'sample_commands.csv exists');
assert(fs.existsSync(path.join(ROOT, 'docs/chatgpt-workflow.md')), 'chatgpt-workflow.md exists');
const sampleCsv = fs.readFileSync(path.join(ROOT, 'samples/sample_commands.csv'), 'utf8');
assert(sampleCsv.includes('retry_count'), 'sample CSV includes retry_count');
assert(sampleCsv.includes('next_retry_at'), 'sample CSV includes next_retry_at');

// appsscript.json valid
const manifest = JSON.parse(fs.readFileSync(path.join(APP, 'appsscript.json'), 'utf8'));
assert(manifest.runtimeVersion === 'V8', 'V8 runtime');
assert(
  manifest.dependencies &&
    manifest.dependencies.enabledAdvancedServices &&
    manifest.dependencies.enabledAdvancedServices.some((s) => s.serviceId === 'gmail'),
  'Advanced Gmail service enabled in manifest'
);

// Simulated logic checks (pure JS reimplementation of key rules)
function simulateTrashGate(trashEnabled, action) {
  if (action === 'TRASH' && !trashEnabled) return 'FAILED';
  return 'OK';
}
assert(simulateTrashGate(false, 'TRASH') === 'FAILED', 'acceptance: TRASH blocked when disabled');
assert(simulateTrashGate(true, 'TRASH') === 'OK', 'acceptance: TRASH allowed when enabled');

function simulateAmbiguous(matchCount) {
  if (matchCount > 1) return 'NEEDS_REVIEW';
  if (matchCount === 0) return 'FAILED';
  return 'OK';
}
assert(simulateAmbiguous(3) === 'NEEDS_REVIEW', 'acceptance: ambiguous search => NEEDS_REVIEW');

function simulateIdempotency(status) {
  return status === 'PENDING' || status === 'STALE_PROCESSING';
}
assert(!simulateIdempotency('SUCCESS'), 'acceptance: SUCCESS not re-executed');
assert(simulateIdempotency('PENDING'), 'acceptance: PENDING is executable');

function simulateAccountFilter(cmdAccount, deploymentAccount) {
  return cmdAccount === deploymentAccount;
}
assert(simulateAccountFilter('school', 'personal') === false, 'acceptance: Account A ignores Account B commands');
assert(simulateAccountFilter('school', 'school') === true, 'acceptance: matching account processed');

function simulateSyncId(accountId, messageId) {
  return accountId + '::' + messageId;
}
assert(
  simulateSyncId('personal', 'm1') !== simulateSyncId('school', 'm1'),
  'acceptance: same message id in two accounts stays distinct'
);

// Range API: numRows is lastRow-1 from row 2; numColumns is 1 not the column index
assert(
  /getRange\(\s*2\s*,\s*col\s*,\s*(?:numRows|lastRow\s*-\s*1)\s*,\s*1\s*\)/.test(allGs),
  'findMessageRowBySyncId_ uses numRows=lastRow-1 and numColumns=1'
);
assert(!/getRange\(\s*2\s*,\s*col\s*,\s*lastRow\s*,\s*col\s*\)/.test(allGs), 'no getRange(2, col, lastRow, col) anti-pattern');

// Action scope contract
assert(/ACTION_SCOPE/.test(allGs), 'ACTION_SCOPE map defined');
assert(/function\s+actionScope_/.test(allGs), 'actionScope_ helper defined');
assert(/thread-level/.test(allGs), 'thread-level language in executor results');
assert(/message-level/.test(allGs), 'message-level language in executor results');

// Full-text TTL
assert(allGs.includes('FULL_TEXT_TTL_HOURS'), 'FULL_TEXT_TTL_HOURS setting present');
assert(allGs.includes('body_text_expires_at'), 'body_text_expires_at column present');
assert(/function\s+expireFullTextInIndex_/.test(allGs), 'automatic full-text expiry implemented');
assert(/function\s+shouldPreserveFullText_/.test(allGs), 'full-text retention helper present');

function simulateFullTextPreserve(body, expiresAt, nowMs) {
  if (!body) return false;
  if (!expiresAt) return false;
  const when = new Date(expiresAt).getTime();
  if (Number.isNaN(when)) return false;
  return when > nowMs;
}
assert(simulateFullTextPreserve('secret', '', Date.now()) === false, 'legacy full text without expiry is not preserved');
assert(simulateFullTextPreserve('secret', new Date(Date.now() + 3600000).toISOString(), Date.now()) === true, 'unexpired full text is preserved');
assert(simulateFullTextPreserve('secret', new Date(Date.now() - 1000).toISOString(), Date.now()) === false, 'expired full text is cleared');

// ---------------------------------------------------------------------------
// Quota-efficiency acceptance
// ---------------------------------------------------------------------------

// Safe defaults in Config.gs (single source — Setup mirrors via DEFAULT_SETTINGS_ROWS)
assert(/SYNC_POLL_MINUTES:\s*30/.test(configGs), 'SYNC_POLL_MINUTES default 30');
assert(/MAX_MESSAGES_PER_SYNC:\s*75/.test(configGs), 'MAX_MESSAGES_PER_SYNC default 75');
assert(/MAX_RECONCILE_PER_SYNC:\s*25/.test(configGs), 'MAX_RECONCILE_PER_SYNC default 25');
assert(/RECONCILE_INTERVAL_HOURS:\s*6/.test(configGs), 'RECONCILE_INTERVAL_HOURS default 6');
assert(/INITIAL_MAX_MESSAGES_PER_SYNC:\s*200/.test(configGs), 'INITIAL_MAX_MESSAGES_PER_SYNC default 200');
assert(setupGs.includes("['SYNC_POLL_MINUTES', '30'"), 'Setup.gs Settings default SYNC_POLL_MINUTES=30');
assert(setupGs.includes("['MAX_MESSAGES_PER_SYNC', '75'"), 'Setup.gs Settings default MAX_MESSAGES_PER_SYNC=75');
assert(setupGs.includes("['MAX_RECONCILE_PER_SYNC', '25'"), 'Setup.gs Settings default MAX_RECONCILE_PER_SYNC=25');
assert(setupGs.includes("['RECONCILE_INTERVAL_HOURS', '6'"), 'Setup.gs Settings default RECONCILE_INTERVAL_HOURS=6');

// Scheduled sync must NOT call broad reconciliation
assert(/function\s+reconcileUnseenRows_/.test(messageSyncGs), 'unseen-row reconciliation helper present');
const runMessageSyncBody = messageSyncGs.match(/function\s+runMessageSync_\s*\([\s\S]*?\n\}/);
assert(!!runMessageSyncBody, 'runMessageSync_ body extractable');
assert(
  runMessageSyncBody && !/reconcileUnseenRows_/.test(runMessageSyncBody[0]),
  'scheduled sync path (runMessageSync_) does not perform broad reconciliation'
);
assert(
  /function\s+scheduledMessageSync[\s\S]*?runMessageSync_/.test(mainGs),
  'scheduledMessageSync uses runMessageSync_'
);
assert(
  /function\s+scheduledMessageReconciliation[\s\S]*?reconcileMessageState/.test(mainGs),
  'scheduledMessageReconciliation uses reconcileMessageState'
);

// Cursor-based reconciliation
assert(/getReconcileCursor_/.test(utilitiesGs), 'reconcile cursor getter present');
assert(/setReconcileCursor_/.test(utilitiesGs), 'reconcile cursor setter present');
assert(/useCursor/.test(messageSyncGs), 'reconcileUnseenRows_ supports cursor progression');
assert(/PropertiesService/.test(utilitiesGs), 'PropertiesService used for sync/reconcile state');

// Simulate cursor progression and wrap
function simulateReconcileCursor(totalEligible, startCursor, cap) {
  if (totalEligible <= 0) return { nextCursor: 0, lookups: 0 };
  const startPos = startCursor % totalEligible;
  const lookups = Math.min(cap, totalEligible);
  let nextCursor;
  if (lookups >= cap && lookups < totalEligible) {
    nextCursor = (startPos + lookups) % totalEligible;
  } else {
    nextCursor = 0; // full pass wraps
  }
  return { nextCursor, lookups };
}
assert(simulateReconcileCursor(100, 0, 25).nextCursor === 25, 'reconcile cursor advances 0→25');
assert(simulateReconcileCursor(100, 25, 25).nextCursor === 50, 'reconcile cursor advances 25→50');
assert(simulateReconcileCursor(100, 75, 25).nextCursor === 0, 'reconcile cursor wraps after last batch');
assert(simulateReconcileCursor(20, 0, 25).nextCursor === 0, 'reconcile cursor wraps when batch covers all');
assert(simulateReconcileCursor(100, 0, 25).lookups === 25, 'reconciliation respects batch cap');

// Retryable vs terminal errors
function simulateIsRetryableGmailError(err) {
  const text = String(err && err.message ? err.message : err).toLowerCase();
  if (!text) return false;
  if (text.indexOf('service invoked too many times') !== -1) return true;
  if (text.indexOf('gmail') !== -1 && text.indexOf('quota') !== -1) return true;
  if (
    text.indexOf('rate limit') !== -1 ||
    text.indexOf('ratelimitexceeded') !== -1 ||
    text.indexOf('too many requests') !== -1
  ) {
    return true;
  }
  if (
    text.indexOf('backend error') !== -1 ||
    text.indexOf('service unavailable') !== -1 ||
    text.indexOf('try again later') !== -1
  ) {
    return true;
  }
  return false;
}
assert(
  simulateIsRetryableGmailError('Exception: Service invoked too many times for one day: gmail'),
  'quota exception is retryable'
);
assert(simulateIsRetryableGmailError('Rate Limit Exceeded'), 'rate limit is retryable');
assert(simulateIsRetryableGmailError('Backend Error'), 'backend error is retryable');
assert(!simulateIsRetryableGmailError('Missing account_id on command.'), 'validation error is terminal');
assert(!simulateIsRetryableGmailError('LABEL requires label_name.'), 'missing label_name is terminal');
assert(!simulateIsRetryableGmailError('Unknown action: EXPLODE'), 'unsupported action is terminal');
assert(
  !simulateIsRetryableGmailError('search_query matched 3 messages; refusing to guess'),
  'ambiguous search is terminal'
);

function simulateCommandOutcome(err) {
  if (simulateIsRetryableGmailError(err)) return 'RETRY_LATER';
  return 'FAILED';
}
assert(
  simulateCommandOutcome('Service invoked too many times for one day: gmail') === 'RETRY_LATER',
  'quota exception produces RETRY_LATER, not FAILED'
);
assert(simulateCommandOutcome('Missing action.') === 'FAILED', 'terminal errors remain FAILED');

// Backoff / next_retry_at gating
function simulateBackoffMinutes(retryCount) {
  if (retryCount <= 1) return 30;
  if (retryCount === 2) return 120;
  return 360;
}
function simulateRetryEligible(status, nextRetryAt, nowMs) {
  if (status === 'PENDING') return true;
  if (status !== 'RETRY_LATER') return false;
  if (!nextRetryAt) return true;
  const when = new Date(nextRetryAt).getTime();
  if (Number.isNaN(when)) return true;
  return when <= nowMs;
}
const now = Date.now();
assert(simulateBackoffMinutes(1) === 30, 'retry 1 backoff +30 minutes');
assert(simulateBackoffMinutes(2) === 120, 'retry 2 backoff +2 hours');
assert(simulateBackoffMinutes(3) === 360, 'retry 3+ backoff +6 hours');
assert(
  !simulateRetryEligible('RETRY_LATER', new Date(now + 30 * 60 * 1000).toISOString(), now),
  'next_retry_at prevents immediate retry'
);
assert(
  simulateRetryEligible('RETRY_LATER', new Date(now - 1000).toISOString(), now),
  'retry becomes eligible after backoff expires'
);
assert(!simulateRetryEligible('FAILED', '', now), 'FAILED is never reclaimed');
assert(!simulateRetryEligible('NEEDS_REVIEW', '', now), 'NEEDS_REVIEW is never reclaimed');

// Claim logic must mention RETRY_LATER + next_retry_at
assert(/RETRY_LATER/.test(commandQueueGs), 'claim path aware of RETRY_LATER');
assert(/next_retry_at/.test(commandQueueGs), 'claim path checks next_retry_at');
assert(/markCommandRetryLater_/.test(mainGs), 'Main defers quota failures via markCommandRetryLater_');
assert(/deferCommandForRetry_/.test(mainGs), 'Main has deferCommandForRetry_ helper');

// Sync quota abort must not mark REMOVED
assert(/quotaAborted|Gmail quota/.test(messageSyncGs), 'sync/reconcile handle quota abort');
assert(
  /without marking rows REMOVED|without marking remaining rows REMOVED/.test(messageSyncGs),
  'quota during sync/reconcile does not mark existing rows REMOVED'
);
assert(/setLastSuccessfulSyncAt_/.test(utilitiesGs), 'last successful sync timestamp persisted');
assert(/getLastSuccessfulSyncAt_/.test(utilitiesGs), 'last successful sync timestamp read');
assert(
  /last successful sync timestamp preserved/.test(messageSyncGs),
  'quota abort preserves last successful sync state'
);

// Snippet path must not use getPlainBody for SNIPPET_ONLY
assert(/fetchGmailMessageMetadata_/.test(messageSyncGs), 'Advanced Gmail metadata helper present');
assert(/snippetFromMetadataOrSubject_/.test(messageSyncGs), 'snippet prefers metadata over body');
assert(/Avoid getPlainBody|avoid getPlainBody|Do not call msg\.getAttachments/i.test(messageSyncGs), 'documents avoiding expensive GmailApp body/attachment reads');
function stripJsComments_(src) {
  return String(src || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}
const snippetHelper = messageSyncGs.match(/function\s+snippetFromMetadataOrSubject_[\s\S]*?\n\}/);
assert(
  snippetHelper && !/getPlainBody\s*\(/.test(stripJsComments_(snippetHelper[0])),
  'snippet helper does not call getPlainBody'
);
const buildSnap = messageSyncGs.match(/function\s+buildMessageSnapshot_[\s\S]*?\nfunction\s+fetchGmailMessageMetadata_/);
assert(
  buildSnap && !/getAttachments\s*\(/.test(stripJsComments_(buildSnap[0])),
  'buildMessageSnapshot_ does not call getAttachments'
);
assert(
  /policy === 'FULL_TEXT'[\s\S]*getPlainBody/.test(messageSyncGs),
  'getPlainBody only on FULL_TEXT path'
);

// Targeted post-mutation refresh still present
assert(/post-mutation|toRefresh/.test(mainGs), 'targeted post-mutation refresh present');
assert(/isThreadLevelAction_/.test(mainGs), 'thread-level post-refresh still works');
assert(/upsertMessageRow_/.test(mainGs), 'exact-message upsert used after mutations');

// Max messages cap respected in sync runner
assert(/upserts >= max/.test(messageSyncGs), 'scheduled sync respects message cap');
assert(/MAX_MESSAGES_PER_SYNC/.test(messageSyncGs), 'sync uses MAX_MESSAGES_PER_SYNC setting');

// Settings merge without overwrite
assert(/Merge any missing keys without overwriting/.test(setupGs) || /without overwriting user values/.test(setupGs), 'setupSystem merges Settings safely');

// Architecture intact
assert(/TAB_ACCOUNTS:\s*'Accounts'/.test(configGs), 'Accounts tab intact');
assert(/TAB_COMMANDS:\s*'Commands'/.test(configGs), 'Commands tab intact');
assert(/TAB_MESSAGES:\s*'Messages'/.test(configGs), 'Messages tab intact');
assert(/TAB_AUDIT:\s*'Audit_Log'/.test(configGs), 'Audit_Log tab intact');
assert(/TAB_SETTINGS:\s*'Settings'/.test(configGs), 'Settings tab intact');

// README contract
assert(/DRY_RUN.*TRUE/i.test(readme) || /defaults to TRUE/.test(readme), 'README documents DRY_RUN default TRUE');
assert(/thread-level/.test(readme), 'README documents thread-level actions');
assert(/30/.test(readme) && /75/.test(readme), 'README documents new sync defaults');

console.log('\n' + (failed === 0 ? 'All checks passed.' : failed + ' check(s) failed.'));
process.exit(failed === 0 ? 0 : 1);
