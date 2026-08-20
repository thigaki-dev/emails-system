/**
 * Utilities.gs — IDs, timestamps, locks, helpers
 */

function generateUuid_() {
  return Utilities.getUuid();
}

function nowIso_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ssXXX");
}

function hoursFromNowIso_(hours) {
  var ms = (Number(hours) || 0) * 60 * 60 * 1000;
  var d = new Date(Date.now() + ms);
  return d.toISOString();
}

/**
 * Number of data rows below a header in row 1.
 * SpreadsheetApp.getRange(row, column, numRows, numColumns) takes a row *count*,
 * not an end index — so callers must use lastRow - 1 when starting at row 2.
 */
function dataRowCount_(lastRow) {
  return lastRow < 2 ? 0 : lastRow - 1;
}

/**
 * Acquire a document lock for command processing / sync.
 * Returns the lock if acquired, or null if unavailable.
 */
function acquireLock_(timeoutMs) {
  var lock = LockService.getScriptLock();
  var ms = timeoutMs || 30000;
  try {
    var acquired = lock.tryLock(ms);
    return acquired ? lock : null;
  } catch (err) {
    Logger.log('acquireLock_ failed: ' + err);
    return null;
  }
}

function releaseLock_(lock) {
  if (lock) {
    try {
      lock.releaseLock();
    } catch (err) {
      Logger.log('releaseLock_ warning: ' + err);
    }
  }
}

/**
 * Ensure header row matches the required schema.
 * Existing deployments: when current headers are an exact prefix of `headers`,
 * append only the missing trailing columns (preserves data column positions).
 * Otherwise rewrite the header row to the canonical schema.
 */
function ensureHeaders_(sheet, headers) {
  var lastCol = sheet.getLastColumn();
  if (lastCol === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    return;
  }
  var existing = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) {
    return String(h || '').trim();
  });
  // Drop trailing blanks from the existing header row
  while (existing.length && !existing[existing.length - 1]) {
    existing.pop();
  }

  var isPrefix = existing.length <= headers.length;
  if (isPrefix) {
    for (var i = 0; i < existing.length; i++) {
      if (existing[i] !== headers[i]) {
        isPrefix = false;
        break;
      }
    }
  }

  if (isPrefix && existing.length === headers.length) {
    sheet.setFrozenRows(1);
    return;
  }
  if (isPrefix && existing.length < headers.length) {
    var missing = headers.slice(existing.length);
    sheet.getRange(1, existing.length + 1, 1, missing.length).setValues([missing]);
    sheet.setFrozenRows(1);
    return;
  }

  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.setFrozenRows(1);
}

function headerIndexMap_(sheet) {
  var lastCol = sheet.getLastColumn();
  if (lastCol < 1) {
    return {};
  }
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var map = {};
  for (var i = 0; i < headers.length; i++) {
    var name = String(headers[i] || '').trim();
    if (name) {
      map[name] = i;
    }
  }
  return map;
}

function rowToObject_(row, headerMap) {
  var obj = {};
  Object.keys(headerMap).forEach(function (key) {
    obj[key] = row[headerMap[key]];
  });
  return obj;
}

function objectToRow_(obj, headers) {
  return headers.map(function (h) {
    return obj[h] !== undefined && obj[h] !== null ? obj[h] : '';
  });
}

function escapeSheetLiteral_(value) {
  return String(value == null ? '' : value).replace(/"/g, '""');
}

function normalizeLabelList_(labels) {
  if (!labels) {
    return '';
  }
  if (Array.isArray(labels)) {
    return labels.join(', ');
  }
  return String(labels);
}

function parseCsvList_(value) {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value;
  }
  return String(value)
    .split(',')
    .map(function (s) {
      return s.trim();
    })
    .filter(function (s) {
      return !!s;
    });
}

function boolToSheet_(value) {
  return value ? 'TRUE' : 'FALSE';
}

function sheetToBool_(value) {
  if (typeof value === 'boolean') {
    return value;
  }
  var s = String(value || '').trim().toUpperCase();
  return s === 'TRUE' || s === '1' || s === 'YES';
}

function safeString_(value) {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value);
}

function truncate_(text, maxLen) {
  var s = safeString_(text);
  if (s.length <= maxLen) {
    return s;
  }
  return s.substring(0, maxLen - 3) + '...';
}

/**
 * Build a Gmail search query for the recent sync window.
 */
function buildLookbackQuery_(lookbackDays, extra) {
  var days = lookbackDays || 30;
  var parts = ['newer_than:' + days + 'd'];
  if (extra) {
    parts.push('(' + extra + ')');
  }
  return parts.join(' ');
}

/**
 * Steady-state sync query: priority mailbox state plus messages since last
 * successful sync when available. Falls back to lookback + priority.
 */
function buildSteadyStateSyncQuery_(runtime) {
  var priority = 'in:inbox OR is:unread OR is:starred';
  var lastSync = getLastSuccessfulSyncAt_(runtime.ACCOUNT_ID);
  if (lastSync) {
    var incremental = buildIncrementalNewerThanClause_(lastSync, runtime.SYNC_LOOKBACK_DAYS);
    return '(' + incremental + ') OR (' + priority + ')';
  }
  return buildLookbackQuery_(runtime.SYNC_LOOKBACK_DAYS, priority);
}

/**
 * Convert a last-sync ISO timestamp into a Gmail newer_than clause with buffer.
 */
function buildIncrementalNewerThanClause_(lastSyncIso, lookbackDaysCap) {
  var when = new Date(lastSyncIso).getTime();
  if (isNaN(when)) {
    return 'newer_than:' + (lookbackDaysCap || 30) + 'd';
  }
  var elapsedMs = Math.max(0, Date.now() - when);
  var hours = Math.max(1, Math.ceil(elapsedMs / (60 * 60 * 1000)) + 1);
  var capDays = lookbackDaysCap || 30;
  if (hours <= 48) {
    return 'newer_than:' + hours + 'h';
  }
  var days = Math.min(capDays, Math.max(1, Math.ceil(hours / 24) + 1));
  return 'newer_than:' + days + 'd';
}

function makeSyncId_(accountId, messageId) {
  return accountId + '::' + messageId;
}

/**
 * True for temporary Gmail infrastructure / quota / rate-limit errors.
 * Conservative: only clearly transient failures — not validation or missing data.
 */
function isRetryableGmailError_(err) {
  var text = String(err && err.message ? err.message : err).toLowerCase();
  if (!text) {
    return false;
  }
  if (
    text.indexOf('service invoked too many times') !== -1 ||
    text.indexOf('service invoked too many times for one day') !== -1
  ) {
    return true;
  }
  if (text.indexOf('gmail') !== -1 && text.indexOf('quota') !== -1) {
    return true;
  }
  if (
    text.indexOf('rate limit') !== -1 ||
    text.indexOf('rateLimitExceeded'.toLowerCase()) !== -1 ||
    text.indexOf('userRateLimitExceeded'.toLowerCase()) !== -1 ||
    text.indexOf('too many requests') !== -1 ||
    text.indexOf('429') !== -1
  ) {
    return true;
  }
  if (
    text.indexOf('backend error') !== -1 ||
    text.indexOf('service unavailable') !== -1 ||
    text.indexOf('temporarily unavailable') !== -1 ||
    text.indexOf('try again later') !== -1 ||
    text.indexOf('internal error') !== -1
  ) {
    return true;
  }
  return false;
}

/**
 * Compute next_retry_at ISO string from retry_count (post-increment) and runtime backoff settings.
 * retry 1 → RETRY_BACKOFF_MINUTES_1 (default 30m)
 * retry 2 → RETRY_BACKOFF_MINUTES_2 (default 2h)
 * retry 3+ → RETRY_BACKOFF_MINUTES_3 (default 6h)
 */
function computeNextRetryAt_(retryCount, runtime) {
  var n = Number(retryCount) || 1;
  var minutes;
  if (n <= 1) {
    minutes = (runtime && runtime.RETRY_BACKOFF_MINUTES_1) || CONFIG.RETRY_BACKOFF_MINUTES_1 || 30;
  } else if (n === 2) {
    minutes = (runtime && runtime.RETRY_BACKOFF_MINUTES_2) || CONFIG.RETRY_BACKOFF_MINUTES_2 || 120;
  } else {
    minutes = (runtime && runtime.RETRY_BACKOFF_MINUTES_3) || CONFIG.RETRY_BACKOFF_MINUTES_3 || 360;
  }
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

function lastSuccessfulSyncPropKey_(accountId) {
  return 'LAST_SYNC_SUCCESS_' + String(accountId || '');
}

function reconcileCursorPropKey_(accountId) {
  return 'RECONCILE_CURSOR_' + String(accountId || '');
}

function getLastSuccessfulSyncAt_(accountId) {
  try {
    return PropertiesService.getScriptProperties().getProperty(lastSuccessfulSyncPropKey_(accountId)) || '';
  } catch (err) {
    Logger.log('getLastSuccessfulSyncAt_ warning: ' + err);
    return '';
  }
}

function setLastSuccessfulSyncAt_(accountId, iso) {
  try {
    PropertiesService.getScriptProperties().setProperty(
      lastSuccessfulSyncPropKey_(accountId),
      iso || nowIso_()
    );
  } catch (err) {
    Logger.log('setLastSuccessfulSyncAt_ warning: ' + err);
  }
}

function getReconcileCursor_(accountId) {
  try {
    var raw = PropertiesService.getScriptProperties().getProperty(reconcileCursorPropKey_(accountId));
    var n = Number(raw);
    return !isNaN(n) && n >= 0 ? Math.floor(n) : 0;
  } catch (err) {
    Logger.log('getReconcileCursor_ warning: ' + err);
    return 0;
  }
}

function setReconcileCursor_(accountId, cursor) {
  try {
    PropertiesService.getScriptProperties().setProperty(
      reconcileCursorPropKey_(accountId),
      String(Math.max(0, Math.floor(Number(cursor) || 0)))
    );
  } catch (err) {
    Logger.log('setReconcileCursor_ warning: ' + err);
  }
}
