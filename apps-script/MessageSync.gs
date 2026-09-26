/**
 * MessageSync.gs — bidirectional Messages tab synchronization
 *
 * READ PATH: Original Gmail → this deployment → Messages tab → ChatGPT
 *
 * Each deployment synchronizes ONLY the Gmail account that authorized it.
 * Defaults minimize data and Gmail quota use: modest caps, SNIPPET_ONLY body
 * policy (no full-body reads), no attachment binary downloads, no broad
 * reconciliation on every scheduled sync.
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
 * One-time / backfill sync for the configured lookback window.
 * Uses INITIAL_MAX_MESSAGES_PER_SYNC (larger than steady-state).
 * Does not run broad reconciliation — use scheduledMessageReconciliation or
 * reconcileMessageState for that.
 * @param {boolean=} optSkipLock true when the caller already holds the script lock
 */
function runInitialSync(optSkipLock) {
  assertDeploymentIdentityConfigured_();
  var runtime = getRuntimeConfig_();
  var query = buildLookbackQuery_(runtime.SYNC_LOOKBACK_DAYS, 'in:anywhere');
  var max = runtime.INITIAL_MAX_MESSAGES_PER_SYNC || runtime.MAX_MESSAGES_PER_SYNC || 200;
  return runMessageSync_('runInitialSync', query, runtime, !!optSkipLock, max, true);
}

/**
 * Sync the configured recent Gmail window for this account (manual / SYNC_NOW).
 * Uses MAX_MESSAGES_PER_SYNC. Prefer runInitialSync for first-time backfill.
 * @param {boolean=} optSkipLock true when the caller already holds the script lock
 */
function syncRecentMessages(optSkipLock) {
  assertDeploymentIdentityConfigured_();
  var runtime = getRuntimeConfig_();
  var query = buildLookbackQuery_(runtime.SYNC_LOOKBACK_DAYS, 'in:anywhere');
  return runMessageSync_(
    'syncRecentMessages',
    query,
    runtime,
    !!optSkipLock,
    runtime.MAX_MESSAGES_PER_SYNC,
    true
  );
}

/**
 * Prefer Inbox / unread / starred / recently modified messages.
 * @param {boolean=} optSkipLock
 */
function syncPriorityMessages(optSkipLock) {
  assertDeploymentIdentityConfigured_();
  var runtime = getRuntimeConfig_();
  var query = buildSteadyStateSyncQuery_(runtime);
  return runMessageSync_(
    'syncPriorityMessages',
    query,
    runtime,
    !!optSkipLock,
    runtime.MAX_MESSAGES_PER_SYNC,
    true
  );
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
 * Bounded by MAX_RECONCILE_PER_SYNC; progresses a PropertiesService cursor so
 * successive runs walk through later rows instead of always starting at row 1.
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
    var result = reconcileUnseenRows_(
      index,
      {},
      runtime,
      runtime.MAX_RECONCILE_PER_SYNC || 25,
      true
    );
    expireFullTextInIndex_(index, runtime);
    flushMessageIndex_(index);
    pruneOldMessageRows_(sheet, runtime);
    return (
      'Reconciled: updated=' +
      result.updated +
      ', marked_removed=' +
      result.removed +
      ', expired_bodies=' +
      result.expiredBodies +
      ', cursor=' +
      result.nextCursor +
      (result.quotaAborted ? ' (stopped early: Gmail quota)' : '')
    );
  } finally {
    releaseLock_(lock);
  }
}

/**
 * Internal sync runner used by syncRecentMessages / syncPriorityMessages /
 * scheduledMessageSync / runInitialSync.
 *
 * Intentionally does NOT call reconcileUnseenRows_. Broad reconciliation is
 * reserved for scheduledMessageReconciliation / reconcileMessageState so
 * normal sync stays cheap and bounded.
 *
 * @param {string} label
 * @param {string} query
 * @param {Object} runtime
 * @param {boolean} skipLock
 * @param {number=} maxOverride
 * @param {boolean=} recordSuccess whether to update last-successful-sync timestamp
 */
function runMessageSync_(label, query, runtime, skipLock, maxOverride, recordSuccess) {
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

    var max = maxOverride != null ? maxOverride : runtime.MAX_MESSAGES_PER_SYNC || 75;
    var upserts = 0;
    var quotaAborted = false;

    try {
      var threads = GmailApp.search(query, 0, Math.min(max, 500));
      var seenIds = {};

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
    } catch (syncErr) {
      if (isRetryableGmailError_(syncErr)) {
        quotaAborted = true;
        Logger.log(
          label +
            ': Gmail quota/rate-limit during sync — terminating cleanly without marking rows REMOVED. ' +
            syncErr
        );
        // Flush any partial upserts already prepared; do not reconcile or advance last-sync.
        expireFullTextInIndex_(index, runtime);
        flushMessageIndex_(index);
        return (
          label +
          ': aborted on Gmail quota after upserted=' +
          upserts +
          ' (query=' +
          query +
          ') — last successful sync timestamp preserved'
        );
      }
      throw syncErr;
    }

    var expired = expireFullTextInIndex_(index, runtime);
    flushMessageIndex_(index);
    pruneOldMessageRows_(sheet, runtime);

    if (recordSuccess !== false && !quotaAborted) {
      setLastSuccessfulSyncAt_(runtime.ACCOUNT_ID, nowIso_());
    }

    var summary =
      label +
      ': upserted ' +
      upserts +
      ', expired_bodies=' +
      expired +
      ' (query=' +
      query +
      ', max=' +
      max +
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
 *
 * When useCursor is true (scheduled / manual reconcile), starts at the persisted
 * cursor and advances it so successive runs cover later rows, wrapping around.
 * Quota errors abort without marking remaining rows REMOVED.
 *
 * @param {Object} index
 * @param {Object} seenIds message ids to skip
 * @param {Object} runtime
 * @param {number} cap max Gmail lookups this run
 * @param {boolean=} useCursor progress PropertiesService cursor
 */
function reconcileUnseenRows_(index, seenIds, runtime, cap, useCursor) {
  var headerMap = index.headerMap;
  var updated = 0;
  var removed = 0;
  var lookups = 0;
  var skipped = 0;
  var quotaAborted = false;

  var accountOffsets = [];
  for (var scan = 0; scan < index.values.length; scan++) {
    var scanObj = rowToObject_(index.values[scan], headerMap);
    if (String(scanObj.account_id || '').trim() !== runtime.ACCOUNT_ID) {
      continue;
    }
    var mid0 = String(scanObj.gmail_message_id || '').trim();
    if (!mid0 || (seenIds && seenIds[mid0])) {
      continue;
    }
    accountOffsets.push(scan);
  }

  var startPos = 0;
  if (useCursor && accountOffsets.length > 0) {
    var stored = getReconcileCursor_(runtime.ACCOUNT_ID);
    startPos = stored % accountOffsets.length;
  }

  var visited = 0;
  while (visited < accountOffsets.length) {
    if (lookups >= cap) {
      skipped += accountOffsets.length - visited;
      break;
    }
    var pos = (startPos + visited) % accountOffsets.length;
    var i = accountOffsets[pos];
    visited++;

    var obj = rowToObject_(index.values[i], headerMap);
    var mid = String(obj.gmail_message_id || '').trim();
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
      if (isRetryableGmailError_(err)) {
        quotaAborted = true;
        Logger.log(
          'reconcileUnseenRows_: Gmail quota/rate-limit — stopping without marking remaining rows REMOVED. ' +
            err
        );
        // Do not advance past the current position so this row is retried later.
        visited--;
        break;
      }
      // Non-retryable load failure (e.g. truly gone) → REMOVED
      index.values[i][headerMap.sync_state] = CONFIG.SYNC_STATE.REMOVED;
      index.values[i][headerMap.last_synced_at] = nowIso_();
      index.dirty = true;
      removed++;
    }
  }

  var nextCursor = 0;
  if (accountOffsets.length > 0) {
    if (quotaAborted) {
      nextCursor = (startPos + Math.max(0, visited)) % accountOffsets.length;
    } else if (lookups >= cap && visited < accountOffsets.length) {
      nextCursor = (startPos + visited) % accountOffsets.length;
    } else {
      // Completed a full pass (or emptied the set) — wrap to start
      nextCursor = 0;
    }
    if (useCursor) {
      setReconcileCursor_(runtime.ACCOUNT_ID, nextCursor);
    }
  } else if (useCursor) {
    setReconcileCursor_(runtime.ACCOUNT_ID, 0);
  }

  return {
    updated: updated,
    removed: removed,
    skipped: skipped,
    expiredBodies: 0,
    nextCursor: nextCursor,
    quotaAborted: quotaAborted,
    lookups: lookups
  };
}

/**
 * Build a Messages-tab snapshot without unnecessary GmailApp body/attachment reads.
 *
 * SNIPPET_ONLY / NONE: prefer Advanced Gmail metadata for snippet + attachment
 * flags (no getPlainBody / getAttachments). FULL_TEXT still uses getPlainBody.
 * Attachment filenames are filled from Advanced Gmail part metadata when cheap;
 * otherwise has_attachments may be set without names.
 */
function buildMessageSnapshot_(msg, runtime, bodyPolicy) {
  var thread = msg.getThread();
  var policy = (bodyPolicy || runtime.BODY_SYNC_POLICY || 'SNIPPET_ONLY').toUpperCase();
  var messageId = msg.getId();

  var meta = fetchGmailMessageMetadata_(messageId);
  var attachmentInfo = attachmentInfoFromMetadata_(meta);
  if (!attachmentInfo.resolved) {
    // Do not call msg.getAttachments() during normal sync — expensive GmailApp quota.
    // Preserve empty names; has_attachments stays FALSE unless metadata said otherwise.
    attachmentInfo = { has_attachments: false, attachment_names: '', resolved: false };
  }

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
    snippet = snippetFromMetadataOrSubject_(meta, msg);
  }

  return {
    sync_id: makeSyncId_(runtime.ACCOUNT_ID, messageId),
    account_id: runtime.ACCOUNT_ID,
    account_email: runtime.ACCOUNT_EMAIL,
    gmail_message_id: messageId,
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
    has_attachments: boolToSheet_(!!attachmentInfo.has_attachments),
    attachment_names: attachmentInfo.attachment_names || '',
    last_synced_at: nowIso_(),
    sync_state: CONFIG.SYNC_STATE.ACTIVE
  };
}

/**
 * Advanced Gmail metadata fetch (snippet + payload filenames, no body data).
 * Returns null when the Advanced service is unavailable or the call fails.
 */
function fetchGmailMessageMetadata_(messageId) {
  try {
    if (typeof Gmail !== 'undefined' && Gmail.Users && Gmail.Users.Messages) {
      return Gmail.Users.Messages.get('me', messageId, {
        format: 'metadata',
        metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Date']
      });
    }
  } catch (err) {
    if (isRetryableGmailError_(err)) {
      throw err;
    }
    Logger.log('fetchGmailMessageMetadata_ fallback: ' + err);
  }
  return null;
}

function snippetFromMetadataOrSubject_(meta, msg) {
  if (meta && meta.snippet) {
    return truncate_(String(meta.snippet), 500);
  }
  // Avoid getPlainBody() — subject-only fallback preserves quota.
  try {
    return truncate_(msg.getSubject() || '', 200);
  } catch (err) {
    return '';
  }
}

/**
 * Walk Advanced Gmail payload parts for filenames without downloading bytes.
 */
function attachmentInfoFromMetadata_(meta) {
  if (!meta || !meta.payload) {
    return { has_attachments: false, attachment_names: '', resolved: false };
  }
  var names = [];
  collectAttachmentFilenames_(meta.payload, names);
  return {
    has_attachments: names.length > 0,
    attachment_names: names.join(', '),
    resolved: true
  };
}

function collectAttachmentFilenames_(part, out) {
  if (!part) {
    return;
  }
  var filename = part.filename ? String(part.filename).trim() : '';
  if (filename) {
    out.push(filename);
  }
  var parts = part.parts || [];
  for (var i = 0; i < parts.length; i++) {
    collectAttachmentFilenames_(parts[i], out);
  }
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
