/**
 * MessageSync.gs — bidirectional Messages tab synchronization
 *
 * READ PATH: Original Gmail → this deployment → Messages tab → ChatGPT
 *
 * Each deployment synchronizes ONLY the Gmail account that authorized it.
 * Defaults minimize data: recent window, SNIPPET_ONLY body policy, no attachments.
 *
 * FETCH_FULL_TEXT is temporary: body_text is cleared automatically after
 * FULL_TEXT_TTL_HOURS (default 24) even if ChatGPT never sends CLEAR_FULL_TEXT.
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
  'body_text_expires_at',
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
 * Load the Messages tab once and index sync_id → values-array offset.
 * All upserts in a sync run must reuse this object instead of scanning the Sheet.
 */
function loadMessageIndex_(sheet) {
  var lastRow = sheet.getLastRow();
  var headerMap = headerIndexMap_(sheet);
  var numRows = dataRowCount_(lastRow);
  var values =
    numRows > 0 ? sheet.getRange(2, 1, numRows, MESSAGE_HEADERS.length).getValues() : [];
  var rowBySyncId = {};
  var syncCol = headerMap.sync_id;
  if (syncCol !== undefined) {
    for (var i = 0; i < values.length; i++) {
      var sid = String(values[i][syncCol] || '');
      if (sid) {
        rowBySyncId[sid] = i;
      }
    }
  }
  return {
    sheet: sheet,
    headerMap: headerMap,
    values: values,
    rowBySyncId: rowBySyncId,
    dirty: false,
    pendingAppends: []
  };
}

function flushMessageIndex_(index) {
  if (index.dirty && index.values.length > 0) {
    index.sheet
      .getRange(2, 1, index.values.length, MESSAGE_HEADERS.length)
      .setValues(index.values);
    index.dirty = false;
  }
  if (index.pendingAppends.length > 0) {
    index.sheet
      .getRange(
        index.sheet.getLastRow() + 1,
        1,
        index.pendingAppends.length,
        MESSAGE_HEADERS.length
      )
      .setValues(index.pendingAppends);
    index.pendingAppends = [];
  }
}

/**
 * Sync the configured recent Gmail window for this account.
 * @param {boolean=} optSkipLock true when the caller already holds the script lock
 */
function syncRecentMessages(optSkipLock) {
  assertDeploymentIdentityConfigured_();
  var runtime = getRuntimeConfig_();
  var query = buildLookbackQuery_(runtime.SYNC_LOOKBACK_DAYS, 'in:anywhere');
  return runMessageSync_('syncRecentMessages', query, runtime, !!optSkipLock);
}

/**
 * Prefer Inbox / unread / starred / recently modified messages.
 * @param {boolean=} optSkipLock
 */
function syncPriorityMessages(optSkipLock) {
  assertDeploymentIdentityConfigured_();
  var runtime = getRuntimeConfig_();
  var query = buildLookbackQuery_(
    runtime.SYNC_LOOKBACK_DAYS,
    'in:inbox OR is:unread OR is:starred'
  );
  return runMessageSync_('syncPriorityMessages', query, runtime, !!optSkipLock);
}

/**
 * Refresh one exact Gmail message into the Messages tab.
 * @param {string} messageId
 * @param {boolean=} optSkipLock
 */
function syncOneMessage(messageId, optSkipLock) {
  assertDeploymentIdentityConfigured_();
  var runtime = getRuntimeConfig_();
  if (!messageId) {
    throw new Error('syncOneMessage requires messageId');
  }
  var msg = GmailApp.getMessageById(messageId);
  if (!msg) {
    throw new Error('Message not found: ' + messageId);
  }
  var lock = null;
  if (!optSkipLock) {
    lock = acquireLock_(30000);
    if (!lock) {
      throw new Error('Could not acquire lock for syncOneMessage');
    }
  }
  try {
    var ss = openControlSpreadsheet_();
    var index = loadMessageIndex_(ensureMessagesSheet_(ss));
    upsertMessageRow_(msg, runtime, runtime.BODY_SYNC_POLICY, index);
    expireFullTextInIndex_(index, runtime);
    flushMessageIndex_(index);
    return 'Refreshed message ' + messageId;
  } finally {
    releaseLock_(lock);
  }
}

/**
 * Populate body_text for one exact message (ChatGPT-directed escalation).
 * Sets body_text_expires_at so cleanup is automatic.
 * @param {string} messageId
 * @param {boolean=} optSkipLock
 */
function fetchFullTextForMessage(messageId, optSkipLock) {
  assertDeploymentIdentityConfigured_();
  var runtime = getRuntimeConfig_();
  if (!messageId) {
    throw new Error('fetchFullTextForMessage requires messageId');
  }
  var msg = GmailApp.getMessageById(messageId);
  if (!msg) {
    throw new Error('Message not found: ' + messageId);
  }
  var lock = null;
  if (!optSkipLock) {
    lock = acquireLock_(30000);
    if (!lock) {
      throw new Error('Could not acquire lock for fetchFullTextForMessage');
    }
  }
  try {
    var ss = openControlSpreadsheet_();
    var index = loadMessageIndex_(ensureMessagesSheet_(ss));
    upsertMessageRow_(msg, runtime, 'FULL_TEXT', index);
    flushMessageIndex_(index);
    return (
      'Fetched full text for message ' +
      messageId +
      ' (expires ' +
      hoursFromNowIso_(runtime.FULL_TEXT_TTL_HOURS || 24) +
      ')'
    );
  } finally {
    releaseLock_(lock);
  }
}

/**
 * Remove cached body_text for one message after ChatGPT no longer needs it.
 * @param {string} messageId
 * @param {boolean=} optSkipLock
 */
function clearStoredBodyText(messageId, optSkipLock) {
  assertDeploymentIdentityConfigured_();
  var runtime = getRuntimeConfig_();
  if (!messageId) {
    throw new Error('clearStoredBodyText requires messageId');
  }
  var lock = null;
  if (!optSkipLock) {
    lock = acquireLock_(30000);
    if (!lock) {
      throw new Error('Could not acquire lock for clearStoredBodyText');
    }
  }
  try {
    var ss = openControlSpreadsheet_();
    var sheet = ensureMessagesSheet_(ss);
    var index = loadMessageIndex_(sheet);
    var syncId = makeSyncId_(runtime.ACCOUNT_ID, messageId);
    var offset = index.rowBySyncId[syncId];
    if (offset === undefined) {
      return 'No Messages row for ' + syncId + '; nothing to clear';
    }
    var headerMap = index.headerMap;
    index.values[offset][headerMap.body_text] = '';
    if (headerMap.body_text_expires_at !== undefined) {
      index.values[offset][headerMap.body_text_expires_at] = '';
    }
    index.values[offset][headerMap.last_synced_at] = nowIso_();
    index.values[offset][headerMap.sync_state] = CONFIG.SYNC_STATE.UPDATED;
    index.dirty = true;
    flushMessageIndex_(index);
    return 'Cleared body_text for ' + syncId;
  } finally {
    releaseLock_(lock);
  }
}

/**
 * Update labels/read/star/archive/trash state for this account's Messages rows
 * that still exist in Gmail. Marks missing messages as REMOVED (does not delete rows).
 * @param {boolean=} optSkipLock
 */
function reconcileMessageState(optSkipLock) {
  assertDeploymentIdentityConfigured_();
  var runtime = getRuntimeConfig_();
  var lock = null;
  if (!optSkipLock) {
    lock = acquireLock_(30000);
    if (!lock) {
      throw new Error('Could not acquire lock for reconcileMessageState');
    }
  }
  try {
    var ss = openControlSpreadsheet_();
    var sheet = ensureMessagesSheet_(ss);
    var index = loadMessageIndex_(sheet);
    if (index.values.length === 0) {
      return 'No message rows to reconcile';
    }
    var result = reconcileUnseenRows_(index, {}, runtime, runtime.MAX_RECONCILE_PER_SYNC || 200);
    expireFullTextInIndex_(index, runtime);
    flushMessageIndex_(index);
    pruneOldMessageRows_(sheet, runtime);
    return (
      'Reconciled: updated=' +
      result.updated +
      ', marked_removed=' +
      result.removed +
      ', expired_bodies=' +
      result.expiredBodies
    );
  } finally {
    releaseLock_(lock);
  }
}

/**
 * Internal sync runner used by syncRecentMessages / syncPriorityMessages
 * and the scheduled trigger. After upserting matches, reconciles existing
 * rows that fell out of the query (archived/trashed/moved) so ChatGPT does
 * not keep seeing stale Inbox state.
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
    var ss = openControlSpreadsheet_();
    var sheet = ensureMessagesSheet_(ss);
    var index = loadMessageIndex_(sheet);

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
        upsertMessageRow_(msg, runtime, runtime.BODY_SYNC_POLICY, index);
        upserts++;
      }
      if (upserts >= max) {
        break;
      }
    }

    var recon = reconcileUnseenRows_(
      index,
      seenIds,
      runtime,
      runtime.MAX_RECONCILE_PER_SYNC || 200
    );
    var expired = expireFullTextInIndex_(index, runtime);
    flushMessageIndex_(index);
    pruneOldMessageRows_(sheet, runtime);

    var summary =
      label +
      ': upserted ' +
      upserts +
      ', reconciled_updated=' +
      recon.updated +
      ', marked_removed=' +
      recon.removed +
      ', expired_bodies=' +
      expired +
      ' (query=' +
      query +
      ')';
    Logger.log(summary);
    return summary;
  } finally {
    releaseLock_(lock);
  }
}

function upsertMessageRow_(msg, runtime, bodyPolicy, index) {
  var ownsIndex = !index;
  if (!index) {
    var ss = openControlSpreadsheet_();
    index = loadMessageIndex_(ensureMessagesSheet_(ss));
  }
  var snapshot = buildMessageSnapshot_(msg, runtime, bodyPolicy);
  var offset = index.rowBySyncId[snapshot.sync_id];
  index._pendingBySyncId = index._pendingBySyncId || {};

  if (offset !== undefined) {
    var existing = rowToObject_(index.values[offset], index.headerMap);
    applyBodyRetention_(snapshot, existing, bodyPolicy, runtime);
    snapshot.sync_state = CONFIG.SYNC_STATE.UPDATED;
    index.values[offset] = objectToRow_(snapshot, MESSAGE_HEADERS);
    index.dirty = true;
  } else {
    var pendingIdx = index._pendingBySyncId[snapshot.sync_id];
    if (pendingIdx !== undefined) {
      var existingPending = rowToObject_(index.pendingAppends[pendingIdx], index.headerMap);
      applyBodyRetention_(snapshot, existingPending, bodyPolicy, runtime);
      snapshot.sync_state = CONFIG.SYNC_STATE.ACTIVE;
      index.pendingAppends[pendingIdx] = objectToRow_(snapshot, MESSAGE_HEADERS);
    } else {
      snapshot.sync_state = CONFIG.SYNC_STATE.ACTIVE;
      index._pendingBySyncId[snapshot.sync_id] = index.pendingAppends.length;
      index.pendingAppends.push(objectToRow_(snapshot, MESSAGE_HEADERS));
    }
  }

  if (ownsIndex) {
    flushMessageIndex_(index);
  }
}

/**
 * Keep FETCH_FULL_TEXT bodies only while body_text_expires_at is in the future.
 * Legacy rows with body_text but no expiry are cleared on the next sync.
 */
function applyBodyRetention_(snapshot, existing, bodyPolicy, runtime) {
  var policy = String(bodyPolicy || '').toUpperCase();
  if (policy === 'FULL_TEXT') {
    snapshot.body_text_expires_at = hoursFromNowIso_(runtime.FULL_TEXT_TTL_HOURS || 24);
    return;
  }
  if (shouldPreserveFullText_(existing.body_text, existing.body_text_expires_at)) {
    snapshot.body_text = existing.body_text;
    snapshot.body_text_expires_at = existing.body_text_expires_at;
  } else {
    snapshot.body_text = '';
    snapshot.body_text_expires_at = '';
  }
}

function shouldPreserveFullText_(body, expiresAt) {
  if (!body) {
    return false;
  }
  if (!expiresAt) {
    return false;
  }
  var when = new Date(expiresAt).getTime();
  if (isNaN(when)) {
    return false;
  }
  return when > Date.now();
}

function expireFullTextInIndex_(index, runtime) {
  var headerMap = index.headerMap;
  if (headerMap.body_text === undefined) {
    return 0;
  }
  var cleared = 0;
  for (var i = 0; i < index.values.length; i++) {
    var obj = rowToObject_(index.values[i], headerMap);
    if (String(obj.account_id || '').trim() !== runtime.ACCOUNT_ID) {
      continue;
    }
    if (!obj.body_text) {
      continue;
    }
    var expired = !shouldPreserveFullText_(obj.body_text, obj.body_text_expires_at);
    if (expired) {
      index.values[i][headerMap.body_text] = '';
      if (headerMap.body_text_expires_at !== undefined) {
        index.values[i][headerMap.body_text_expires_at] = '';
      }
      index.values[i][headerMap.last_synced_at] = nowIso_();
      index.dirty = true;
      cleared++;
    }
  }
  return cleared;
}

/**
 * Refresh this account's existing Messages rows that were not just upserted.
 * Updates archive/inbox/label/read state; marks gone mail as REMOVED.
 */
function reconcileUnseenRows_(index, seenIds, runtime, cap) {
  var headerMap = index.headerMap;
  var updated = 0;
  var removed = 0;
  var lookups = 0;
  var skipped = 0;

  for (var i = 0; i < index.values.length; i++) {
    var obj = rowToObject_(index.values[i], headerMap);
    if (String(obj.account_id || '').trim() !== runtime.ACCOUNT_ID) {
      continue;
    }
    var mid = String(obj.gmail_message_id || '').trim();
    if (!mid || seenIds[mid]) {
      continue;
    }
    if (lookups >= cap) {
      skipped++;
      continue;
    }
    lookups++;
    try {
      var msg = GmailApp.getMessageById(mid);
      if (!msg) {
        index.values[i][headerMap.sync_state] = CONFIG.SYNC_STATE.REMOVED;
        index.values[i][headerMap.last_synced_at] = nowIso_();
        index.dirty = true;
        removed++;
        continue;
      }
      var snapshot = buildMessageSnapshot_(msg, runtime, 'NONE');
      applyBodyRetention_(snapshot, obj, 'NONE', runtime);
      snapshot.sync_state = CONFIG.SYNC_STATE.UPDATED;
      index.values[i] = objectToRow_(snapshot, MESSAGE_HEADERS);
      index.dirty = true;
      updated++;
    } catch (err) {
      index.values[i][headerMap.sync_state] = CONFIG.SYNC_STATE.REMOVED;
      index.values[i][headerMap.last_synced_at] = nowIso_();
      index.dirty = true;
      removed++;
    }
  }

  return { updated: updated, removed: removed, skipped: skipped, expiredBodies: 0 };
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
    try {
      if (thread.isInInbox()) {
        labels.push('INBOX');
      } else if (thread.isInTrash()) {
        labels.push('TRASH');
      } else {
        labels.push('ARCHIVED');
      }
      if (thread.isInSpam()) {
        labels.push('SPAM');
      }
    } catch (stateErr) {
      // older runtimes / unexpected thread state — ignore
    }
  }

  var bodyText = '';
  var expiresAt = '';
  var policy = (bodyPolicy || runtime.BODY_SYNC_POLICY || 'SNIPPET_ONLY').toUpperCase();
  if (policy === 'FULL_TEXT') {
    try {
      bodyText = truncate_(msg.getPlainBody() || '', 50000);
      expiresAt = hoursFromNowIso_(runtime.FULL_TEXT_TTL_HOURS || 24);
    } catch (err) {
      bodyText = '';
      expiresAt = '';
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
    body_text_expires_at: expiresAt,
    labels: normalizeLabelList_(labels),
    is_unread: boolToSheet_(msg.isUnread()),
    is_starred: boolToSheet_(msg.isStarred()),
    has_attachments: boolToSheet_(attachmentNames.length > 0),
    attachment_names: attachmentNames.join(', '),
    last_synced_at: nowIso_(),
    sync_state: CONFIG.SYNC_STATE.ACTIVE
  };
}

/**
 * Single-row lookup. Prefer loadMessageIndex_ during bulk sync.
 * getRange(row, column, numRows, numColumns) — numRows is lastRow - 1 when
 * starting at row 2; numColumns is 1, not the column index.
 */
function findMessageRowBySyncId_(sheet, syncId) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return null;
  }
  var headerMap = headerIndexMap_(sheet);
  if (headerMap.sync_id === undefined) {
    return null;
  }
  var col = headerMap.sync_id + 1;
  var numRows = lastRow - 1;
  var values = sheet.getRange(2, col, numRows, 1).getValues();
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
  var numRows = dataRowCount_(lastRow);
  if (numRows < 1) {
    return;
  }
  var headerMap = headerIndexMap_(sheet);
  var values = sheet.getRange(2, 1, numRows, MESSAGE_HEADERS.length).getValues();
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
