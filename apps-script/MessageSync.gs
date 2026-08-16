/**
 * MessageSync.gs — bidirectional Messages tab synchronization
 *
 * READ PATH: Original Gmail → this deployment → Messages tab → ChatGPT
 *
 * Each deployment synchronizes ONLY the Gmail account that authorized it.
 * Defaults minimize data: recent window, SNIPPET_ONLY body policy, no attachments.
 */

var MESSAGE_HEADERS = [
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

function ensureMessagesSheet_(ss) {
  var sheet = ss.getSheetByName(CONFIG.TAB_MESSAGES);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.TAB_MESSAGES);
  }
  ensureHeaders_(sheet, MESSAGE_HEADERS);
  return sheet;
}

/**
 * Sync the configured recent Gmail window for this account.
 */
function syncRecentMessages() {
  assertDeploymentIdentityConfigured_();
  var runtime = getRuntimeConfig_();
  var query = buildLookbackQuery_(runtime.SYNC_LOOKBACK_DAYS, 'in:anywhere');
  return runMessageSync_('syncRecentMessages', query, runtime, false);
}

/**
 * Prefer Inbox / unread / starred / recently modified messages.
 */
function syncPriorityMessages() {
  assertDeploymentIdentityConfigured_();
  var runtime = getRuntimeConfig_();
  var query = buildLookbackQuery_(
    runtime.SYNC_LOOKBACK_DAYS,
    'in:inbox OR is:unread OR is:starred'
  );
  return runMessageSync_('syncPriorityMessages', query, runtime, false);
}

/**
 * Refresh one exact Gmail message into the Messages tab.
 */
function syncOneMessage(messageId) {
  assertDeploymentIdentityConfigured_();
  var runtime = getRuntimeConfig_();
  if (!messageId) {
    throw new Error('syncOneMessage requires messageId');
  }
  var msg = GmailApp.getMessageById(messageId);
  if (!msg) {
    throw new Error('Message not found: ' + messageId);
  }
  var lock = acquireLock_(30000);
  if (!lock) {
    throw new Error('Could not acquire lock for syncOneMessage');
  }
  try {
    upsertMessageRow_(msg, runtime, runtime.BODY_SYNC_POLICY);
    return 'Refreshed message ' + messageId;
  } finally {
    releaseLock_(lock);
  }
}

/**
 * Populate body_text for one exact message (ChatGPT-directed escalation).
 */
function fetchFullTextForMessage(messageId) {
  assertDeploymentIdentityConfigured_();
  var runtime = getRuntimeConfig_();
  if (!messageId) {
    throw new Error('fetchFullTextForMessage requires messageId');
  }
  var msg = GmailApp.getMessageById(messageId);
  if (!msg) {
    throw new Error('Message not found: ' + messageId);
  }
  var lock = acquireLock_(30000);
  if (!lock) {
    throw new Error('Could not acquire lock for fetchFullTextForMessage');
  }
  try {
    upsertMessageRow_(msg, runtime, 'FULL_TEXT');
    return 'Fetched full text for message ' + messageId;
  } finally {
    releaseLock_(lock);
  }
}

/**
 * Remove cached body_text for one message after ChatGPT no longer needs it.
 */
function clearStoredBodyText(messageId) {
  assertDeploymentIdentityConfigured_();
  var runtime = getRuntimeConfig_();
  if (!messageId) {
    throw new Error('clearStoredBodyText requires messageId');
  }
  var ss = openControlSpreadsheet_();
  var sheet = ensureMessagesSheet_(ss);
  var syncId = makeSyncId_(runtime.ACCOUNT_ID, messageId);
  var found = findMessageRowBySyncId_(sheet, syncId);
  if (!found) {
    return 'No Messages row for ' + syncId + '; nothing to clear';
  }
  var headerMap = headerIndexMap_(sheet);
  var row = sheet.getRange(found.rowNumber, 1, 1, MESSAGE_HEADERS.length).getValues()[0];
  row[headerMap.body_text] = '';
  row[headerMap.last_synced_at] = nowIso_();
  row[headerMap.sync_state] = CONFIG.SYNC_STATE.UPDATED;
  sheet.getRange(found.rowNumber, 1, 1, MESSAGE_HEADERS.length).setValues([row]);
  return 'Cleared body_text for ' + syncId;
}

/**
 * Update labels/read/star/archive/trash state for this account's Messages rows
 * that still exist in Gmail. Marks missing messages as REMOVED (does not delete rows).
 */
function reconcileMessageState() {
  assertDeploymentIdentityConfigured_();
  var runtime = getRuntimeConfig_();
  var lock = acquireLock_(30000);
  if (!lock) {
    throw new Error('Could not acquire lock for reconcileMessageState');
  }
  try {
    var ss = openControlSpreadsheet_();
    var sheet = ensureMessagesSheet_(ss);
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) {
      return 'No message rows to reconcile';
    }
    var headerMap = headerIndexMap_(sheet);
    var values = sheet.getRange(2, 1, lastRow, MESSAGE_HEADERS.length).getValues();
    var updated = 0;
    var removed = 0;

    for (var i = 0; i < values.length; i++) {
      var obj = rowToObject_(values[i], headerMap);
      if (String(obj.account_id || '').trim() !== runtime.ACCOUNT_ID) {
        continue;
      }
      var mid = String(obj.gmail_message_id || '').trim();
      if (!mid) {
        continue;
      }
      try {
        var msg = GmailApp.getMessageById(mid);
        if (!msg) {
          values[i][headerMap.sync_state] = CONFIG.SYNC_STATE.REMOVED;
          values[i][headerMap.last_synced_at] = nowIso_();
          removed++;
          continue;
        }
        var snapshot = buildMessageSnapshot_(msg, runtime, 'NONE');
        // Preserve existing body_text unless policy says otherwise
        snapshot.body_text = obj.body_text || '';
        snapshot.sync_state = CONFIG.SYNC_STATE.UPDATED;
        values[i] = objectToRow_(snapshot, MESSAGE_HEADERS);
        updated++;
      } catch (err) {
        values[i][headerMap.sync_state] = CONFIG.SYNC_STATE.REMOVED;
        values[i][headerMap.last_synced_at] = nowIso_();
        removed++;
      }
    }

    sheet.getRange(2, 1, lastRow, MESSAGE_HEADERS.length).setValues(values);
    pruneOldMessageRows_(sheet, runtime);
    return 'Reconciled: updated=' + updated + ', marked_removed=' + removed;
  } finally {
    releaseLock_(lock);
  }
}

/**
 * Internal sync runner used by syncRecentMessages / syncPriorityMessages
 * and the scheduled trigger.
 */
function runMessageSync_(label, query, runtime, skipLock) {
  var lock = null;
  if (!skipLock) {
    lock = acquireLock_(30000);
    if (!lock) {
      return label + ': skipped (lock unavailable)';
    }
  }
  try {
    var max = runtime.MAX_MESSAGES_PER_SYNC || 200;
    var threads = GmailApp.search(query, 0, Math.min(max, 500));
    var seenIds = {};
    var upserts = 0;

    for (var t = 0; t < threads.length; t++) {
      var messages = threads[t].getMessages();
      for (var m = 0; m < messages.length; m++) {
        if (upserts >= max) {
          break;
        }
        var msg = messages[m];
        var id = msg.getId();
        if (seenIds[id]) {
          continue;
        }
        seenIds[id] = true;
        upsertMessageRow_(msg, runtime, runtime.BODY_SYNC_POLICY);
        upserts++;
      }
      if (upserts >= max) {
        break;
      }
    }

    // Mark previously ACTIVE rows for this account that were not seen as REMOVED
    // only within the lookback window sync — done lightly via reconcile of unseen
    // is expensive; instead prune old rows and leave unseen ACTIVE rows until
    // reconcileMessageState is called.
    var ss = openControlSpreadsheet_();
    var sheet = ensureMessagesSheet_(ss);
    pruneOldMessageRows_(sheet, runtime);

    var summary = label + ': upserted ' + upserts + ' messages (query=' + query + ')';
    Logger.log(summary);
    return summary;
  } finally {
    releaseLock_(lock);
  }
}

function upsertMessageRow_(msg, runtime, bodyPolicy) {
  var ss = openControlSpreadsheet_();
  var sheet = ensureMessagesSheet_(ss);
  var snapshot = buildMessageSnapshot_(msg, runtime, bodyPolicy);
  var found = findMessageRowBySyncId_(sheet, snapshot.sync_id);

  if (found) {
    // Preserve FULL_TEXT body unless this call explicitly refreshes or clears
    if (bodyPolicy !== 'FULL_TEXT') {
      var headerMap = headerIndexMap_(sheet);
      var existing = sheet.getRange(found.rowNumber, 1, 1, MESSAGE_HEADERS.length).getValues()[0];
      var existingBody = existing[headerMap.body_text];
      if (bodyPolicy === 'NONE' || bodyPolicy === 'SNIPPET_ONLY') {
        // Keep previously fetched full text unless clearing explicitly
        if (existingBody) {
          snapshot.body_text = existingBody;
        }
      }
    }
    snapshot.sync_state = CONFIG.SYNC_STATE.UPDATED;
    sheet
      .getRange(found.rowNumber, 1, 1, MESSAGE_HEADERS.length)
      .setValues([objectToRow_(snapshot, MESSAGE_HEADERS)]);
  } else {
    snapshot.sync_state = CONFIG.SYNC_STATE.ACTIVE;
    sheet.appendRow(objectToRow_(snapshot, MESSAGE_HEADERS));
  }
}

function buildMessageSnapshot_(msg, runtime, bodyPolicy) {
  var thread = msg.getThread();
  var attachments = msg.getAttachments({ includeInlineImages: false, includeAttachments: true });
  var attachmentNames = attachments.map(function (a) {
    return a.getName();
  });

  var labels = [];
  if (thread) {
    var userLabels = thread.getLabels();
    labels = userLabels.map(function (l) {
      return l.getName();
    });
    // Include system-ish state hints via unread/starred flags rather than raw system labels
  }

  var bodyText = '';
  var policy = (bodyPolicy || runtime.BODY_SYNC_POLICY || 'SNIPPET_ONLY').toUpperCase();
  if (policy === 'FULL_TEXT') {
    try {
      bodyText = truncate_(msg.getPlainBody() || '', 50000);
    } catch (err) {
      bodyText = '';
    }
  }

  var snippet = '';
  if (policy !== 'NONE') {
    try {
      snippet = truncate_(msg.getPlainBody() || msg.getSubject() || '', 500);
    } catch (err) {
      snippet = truncate_(msg.getSubject() || '', 200);
    }
  }

  return {
    sync_id: makeSyncId_(runtime.ACCOUNT_ID, msg.getId()),
    account_id: runtime.ACCOUNT_ID,
    account_email: runtime.ACCOUNT_EMAIL,
    gmail_message_id: msg.getId(),
    gmail_thread_id: thread ? thread.getId() : '',
    received_at: msg.getDate() ? msg.getDate().toISOString() : '',
    from_address: msg.getFrom() || '',
    to_addresses: msg.getTo() || '',
    cc_addresses: msg.getCc() || '',
    subject: msg.getSubject() || '',
    snippet: snippet,
    body_text: bodyText,
    labels: normalizeLabelList_(labels),
    is_unread: boolToSheet_(msg.isUnread()),
    is_starred: boolToSheet_(msg.isStarred()),
    has_attachments: boolToSheet_(attachmentNames.length > 0),
    attachment_names: attachmentNames.join(', '),
    last_synced_at: nowIso_(),
    sync_state: CONFIG.SYNC_STATE.ACTIVE
  };
}

function findMessageRowBySyncId_(sheet, syncId) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return null;
  }
  var headerMap = headerIndexMap_(sheet);
  var col = headerMap.sync_id + 1;
  var values = sheet.getRange(2, col, lastRow, col).getValues();
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0]) === syncId) {
      return { rowNumber: i + 2 };
    }
  }
  return null;
}

/**
 * Prune old Messages rows past retention while preserving Audit_Log.
 * Does not delete rows for other accounts.
 */
function pruneOldMessageRows_(sheet, runtime) {
  var retentionDays = runtime.MESSAGE_RETENTION_DAYS || 60;
  if (retentionDays <= 0) {
    return;
  }
  var cutoff = new Date().getTime() - retentionDays * 24 * 60 * 60 * 1000;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return;
  }
  var headerMap = headerIndexMap_(sheet);
  var values = sheet.getRange(2, 1, lastRow, MESSAGE_HEADERS.length).getValues();
  // Delete from bottom to top
  for (var i = values.length - 1; i >= 0; i--) {
    var obj = rowToObject_(values[i], headerMap);
    if (String(obj.account_id || '').trim() !== runtime.ACCOUNT_ID) {
      continue;
    }
    var ts = obj.last_synced_at || obj.received_at;
    var when = ts ? new Date(ts).getTime() : NaN;
    if (!isNaN(when) && when < cutoff) {
      sheet.deleteRow(i + 2);
    }
  }
}
