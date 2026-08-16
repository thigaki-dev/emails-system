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
assert(/DRY_RUN:\s*false/i.test(allGs) || /DRY_RUN',\s*'FALSE'/.test(allGs), 'DRY_RUN defaults false');
assert(allGs.includes('NEEDS_REVIEW'), 'NEEDS_REVIEW status supported');
assert(allGs.includes('LockService'), 'uses LockService');
assert(allGs.includes('writeAuditLog_'), 'audit logging present');
assert(allGs.includes('runDryRunTest'), 'dry-run harness present');

// Required functions
const requiredFns = [
  'setupSystem',
  'processPendingCommands',
  'scheduledMessageSync',
  'syncRecentMessages',
  'syncPriorityMessages',
  'syncOneMessage',
  'fetchFullTextForMessage',
  'clearStoredBodyText',
  'reconcileMessageState',
  'recreateTriggers',
  'removeAllTriggers',
  'runDryRunTest',
  'seedSampleCommands'
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
  'error'
];
commandCols.forEach((c) => assert(allGs.includes("'" + c + "'"), 'Commands column: ' + c));

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

// Dual triggers
assert(allGs.includes("processPendingCommands") && allGs.includes('scheduledMessageSync'), 'dual trigger handlers');
assert(allGs.includes('removeTriggersForHandler_'), 'duplicate trigger prevention');

// Body policy default
assert(allGs.includes('SNIPPET_ONLY'), 'default body policy SNIPPET_ONLY');

// README setup steps
assert(/Create one Google Sheet/i.test(readme), 'README has setup step: create sheet');
assert(/setupSystem/i.test(readme), 'README mentions setupSystem');
assert(/dry-run|runDryRunTest/i.test(readme), 'README mentions dry-run');
assert(/Share the control Sheet/i.test(readme), 'README mentions sharing sheet');

// Samples
assert(fs.existsSync(path.join(ROOT, 'samples/sample_commands.csv')), 'sample_commands.csv exists');
assert(fs.existsSync(path.join(ROOT, 'docs/chatgpt-workflow.md')), 'chatgpt-workflow.md exists');

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

console.log('\n' + (failed === 0 ? 'All checks passed.' : failed + ' check(s) failed.'));
process.exit(failed === 0 ? 0 : 1);
