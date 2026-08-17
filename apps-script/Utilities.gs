/**
 * Utilities.gs — IDs, timestamps, locks, helpers
 */

function generateUuid_() {
  return Utilities.getUuid();
}

function nowIso_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd'T'HH:mm:ssXXX");
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

function ensureHeaders_(sheet, headers) {
  var lastCol = sheet.getLastColumn();
  if (lastCol === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    return;
  }
  var existing = sheet.getRange(1, 1, 1, Math.max(lastCol, headers.length)).getValues()[0];
  var needsWrite = false;
  for (var i = 0; i < headers.length; i++) {
    if (String(existing[i] || '') !== headers[i]) {
      needsWrite = true;
      break;
    }
  }
  if (needsWrite) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
  }
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

function makeSyncId_(accountId, messageId) {
  return accountId + '::' + messageId;
}
