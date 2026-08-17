/**
 * GmailExecutor.gs — deterministic Gmail operations
 *
 * Executes only against the Gmail account that authorized this Apps Script
 * deployment. Never infers or accesses another account.
 */

/**
 * Execute a validated mutation command against resolved messages.
 */
function executeMutation_(action, messages, command, runtime) {
  var labelName = String(command.label_name || '').trim();
  var results = [];
  var dryRun = !!runtime.DRY_RUN;

  for (var i = 0; i < messages.length; i++) {
    var msg = messages[i];
    var messageId = msg.getId();
    var thread = msg.getThread();
    var threadId = thread ? thread.getId() : '';

    var detail = performSingleAction_(action, msg, thread, labelName, runtime, dryRun);
    results.push(detail);

    writeAuditLog_({
      account_id: runtime.ACCOUNT_ID,
      account_email: runtime.ACCOUNT_EMAIL,
      command_id: command.command_id,
      action: action,
      gmail_message_id: messageId,
      gmail_thread_id: threadId,
      label_name: labelName,
      dry_run: dryRun,
      outcome: dryRun ? 'DRY_RUN' : 'APPLIED',
      detail: detail,
      error: ''
    });
  }

  return {
    ok: true,
    dryRun: dryRun,
    summary: (dryRun ? '[DRY_RUN] ' : '') + results.join('; ')
  };
}

function performSingleAction_(action, msg, thread, labelName, runtime, dryRun) {
  var messageId = msg.getId();

  switch (action) {
    case 'LABEL':
      return applyLabel_(msg, thread, labelName, runtime, dryRun);
    case 'REMOVE_LABEL':
      return removeLabel_(msg, thread, labelName, dryRun);
    case 'ARCHIVE':
      if (dryRun) {
        return 'Would archive message ' + messageId + ' (remove Inbox)';
      }
      if (thread) {
        thread.moveToArchive();
      }
      return 'Archived message ' + messageId;
    case 'MOVE_TO_INBOX':
      if (dryRun) {
        return 'Would move message ' + messageId + ' to Inbox';
      }
      if (thread) {
        thread.moveToInbox();
      }
      return 'Moved message ' + messageId + ' to Inbox';
    case 'MARK_READ':
      if (dryRun) {
        return 'Would mark message ' + messageId + ' as read';
      }
      msg.markRead();
      return 'Marked read: ' + messageId;
    case 'MARK_UNREAD':
      if (dryRun) {
        return 'Would mark message ' + messageId + ' as unread';
      }
      msg.markUnread();
      return 'Marked unread: ' + messageId;
    case 'STAR':
      if (dryRun) {
        return 'Would star message ' + messageId;
      }
      msg.star();
      return 'Starred: ' + messageId;
    case 'UNSTAR':
      if (dryRun) {
        return 'Would unstar message ' + messageId;
      }
      msg.unstar();
      return 'Unstarred: ' + messageId;
    case 'TRASH':
      if (!runtime.TRASH_ENABLED) {
        throw new Error('TRASH is disabled by Settings (TRASH_ENABLED=FALSE).');
      }
      if (dryRun) {
        return 'Would trash message ' + messageId;
      }
      msg.moveToTrash();
      return 'Trashed message ' + messageId + ' (recoverable in Trash; permanent delete out of scope)';
    default:
      throw new Error('Unsupported mutation action: ' + action);
  }
}

function applyLabel_(msg, thread, labelName, runtime, dryRun) {
  var label = getOrCreateLabel_(labelName, runtime);
  if (dryRun) {
    return 'Would apply label "' + labelName + '" to message ' + msg.getId();
  }
  if (thread) {
    thread.addLabel(label);
  } else {
    // Message-level fallback is not directly supported by GmailApp for user labels
    // without a thread; use thread path above.
    throw new Error('Unable to apply label without thread for message ' + msg.getId());
  }
  return 'Applied label "' + labelName + '" to message ' + msg.getId();
}

function removeLabel_(msg, thread, labelName, dryRun) {
  var label = GmailApp.getUserLabelByName(labelName);
  if (!label) {
    return 'Label "' + labelName + '" does not exist; nothing to remove on ' + msg.getId();
  }
  if (dryRun) {
    return 'Would remove label "' + labelName + '" from message ' + msg.getId();
  }
  if (thread) {
    thread.removeLabel(label);
  }
  return 'Removed label "' + labelName + '" from message ' + msg.getId();
}

function getOrCreateLabel_(labelName, runtime) {
  var existing = GmailApp.getUserLabelByName(labelName);
  if (existing) {
    return existing;
  }
  if (!runtime.AUTO_CREATE_LABELS) {
    throw new Error(
      'Label "' + labelName + '" does not exist and AUTO_CREATE_LABELS is FALSE.'
    );
  }
  // Nested labels like Research/ASBH are supported by GmailApp.createLabel
  return GmailApp.createLabel(labelName);
}

/**
 * Execute infrastructure (sync) commands.
 */
function executeInfraCommand_(action, command, runtime) {
  var messageId = String(command.gmail_message_id || '').trim();
  var detail = '';

  switch (action) {
    case 'SYNC_NOW':
      detail = syncRecentMessages();
      break;
    case 'REFRESH_MESSAGE':
      detail = syncOneMessage(messageId);
      break;
    case 'FETCH_FULL_TEXT':
      detail = fetchFullTextForMessage(messageId);
      break;
    case 'CLEAR_FULL_TEXT':
      detail = clearStoredBodyText(messageId);
      break;
    default:
      throw new Error('Unsupported infra action: ' + action);
  }

  writeAuditLog_({
    account_id: runtime.ACCOUNT_ID,
    account_email: runtime.ACCOUNT_EMAIL,
    command_id: command.command_id,
    action: action,
    gmail_message_id: messageId,
    gmail_thread_id: command.gmail_thread_id || '',
    label_name: '',
    dry_run: !!runtime.DRY_RUN,
    outcome: 'APPLIED',
    detail: detail,
    error: ''
  });

  return { ok: true, summary: detail };
}
