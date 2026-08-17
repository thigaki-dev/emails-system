/**
 * GmailExecutor.gs — deterministic Gmail operations
 *
 * Executes only against the Gmail account that authorized this Apps Script
 * deployment. Never infers or accesses another account.
 *
 * Action scope contract (see CONFIG.ACTION_SCOPE):
 *   message-level: MARK_READ, MARK_UNREAD, STAR, UNSTAR, TRASH
 *   thread-level:  LABEL, REMOVE_LABEL, ARCHIVE, MOVE_TO_INBOX
 *
 * Thread-level actions use GmailApp thread APIs. Naming a single gmail_message_id
 * still changes every message in that thread (Gmail's native label/archive model).
 * Message-level Advanced Gmail label mutation is not used here; the contract is
 * explicit rather than pretending LABEL/ARCHIVE are per-message.
 */

/**
 * Execute a validated mutation command against resolved messages.
 * Thread-level actions are de-duplicated by thread id so a thread is mutated once.
 */
function executeMutation_(action, messages, command, runtime) {
  var labelName = String(command.label_name || '').trim();
  var results = [];
  var dryRun = !!runtime.DRY_RUN;
  var scope = actionScope_(action);
  var targets = scope === 'thread' ? uniqueThreadsFromMessages_(messages) : messages;

  for (var i = 0; i < targets.length; i++) {
    var msg = targets[i];
    var messageId = msg.getId();
    var thread = msg.getThread();
    var threadId = thread ? thread.getId() : '';
    var threadSize = thread && thread.getMessageCount ? thread.getMessageCount() : 1;

    var detail = performSingleAction_(action, msg, thread, labelName, runtime, dryRun, scope, threadSize);
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
      scope: scope,
      outcome: dryRun ? 'DRY_RUN' : 'APPLIED',
      detail: detail,
      error: ''
    });
  }

  return {
    ok: true,
    dryRun: dryRun,
    scope: scope,
    summary: (dryRun ? '[DRY_RUN] ' : '') + '[' + scope + '-level] ' + results.join('; ')
  };
}

function uniqueThreadsFromMessages_(messages) {
  var seen = {};
  var unique = [];
  for (var i = 0; i < messages.length; i++) {
    var msg = messages[i];
    var thread = msg.getThread();
    var key = thread ? thread.getId() : 'msg:' + msg.getId();
    if (seen[key]) {
      continue;
    }
    seen[key] = true;
    unique.push(msg);
  }
  return unique;
}

function performSingleAction_(action, msg, thread, labelName, runtime, dryRun, scope, threadSize) {
  var messageId = msg.getId();
  var threadId = thread ? thread.getId() : '';
  var n = threadSize || 1;
  var threadNote = 'thread ' + threadId + ' (' + n + ' message' + (n === 1 ? '' : 's') + ')';

  switch (action) {
    case 'LABEL':
      return applyLabel_(msg, thread, labelName, runtime, dryRun, threadNote);
    case 'REMOVE_LABEL':
      return removeLabel_(msg, thread, labelName, dryRun, threadNote);
    case 'ARCHIVE':
      if (dryRun) {
        return 'Would archive ' + threadNote + ' — thread-level; all messages leave Inbox';
      }
      if (thread) {
        thread.moveToArchive();
      }
      return 'Archived ' + threadNote + ' — thread-level; Inbox removed for the whole thread';
    case 'MOVE_TO_INBOX':
      if (dryRun) {
        return 'Would move ' + threadNote + ' to Inbox — thread-level';
      }
      if (thread) {
        thread.moveToInbox();
      }
      return 'Moved ' + threadNote + ' to Inbox — thread-level';
    case 'MARK_READ':
      if (dryRun) {
        return 'Would mark message ' + messageId + ' as read — message-level';
      }
      msg.markRead();
      return 'Marked read: ' + messageId + ' — message-level';
    case 'MARK_UNREAD':
      if (dryRun) {
        return 'Would mark message ' + messageId + ' as unread — message-level';
      }
      msg.markUnread();
      return 'Marked unread: ' + messageId + ' — message-level';
    case 'STAR':
      if (dryRun) {
        return 'Would star message ' + messageId + ' — message-level';
      }
      msg.star();
      return 'Starred: ' + messageId + ' — message-level';
    case 'UNSTAR':
      if (dryRun) {
        return 'Would unstar message ' + messageId + ' — message-level';
      }
      msg.unstar();
      return 'Unstarred: ' + messageId + ' — message-level';
    case 'TRASH':
      if (!runtime.TRASH_ENABLED) {
        throw new Error('TRASH is disabled by Settings (TRASH_ENABLED=FALSE).');
      }
      if (dryRun) {
        return 'Would trash message ' + messageId + ' — message-level (other messages in the thread are unchanged)';
      }
      msg.moveToTrash();
      return 'Trashed message ' + messageId + ' — message-level (recoverable in Trash; permanent delete out of scope)';
    default:
      throw new Error('Unsupported mutation action: ' + action);
  }
}

function applyLabel_(msg, thread, labelName, runtime, dryRun, threadNote) {
  var label = getOrCreateLabel_(labelName, runtime);
  if (dryRun) {
    return 'Would apply label "' + labelName + '" to ' + threadNote + ' — thread-level';
  }
  if (thread) {
    thread.addLabel(label);
  } else {
    throw new Error('Unable to apply label without thread for message ' + msg.getId());
  }
  return 'Applied label "' + labelName + '" to ' + threadNote + ' — thread-level';
}

function removeLabel_(msg, thread, labelName, dryRun, threadNote) {
  var label = GmailApp.getUserLabelByName(labelName);
  if (!label) {
    return 'Label "' + labelName + '" does not exist; nothing to remove on ' + (threadNote || msg.getId());
  }
  if (dryRun) {
    return 'Would remove label "' + labelName + '" from ' + threadNote + ' — thread-level';
  }
  if (thread) {
    thread.removeLabel(label);
  }
  return 'Removed label "' + labelName + '" from ' + threadNote + ' — thread-level';
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
 * Called from processPendingCommands while the script lock is already held.
 */
function executeInfraCommand_(action, command, runtime) {
  var messageId = String(command.gmail_message_id || '').trim();
  var detail = '';

  switch (action) {
    case 'SYNC_NOW':
      detail = syncRecentMessages(true);
      break;
    case 'REFRESH_MESSAGE':
      detail = syncOneMessage(messageId, true);
      break;
    case 'FETCH_FULL_TEXT':
      detail = fetchFullTextForMessage(messageId, true);
      break;
    case 'CLEAR_FULL_TEXT':
      detail = clearStoredBodyText(messageId, true);
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
    scope: 'infra',
    outcome: 'APPLIED',
    detail: detail,
    error: ''
  });

  return { ok: true, summary: detail };
}
