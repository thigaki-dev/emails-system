/**
 * Main.gs — scheduled command processor and dry-run harness
 *
 * Design: ChatGPT decides; the shared Sheet communicates; Apps Script executes;
 * each original Gmail account remains authoritative.
 *
 * This deployment processes ONLY Commands rows whose account_id matches ACCOUNT_ID.
 * It never accesses another Gmail account.
 */

/**
 * Time-driven entry point (default every 5 minutes).
 */
function processPendingCommands() {
  assertDeploymentIdentityConfigured_();
  var runtime = getRuntimeConfig_();
  var lock = acquireLock_(30000);
  if (!lock) {
    Logger.log('processPendingCommands: could not acquire lock; will retry next run.');
    return 'skipped: lock';
  }

  try {
    var claimed = claimPendingCommands_(runtime.ACCOUNT_ID, runtime.MAX_COMMANDS_PER_RUN);
    if (!claimed.length) {
      return 'No pending commands for ' + runtime.ACCOUNT_ID;
    }

    var summaries = [];
    for (var i = 0; i < claimed.length; i++) {
      var item = claimed[i];
      var outcome = processOneCommand_(item, runtime);
      summaries.push(outcome);
    }
    return summaries.join(' | ');
  } finally {
    releaseLock_(lock);
  }
}

/**
 * Process a single claimed command. Failures are isolated — one bad command
 * does not block the rest of this run, and other accounts have their own deployments.
 * Transient Gmail quota/rate-limit errors become RETRY_LATER (not FAILED) with backoff.
 */
function processOneCommand_(item, runtime) {
  var command = item.data;
  var rowNumber = item.rowNumber;
  var commandId = command.command_id;

  try {
    var accountCheck = validateCommandAccount_(command, runtime);
    if (!accountCheck.ok) {
      if (accountCheck.skip) {
        // Should not happen for claimed rows, but be safe: revert to PENDING for the correct account
        markCommandFailed_(rowNumber, accountCheck.error);
        return commandId + ': skipped/failed account mismatch';
      }
      markCommandFailed_(rowNumber, accountCheck.error);
      writeAuditLog_({
        account_id: runtime.ACCOUNT_ID,
        account_email: runtime.ACCOUNT_EMAIL,
        command_id: commandId,
        action: command.action,
        gmail_message_id: command.gmail_message_id,
        outcome: 'FAILED',
        error: accountCheck.error,
        dry_run: runtime.DRY_RUN
      });
      return commandId + ': FAILED account validation';
    }

    var actionCheck = validateAction_(command, runtime);
    if (!actionCheck.ok) {
      markCommandFailed_(rowNumber, actionCheck.error);
      writeAuditLog_({
        account_id: runtime.ACCOUNT_ID,
        account_email: runtime.ACCOUNT_EMAIL,
        command_id: commandId,
        action: command.action,
        gmail_message_id: command.gmail_message_id,
        label_name: command.label_name,
        outcome: 'FAILED',
        error: actionCheck.error,
        dry_run: runtime.DRY_RUN
      });
      return commandId + ': FAILED action validation';
    }

    var action = actionCheck.action;
    var result;

    if (isInfraAction_(action)) {
      result = executeInfraCommand_(action, command, runtime);
    } else {
      var resolved = resolveTargetMessages_(command);
      if (!resolved.ok) {
        if (resolved.needsReview) {
          markCommandNeedsReview_(rowNumber, resolved.error);
          writeAuditLog_({
            account_id: runtime.ACCOUNT_ID,
            account_email: runtime.ACCOUNT_EMAIL,
            command_id: commandId,
            action: action,
            gmail_message_id: command.gmail_message_id,
            outcome: 'NEEDS_REVIEW',
            error: resolved.error,
            dry_run: runtime.DRY_RUN
          });
          return commandId + ': NEEDS_REVIEW';
        }
        if (isRetryableGmailError_(resolved.error)) {
          return deferCommandForRetry_(rowNumber, command, runtime, resolved.error);
        }
        markCommandFailed_(rowNumber, resolved.error);
        writeAuditLog_({
          account_id: runtime.ACCOUNT_ID,
          account_email: runtime.ACCOUNT_EMAIL,
          command_id: commandId,
          action: action,
          gmail_message_id: command.gmail_message_id,
          outcome: 'FAILED',
          error: resolved.error,
          dry_run: runtime.DRY_RUN
        });
        return commandId + ': FAILED resolve';
      }

      result = executeMutation_(action, resolved.messages, command, runtime);

      // Targeted post-mutation refresh only — never mailbox-wide reconciliation here.
      try {
        if (!runtime.DRY_RUN && resolved.messages && resolved.messages.length) {
          var ssPost = openControlSpreadsheet_();
          var postIndex = loadMessageIndex_(ensureMessagesSheet_(ssPost));
          var toRefresh = resolved.messages;
          if (isThreadLevelAction_(action)) {
            var th = resolved.messages[0].getThread();
            if (th) {
              toRefresh = th.getMessages();
            }
          }
          for (var r = 0; r < toRefresh.length; r++) {
            upsertMessageRow_(toRefresh[r], runtime, 'NONE', postIndex);
          }
          flushMessageIndex_(postIndex);
        }
      } catch (syncErr) {
        if (isRetryableGmailError_(syncErr)) {
          Logger.log('post-mutation sync quota warning (command already applied): ' + syncErr);
        } else {
          Logger.log('post-mutation sync warning: ' + syncErr);
        }
      }
    }

    markCommandSuccess_(rowNumber, result.summary);
    return commandId + ': SUCCESS';
  } catch (err) {
    var errText = String(err);
    if (isRetryableGmailError_(err)) {
      return deferCommandForRetry_(rowNumber, command, runtime, errText);
    }
    markCommandFailed_(rowNumber, errText);
    writeAuditLog_({
      account_id: runtime.ACCOUNT_ID,
      account_email: runtime.ACCOUNT_EMAIL,
      command_id: commandId,
      action: command.action,
      gmail_message_id: command.gmail_message_id,
      label_name: command.label_name,
      outcome: 'FAILED',
      error: errText,
      dry_run: runtime.DRY_RUN
    });
    return commandId + ': FAILED ' + errText;
  }
}

/**
 * Mark RETRY_LATER with backoff and write Audit_Log. Does not hammer Gmail every 5 minutes.
 */
function deferCommandForRetry_(rowNumber, command, runtime, errText) {
  var prev = Number(command.retry_count) || 0;
  var defer = markCommandRetryLater_(rowNumber, errText, prev, runtime);
  writeAuditLog_({
    account_id: runtime.ACCOUNT_ID,
    account_email: runtime.ACCOUNT_EMAIL,
    command_id: command.command_id,
    action: command.action,
    gmail_message_id: command.gmail_message_id,
    label_name: command.label_name,
    outcome: 'RETRY_LATER',
    error: errText,
    detail: 'retry_count=' + defer.retry_count + '; next_retry_at=' + defer.next_retry_at,
    dry_run: runtime.DRY_RUN
  });
  return command.command_id + ': RETRY_LATER (retry_count=' + defer.retry_count + ')';
}

/**
 * Scheduled steady-state message synchronization (default every 30 minutes).
 * Bounded priority/incremental upsert only — no broad reconciliation.
 */
function scheduledMessageSync() {
  assertDeploymentIdentityConfigured_();
  var runtime = getRuntimeConfig_();
  var lock = acquireLock_(30000);
  if (!lock) {
    Logger.log('scheduledMessageSync: lock unavailable');
    return 'skipped: lock';
  }
  try {
    var query = buildSteadyStateSyncQuery_(runtime);
    return runMessageSync_(
      'scheduledPriority',
      query,
      runtime,
      true,
      runtime.MAX_MESSAGES_PER_SYNC,
      true
    );
  } finally {
    releaseLock_(lock);
  }
}

/**
 * Low-frequency background reconciliation (default every 6 hours).
 * Detects messages archived/trashed/moved directly in Gmail.
 * Bounded by MAX_RECONCILE_PER_SYNC with a progressing cursor.
 */
function scheduledMessageReconciliation() {
  assertDeploymentIdentityConfigured_();
  var runtime = getRuntimeConfig_();
  var lock = acquireLock_(30000);
  if (!lock) {
    Logger.log('scheduledMessageReconciliation: lock unavailable');
    return 'skipped: lock';
  }
  try {
    return reconcileMessageState(true);
  } finally {
    releaseLock_(lock);
  }
}

/**
 * Dry-run test harness.
 * Forces DRY_RUN behavior for this invocation, seeds a harmless command if needed,
 * and processes pending commands without modifying Gmail.
 *
 * Run manually from the Apps Script editor after setupSystem().
 */
function runDryRunTest() {
  assertDeploymentIdentityConfigured_();

  // Temporarily flip Settings DRY_RUN to TRUE for the test, then restore.
  var ss = openControlSpreadsheet_();
  var settings = ensureSettingsSheet_(ss);
  var previous = getSettingValue_(settings, 'DRY_RUN');
  setSettingValue_(settings, 'DRY_RUN', 'TRUE');

  try {
    // Ensure at least one pending infra command exists for this account
    appendCommand_({
      account_id: ACCOUNT_ID,
      action: 'SYNC_NOW',
      requested_by: 'dry-run-harness'
    });

    // Also enqueue a mutation that will NEEDS_REVIEW or no-op safely via impossible subject
    appendCommand_({
      account_id: ACCOUNT_ID,
      action: 'LABEL',
      label_name: 'Research/DryRun',
      search_query: 'subject:[DRY_RUN_NO_MATCH_' + generateUuid_() + ']',
      requested_by: 'dry-run-harness'
    });

    var result = processPendingCommands();
    Logger.log('runDryRunTest result: ' + result);
    return result;
  } finally {
    setSettingValue_(settings, 'DRY_RUN', previous === '' || previous == null ? 'TRUE' : previous);
  }
}

function getSettingValue_(sheet, key) {
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === key) {
      return data[i][1];
    }
  }
  return '';
}

function setSettingValue_(sheet, key, value) {
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === key) {
      sheet.getRange(i + 1, 2).setValue(value);
      return;
    }
  }
  sheet.appendRow([key, value, '']);
}

/**
 * Manual helper: process commands once (same as trigger).
 */
function runCommandProcessorOnce() {
  return processPendingCommands();
}

/**
 * Manual helper: sync priority messages once.
 */
function runMessageSyncOnce() {
  return syncPriorityMessages();
}
