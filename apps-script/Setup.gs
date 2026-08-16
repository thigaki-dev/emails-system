/**
 * Setup.gs — initialize Sheet structure, labels, and triggers
 */

var ACCOUNT_HEADERS = ['account_id', 'email_address', 'display_name', 'enabled'];

var SETTINGS_HEADERS = ['key', 'value', 'description'];

var DEFAULT_SETTINGS_ROWS = [
  ['DRY_RUN', 'FALSE', 'When TRUE, log intended Gmail actions without modifying mail.'],
  ['TRASH_ENABLED', 'FALSE', 'When FALSE, TRASH commands fail safely.'],
  ['AUTO_CREATE_LABELS', 'TRUE', 'Create missing user labels on LABEL actions.'],
  ['MAX_COMMANDS_PER_RUN', '25', 'Cap on commands processed per processPendingCommands run.'],
  ['COMMAND_POLL_MINUTES', '5', 'Minutes between command-processor triggers.'],
  ['SYNC_LOOKBACK_DAYS', '30', 'How far back message sync looks by default.'],
  ['SYNC_POLL_MINUTES', '15', 'Minutes between message-sync triggers.'],
  ['MAX_MESSAGES_PER_SYNC', '200', 'Cap on messages upserted per sync run.'],
  ['BODY_SYNC_POLICY', 'SNIPPET_ONLY', 'NONE | SNIPPET_ONLY | FULL_TEXT'],
  ['MESSAGE_RETENTION_DAYS', '60', 'Prune Messages rows older than this many days.']
];

var DEFAULT_ACCOUNTS = [
  ['personal', 'TYPE_EMAIL_1_HERE', 'Personal Gmail', 'TRUE'],
  ['school', 'TYPE_EMAIL_2_HERE', 'School Gmail', 'TRUE'],
  ['research', 'TYPE_EMAIL_3_HERE', 'Research Gmail', 'TRUE']
];

/**
 * Primary setup entry point. Run once per deployment after editing Config.gs.
 * Creates/repairs all control-sheet tabs and installs triggers (without duplicates).
 */
function setupSystem() {
  assertDeploymentIdentityConfigured_();
  var ss = openControlSpreadsheet_();

  ensureAccountsSheet_(ss);
  ensureCommandsSheet_(ss);
  ensureMessagesSheet_(ss);
  ensureAuditSheet_(ss);
  ensureSettingsSheet_(ss);

  installTriggers_();

  var msg =
    'setupSystem complete for ACCOUNT_ID=' +
    ACCOUNT_ID +
    ' ACCOUNT_EMAIL=' +
    ACCOUNT_EMAIL +
    '. Replace TYPE_EMAIL_* placeholders in the Accounts tab if you have not already.';
  Logger.log(msg);
  return msg;
}

function ensureAccountsSheet_(ss) {
  var sheet = ss.getSheetByName(CONFIG.TAB_ACCOUNTS);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.TAB_ACCOUNTS);
  }
  ensureHeaders_(sheet, ACCOUNT_HEADERS);
  if (sheet.getLastRow() < 2) {
    sheet.getRange(2, 1, DEFAULT_ACCOUNTS.length, ACCOUNT_HEADERS.length).setValues(DEFAULT_ACCOUNTS);
  }
  return sheet;
}

function ensureSettingsSheet_(ss) {
  var sheet = ss.getSheetByName(CONFIG.TAB_SETTINGS);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.TAB_SETTINGS);
  }
  ensureHeaders_(sheet, SETTINGS_HEADERS);
  if (sheet.getLastRow() < 2) {
    sheet
      .getRange(2, 1, DEFAULT_SETTINGS_ROWS.length, SETTINGS_HEADERS.length)
      .setValues(DEFAULT_SETTINGS_ROWS);
  } else {
    // Merge any missing keys without overwriting user values
    var existing = {};
    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      existing[String(data[i][0]).trim()] = true;
    }
    DEFAULT_SETTINGS_ROWS.forEach(function (row) {
      if (!existing[row[0]]) {
        sheet.appendRow(row);
      }
    });
  }
  return sheet;
}

/**
 * Install time-driven triggers for command processing and message sync.
 * Removes duplicates for the same handler before creating new ones.
 */
function installTriggers_() {
  var runtime = getRuntimeConfig_();
  removeTriggersForHandler_('processPendingCommands');
  removeTriggersForHandler_('scheduledMessageSync');

  ScriptApp.newTrigger('processPendingCommands')
    .timeBased()
    .everyMinutes(normalizePollMinutes_(runtime.COMMAND_POLL_MINUTES, 5))
    .create();

  ScriptApp.newTrigger('scheduledMessageSync')
    .timeBased()
    .everyMinutes(normalizePollMinutes_(runtime.SYNC_POLL_MINUTES, 15))
    .create();

  Logger.log(
    'Triggers installed: processPendingCommands every ' +
      runtime.COMMAND_POLL_MINUTES +
      'm; scheduledMessageSync every ' +
      runtime.SYNC_POLL_MINUTES +
      'm'
  );
}

/**
 * Recreate triggers using current Settings values.
 */
function recreateTriggers() {
  assertDeploymentIdentityConfigured_();
  installTriggers_();
  return 'Triggers recreated.';
}

/**
 * Remove all project triggers created by this script.
 */
function removeAllTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function (t) {
    ScriptApp.deleteTrigger(t);
  });
  return 'Removed ' + triggers.length + ' trigger(s).';
}

function removeTriggersForHandler_(handlerName) {
  var triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function (t) {
    if (t.getHandlerFunction() === handlerName) {
      ScriptApp.deleteTrigger(t);
    }
  });
}

/**
 * Apps Script everyMinutes supports 1, 5, 10, 15, 30.
 */
function normalizePollMinutes_(value, fallback) {
  var allowed = [1, 5, 10, 15, 30];
  var n = Number(value);
  if (allowed.indexOf(n) !== -1) {
    return n;
  }
  // Pick nearest allowed
  var best = fallback;
  var bestDiff = 999;
  for (var i = 0; i < allowed.length; i++) {
    var diff = Math.abs(allowed[i] - n);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = allowed[i];
    }
  }
  return best;
}

/**
 * Seed sample command rows for testing (PENDING, harmless actions).
 * Does not modify Gmail by itself — processing happens via processPendingCommands.
 */
function seedSampleCommands() {
  assertDeploymentIdentityConfigured_();
  var samples = [
    {
      account_id: ACCOUNT_ID,
      action: 'SYNC_NOW',
      requested_by: 'setup/sample',
      search_query: '',
      label_name: ''
    },
    {
      account_id: ACCOUNT_ID,
      action: 'MARK_READ',
      search_query: 'in:inbox is:unread newer_than:1d',
      requested_by: 'setup/sample',
      label_name: ''
    },
    {
      account_id: ACCOUNT_ID,
      action: 'LABEL',
      search_query: 'subject:[SAMPLE_DO_NOT_MATCH_REAL_MAIL]',
      label_name: 'Research/Sample',
      requested_by: 'setup/sample'
    }
  ];
  var ids = samples.map(function (s) {
    return appendCommand_(s);
  });
  return 'Seeded sample commands: ' + ids.join(', ');
}
