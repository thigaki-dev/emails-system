/**
 * AuditLog.gs — immutable action logging
 *
 * Every attempted mutation (and infra command outcome) writes one Audit_Log row.
 * Rows are append-only; this module never updates or deletes prior audit entries.
 */

var AUDIT_HEADERS = [
  'audit_id',
  'timestamp',
  'account_id',
  'account_email',
  'command_id',
  'action',
  'gmail_message_id',
  'gmail_thread_id',
  'label_name',
  'dry_run',
  'outcome',
  'detail',
  'error'
];

function ensureAuditSheet_(ss) {
  var sheet = ss.getSheetByName(CONFIG.TAB_AUDIT);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.TAB_AUDIT);
  }
  ensureHeaders_(sheet, AUDIT_HEADERS);
  return sheet;
}

/**
 * Append an immutable audit record.
 */
function writeAuditLog_(entry) {
  var ss = openControlSpreadsheet_();
  var sheet = ensureAuditSheet_(ss);
  var row = {
    audit_id: entry.audit_id || generateUuid_(),
    timestamp: entry.timestamp || nowIso_(),
    account_id: entry.account_id || '',
    account_email: entry.account_email || '',
    command_id: entry.command_id || '',
    action: entry.action || '',
    gmail_message_id: entry.gmail_message_id || '',
    gmail_thread_id: entry.gmail_thread_id || '',
    label_name: entry.label_name || '',
    dry_run: boolToSheet_(!!entry.dry_run),
    outcome: entry.outcome || '',
    detail: truncate_(entry.detail || '', 2000),
    error: truncate_(entry.error || '', 2000)
  };
  sheet.appendRow(objectToRow_(row, AUDIT_HEADERS));
  return row.audit_id;
}
