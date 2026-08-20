/**
 * CommandQueue.gs — read / claim / update command rows
 */

var COMMAND_HEADERS = [
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

function ensureCommandsSheet_(ss) {
  var sheet = ss.getSheetByName(CONFIG.TAB_COMMANDS);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.TAB_COMMANDS);
  }
  ensureHeaders_(sheet, COMMAND_HEADERS);
  return sheet;
}

/** Stale PROCESSING rows older than this may be reclaimed after a crash (error recovery). */
var STALE_PROCESSING_MS = 15 * 60 * 1000;

/**
 * Claim up to maxCount PENDING or eligible RETRY_LATER commands for this account_id.
 * Uses status transition → PROCESSING for idempotency.
 * SUCCESS / FAILED / NEEDS_REVIEW are never re-executed.
 * RETRY_LATER is reclaimed only when next_retry_at <= now.
 * Stale PROCESSING rows (crash recovery) may be reclaimed once.
 */
function claimPendingCommands_(accountId, maxCount) {
  var ss = openControlSpreadsheet_();
  var sheet = ensureCommandsSheet_(ss);
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    return [];
  }

  var headerMap = headerIndexMap_(sheet);
  var numRows = dataRowCount_(lastRow);
  var colCount = Math.max(COMMAND_HEADERS.length, sheet.getLastColumn());
  var range = sheet.getRange(2, 1, numRows, colCount);
  var values = range.getValues();
  var claimed = [];
  var now = new Date().getTime();

  for (var i = 0; i < values.length && claimed.length < maxCount; i++) {
    var obj = rowToObject_(values[i], headerMap);
    var status = String(obj.status || '').trim().toUpperCase();
    var rowAccount = String(obj.account_id || '').trim();

    if (rowAccount !== accountId) {
      continue;
    }

    var eligible = status === CONFIG.STATUS.PENDING;
    if (!eligible && status === CONFIG.STATUS.RETRY_LATER) {
      var nextRetryRaw = obj.next_retry_at;
      var nextRetry = nextRetryRaw ? new Date(nextRetryRaw).getTime() : 0;
      if (!nextRetryRaw || isNaN(nextRetry) || nextRetry <= now) {
        eligible = true;
      }
    }
    if (!eligible && status === CONFIG.STATUS.PROCESSING) {
      var processedAt = obj.processed_at ? new Date(obj.processed_at).getTime() : NaN;
      if (!isNaN(processedAt) && now - processedAt > STALE_PROCESSING_MS) {
        eligible = true; // crash recovery
      }
    }
    if (!eligible) {
      continue;
    }

    // Idempotency: never re-claim SUCCESS (or other terminal states)
    values[i][headerMap.status] = CONFIG.STATUS.PROCESSING;
    values[i][headerMap.processed_at] = nowIso_();
    claimed.push({
      rowNumber: i + 2,
      data: rowToObject_(values[i], headerMap)
    });
  }

  if (claimed.length > 0) {
    // Write back only claimed rows to minimize contention
    claimed.forEach(function (item) {
      var rowValues = objectToRow_(item.data, COMMAND_HEADERS);
      sheet.getRange(item.rowNumber, 1, 1, COMMAND_HEADERS.length).setValues([rowValues]);
    });
  }

  return claimed;
}

function updateCommandRow_(rowNumber, updates) {
  var ss = openControlSpreadsheet_();
  var sheet = ensureCommandsSheet_(ss);
  var headerMap = headerIndexMap_(sheet);
  var row = sheet.getRange(rowNumber, 1, 1, COMMAND_HEADERS.length).getValues()[0];
  Object.keys(updates).forEach(function (key) {
    if (headerMap[key] !== undefined) {
      row[headerMap[key]] = updates[key];
    }
  });
  sheet.getRange(rowNumber, 1, 1, COMMAND_HEADERS.length).setValues([row]);
}

function markCommandSuccess_(rowNumber, resultText) {
  updateCommandRow_(rowNumber, {
    status: CONFIG.STATUS.SUCCESS,
    processed_at: nowIso_(),
    result: truncate_(resultText || 'OK', 2000),
    error: '',
    next_retry_at: ''
  });
}

function markCommandFailed_(rowNumber, errorText) {
  updateCommandRow_(rowNumber, {
    status: CONFIG.STATUS.FAILED,
    processed_at: nowIso_(),
    result: '',
    error: truncate_(errorText || 'Unknown error', 2000),
    next_retry_at: ''
  });
}

function markCommandNeedsReview_(rowNumber, detail) {
  updateCommandRow_(rowNumber, {
    status: CONFIG.STATUS.NEEDS_REVIEW,
    processed_at: nowIso_(),
    result: '',
    error: truncate_(detail || 'Needs review', 2000),
    next_retry_at: ''
  });
}

/**
 * Mark a command RETRY_LATER after a transient Gmail quota/rate-limit error.
 * Preserves error text and schedules next_retry_at via backoff.
 */
function markCommandRetryLater_(rowNumber, errorText, previousRetryCount, runtime) {
  var nextCount = (Number(previousRetryCount) || 0) + 1;
  var nextAt = computeNextRetryAt_(nextCount, runtime);
  updateCommandRow_(rowNumber, {
    status: CONFIG.STATUS.RETRY_LATER,
    processed_at: nowIso_(),
    result: '',
    error: truncate_(errorText || 'Retry later', 2000),
    retry_count: nextCount,
    next_retry_at: nextAt
  });
  return { retry_count: nextCount, next_retry_at: nextAt };
}

/**
 * Append a sample/demo command row (used by dry-run harness and samples).
 */
function appendCommand_(command) {
  var ss = openControlSpreadsheet_();
  var sheet = ensureCommandsSheet_(ss);
  var row = {
    command_id: command.command_id || generateUuid_(),
    created_at: command.created_at || nowIso_(),
    account_id: command.account_id || '',
    action: command.action || '',
    gmail_message_id: command.gmail_message_id || '',
    gmail_thread_id: command.gmail_thread_id || '',
    search_query: command.search_query || '',
    label_name: command.label_name || '',
    status: command.status || CONFIG.STATUS.PENDING,
    requested_by: command.requested_by || 'ChatGPT',
    processed_at: command.processed_at || '',
    result: command.result || '',
    error: command.error || '',
    retry_count: command.retry_count != null ? command.retry_count : 0,
    next_retry_at: command.next_retry_at || ''
  };
  sheet.appendRow(objectToRow_(row, COMMAND_HEADERS));
  return row.command_id;
}
