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

      // After successful mutation, lightly refresh message metadata when we have IDs
      try {
        if (!runtime.DRY_RUN && resolved.messages && resolved.messages.length === 1) {
          upsertMessageRow_(resolved.messages[0], runtime, 'NONE');
        }
      } catch (syncErr) {
        Logger.log('post-mutation sync warning: ' + syncErr);
      }
    }

    markCommandSuccess_(rowNumber, result.summary);
    return commandId + ': SUCCESS';
  } catch (err) {
    var errText = String(err);
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
 * Scheduled message synchronization entry point (default every 10–15 minutes).
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
    var priority = runMessageSync_(
      'scheduledPriority',
      buildLookbackQuery_(runtime.SYNC_LOOKBACK_DAYS, 'in:inbox OR is:unread OR is:starred'),
      runtime,
      true
    );
    return priority;
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
    setSettingValue_(settings, 'DRY_RUN', previous === '' || previous == null ? 'FALSE' : previous);
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
