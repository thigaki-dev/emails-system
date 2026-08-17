/**
 * =============================================================================
 * Config.gs — Account identity and safe defaults
 * =============================================================================
 *
 * ★★★ USER MUST EDIT THE BLOCK BELOW BEFORE RUNNING setupSystem() ★★★
 *
 * Install this same codebase separately while signed into EACH Gmail account.
 * Example for school@example.edu:
 *   ACCOUNT_ID    = "school"
 *   ACCOUNT_EMAIL = "school@example.edu"
 *   CONTROL_SHEET_ID = "<id of the shared control Google Sheet>"
 */

// ---------------------------------------------------------------------------
// >>> EDIT THESE THREE VALUES FOR THIS DEPLOYMENT <<<
// ---------------------------------------------------------------------------
var ACCOUNT_ID = 'TYPE_ACCOUNT_ID_HERE';          // e.g. "personal", "school", "research"
var ACCOUNT_EMAIL = 'TYPE_THIS_DEPLOYMENT_EMAIL_HERE'; // e.g. "you@gmail.com"
var CONTROL_SHEET_ID = 'TYPE_SHARED_GOOGLE_SHEET_ID_HERE'; // Spreadsheet ID from the Sheet URL
// ---------------------------------------------------------------------------
// >>> END OF REQUIRED EDITS <<<
// ---------------------------------------------------------------------------

/**
 * Safe defaults. Prefer changing values via the Settings sheet after setup
 * rather than hard-coding here, except for the three identity fields above.
 */
var CONFIG = {
  // Sheet tab names
  TAB_ACCOUNTS: 'Accounts',
  TAB_COMMANDS: 'Commands',
  TAB_MESSAGES: 'Messages',
  TAB_AUDIT: 'Audit_Log',
  TAB_SETTINGS: 'Settings',

  // Command processor
  MAX_COMMANDS_PER_RUN: 25,
  COMMAND_POLL_MINUTES: 5,

  // Message sync
  SYNC_LOOKBACK_DAYS: 30,
  SYNC_POLL_MINUTES: 15,
  MAX_MESSAGES_PER_SYNC: 200,
  BODY_SYNC_POLICY: 'SNIPPET_ONLY', // NONE | SNIPPET_ONLY | FULL_TEXT
  MESSAGE_RETENTION_DAYS: 60,
  FULL_TEXT_TTL_HOURS: 24,
  MAX_RECONCILE_PER_SYNC: 200,

  // Safety — DRY_RUN stays on until you inspect Audit_Log and opt into live mutations
  DRY_RUN: true,
  TRASH_ENABLED: false,
  AUTO_CREATE_LABELS: true,

  // Status values
  STATUS: {
    PENDING: 'PENDING',
    PROCESSING: 'PROCESSING',
    SUCCESS: 'SUCCESS',
    FAILED: 'FAILED',
    NEEDS_REVIEW: 'NEEDS_REVIEW'
  },

  // Mutation actions (Phase 1 + Phase 2)
  MUTATION_ACTIONS: [
    'LABEL',
    'REMOVE_LABEL',
    'ARCHIVE',
    'MOVE_TO_INBOX',
    'MARK_READ',
    'MARK_UNREAD',
    'STAR',
    'UNSTAR',
    'TRASH'
  ],

  // Infrastructure / sync actions (bidirectional bridge)
  INFRA_ACTIONS: [
    'SYNC_NOW',
    'REFRESH_MESSAGE',
    'FETCH_FULL_TEXT',
    'CLEAR_FULL_TEXT'
  ],

  SYNC_STATE: {
    ACTIVE: 'ACTIVE',
    UPDATED: 'UPDATED',
    REMOVED: 'REMOVED',
    ERROR: 'ERROR'
  },

  /**
   * Mutation scope contract (GmailApp semantics):
   *   message — only the targeted GmailMessage is changed
   *   thread  — the entire thread is changed (GmailApp labels/archive/inbox are thread APIs)
   */
  ACTION_SCOPE: {
    MARK_READ: 'message',
    MARK_UNREAD: 'message',
    STAR: 'message',
    UNSTAR: 'message',
    TRASH: 'message',
    LABEL: 'thread',
    REMOVE_LABEL: 'thread',
    ARCHIVE: 'thread',
    MOVE_TO_INBOX: 'thread'
  }
};

/**
 * Returns a merged runtime config: static defaults overridden by Settings sheet.
 * Falls back to CONFIG defaults if the Settings tab is missing or unreadable.
 */
function getRuntimeConfig_() {
  var runtime = {
    ACCOUNT_ID: ACCOUNT_ID,
    ACCOUNT_EMAIL: ACCOUNT_EMAIL,
    CONTROL_SHEET_ID: CONTROL_SHEET_ID,
    MAX_COMMANDS_PER_RUN: CONFIG.MAX_COMMANDS_PER_RUN,
    COMMAND_POLL_MINUTES: CONFIG.COMMAND_POLL_MINUTES,
    SYNC_LOOKBACK_DAYS: CONFIG.SYNC_LOOKBACK_DAYS,
    SYNC_POLL_MINUTES: CONFIG.SYNC_POLL_MINUTES,
    MAX_MESSAGES_PER_SYNC: CONFIG.MAX_MESSAGES_PER_SYNC,
    BODY_SYNC_POLICY: CONFIG.BODY_SYNC_POLICY,
    MESSAGE_RETENTION_DAYS: CONFIG.MESSAGE_RETENTION_DAYS,
    FULL_TEXT_TTL_HOURS: CONFIG.FULL_TEXT_TTL_HOURS,
    MAX_RECONCILE_PER_SYNC: CONFIG.MAX_RECONCILE_PER_SYNC,
    DRY_RUN: CONFIG.DRY_RUN,
    TRASH_ENABLED: CONFIG.TRASH_ENABLED,
    AUTO_CREATE_LABELS: CONFIG.AUTO_CREATE_LABELS
  };

  try {
    var ss = openControlSpreadsheet_();
    var sheet = ss.getSheetByName(CONFIG.TAB_SETTINGS);
    if (!sheet) {
      return runtime;
    }
    var values = sheet.getDataRange().getValues();
    for (var i = 1; i < values.length; i++) {
      var key = String(values[i][0] || '').trim();
      var raw = values[i][1];
      if (!key) {
        continue;
      }
      if (key === 'DRY_RUN' || key === 'TRASH_ENABLED' || key === 'AUTO_CREATE_LABELS') {
        runtime[key] = parseBooleanSetting_(raw);
      } else if (
        key === 'MAX_COMMANDS_PER_RUN' ||
        key === 'COMMAND_POLL_MINUTES' ||
        key === 'SYNC_LOOKBACK_DAYS' ||
        key === 'SYNC_POLL_MINUTES' ||
        key === 'MAX_MESSAGES_PER_SYNC' ||
        key === 'MESSAGE_RETENTION_DAYS' ||
        key === 'FULL_TEXT_TTL_HOURS' ||
        key === 'MAX_RECONCILE_PER_SYNC'
      ) {
        var num = Number(raw);
        if (!isNaN(num) && num > 0) {
          runtime[key] = num;
        }
      } else if (key === 'BODY_SYNC_POLICY') {
        var policy = String(raw || '').trim().toUpperCase();
        if (policy === 'NONE' || policy === 'SNIPPET_ONLY' || policy === 'FULL_TEXT') {
          runtime.BODY_SYNC_POLICY = policy;
        }
      }
    }
  } catch (err) {
    Logger.log('getRuntimeConfig_ warning: ' + err);
  }

  return runtime;
}

function parseBooleanSetting_(raw) {
  if (typeof raw === 'boolean') {
    return raw;
  }
  var s = String(raw || '').trim().toUpperCase();
  return s === 'TRUE' || s === '1' || s === 'YES';
}

function openControlSpreadsheet_() {
  if (!CONTROL_SHEET_ID || CONTROL_SHEET_ID.indexOf('TYPE_') === 0) {
    throw new Error(
      'CONTROL_SHEET_ID is not configured. Edit Config.gs and set CONTROL_SHEET_ID to your shared Google Sheet ID.'
    );
  }
  return SpreadsheetApp.openById(CONTROL_SHEET_ID);
}

function assertDeploymentIdentityConfigured_() {
  if (!ACCOUNT_ID || ACCOUNT_ID.indexOf('TYPE_') === 0) {
    throw new Error('ACCOUNT_ID is not configured. Edit Config.gs.');
  }
  if (!ACCOUNT_EMAIL || ACCOUNT_EMAIL.indexOf('TYPE_') === 0) {
    throw new Error('ACCOUNT_EMAIL is not configured. Edit Config.gs.');
  }
  if (!CONTROL_SHEET_ID || CONTROL_SHEET_ID.indexOf('TYPE_') === 0) {
    throw new Error('CONTROL_SHEET_ID is not configured. Edit Config.gs.');
  }
}
