/**
 * Validation.gs — account/action/input validation
 */

function isKnownAction_(action) {
  var a = String(action || '').trim().toUpperCase();
  return CONFIG.MUTATION_ACTIONS.indexOf(a) !== -1 || CONFIG.INFRA_ACTIONS.indexOf(a) !== -1;
}

function isMutationAction_(action) {
  return CONFIG.MUTATION_ACTIONS.indexOf(String(action || '').trim().toUpperCase()) !== -1;
}

function isInfraAction_(action) {
  return CONFIG.INFRA_ACTIONS.indexOf(String(action || '').trim().toUpperCase()) !== -1;
}

/**
 * Returns 'message' or 'thread'. Thread-level actions affect every message
 * in the Gmail thread even when the command names a single gmail_message_id.
 */
function actionScope_(action) {
  var a = String(action || '').trim().toUpperCase();
  return CONFIG.ACTION_SCOPE[a] || 'message';
}

function isThreadLevelAction_(action) {
  return actionScope_(action) === 'thread';
}

/**
 * Validate that the command's account_id matches this deployment and that the
 * account is listed/enabled in the Accounts registry.
 */
function validateCommandAccount_(command, runtime) {
  var cmdAccount = String(command.account_id || '').trim();
  if (!cmdAccount) {
    return { ok: false, error: 'Missing account_id on command.' };
  }
  if (cmdAccount !== runtime.ACCOUNT_ID) {
    return { ok: false, error: 'account_id does not match this deployment.', skip: true };
  }

  var registry = getAccountRegistry_();
  var entry = registry[cmdAccount];
  if (!entry) {
    return {
      ok: false,
      error: 'account_id "' + cmdAccount + '" is not registered in the Accounts tab.'
    };
  }
  if (!sheetToBool_(entry.enabled)) {
    return { ok: false, error: 'Account "' + cmdAccount + '" is disabled in Accounts.' };
  }

  var registryEmail = String(entry.email_address || '').trim().toLowerCase();
  var deployEmail = String(runtime.ACCOUNT_EMAIL || '').trim().toLowerCase();
  if (
    registryEmail &&
    deployEmail &&
    registryEmail.indexOf('type_email') === -1 &&
    registryEmail !== deployEmail
  ) {
    return {
      ok: false,
      error:
        'Accounts.email_address (' +
        registryEmail +
        ') does not match this deployment ACCOUNT_EMAIL (' +
        deployEmail +
        ').'
    };
  }

  return { ok: true, account: entry };
}

function validateAction_(command, runtime) {
  var action = String(command.action || '').trim().toUpperCase();
  if (!action) {
    return { ok: false, error: 'Missing action.' };
  }
  if (!isKnownAction_(action)) {
    return { ok: false, error: 'Unknown action: ' + action };
  }
  if (action === 'TRASH' && !runtime.TRASH_ENABLED) {
    return {
      ok: false,
      error: 'TRASH is disabled. Set TRASH_ENABLED=TRUE in Settings to allow trash actions.'
    };
  }
  if ((action === 'LABEL' || action === 'REMOVE_LABEL') && !String(command.label_name || '').trim()) {
    return { ok: false, error: action + ' requires label_name.' };
  }
  if (
    (action === 'REFRESH_MESSAGE' ||
      action === 'FETCH_FULL_TEXT' ||
      action === 'CLEAR_FULL_TEXT') &&
    !String(command.gmail_message_id || '').trim()
  ) {
    return { ok: false, error: action + ' requires gmail_message_id.' };
  }
  return { ok: true, action: action };
}

/**
 * Resolve target messages for a mutation command.
 * Prefer exact gmail_message_id; fall back to gmail_thread_id or search_query.
 * Ambiguous search results => NEEDS_REVIEW.
 */
function resolveTargetMessages_(command) {
  var messageId = String(command.gmail_message_id || '').trim();
  var threadId = String(command.gmail_thread_id || '').trim();
  var searchQuery = String(command.search_query || '').trim();

  if (messageId) {
    try {
      var msg = GmailApp.getMessageById(messageId);
      if (!msg) {
        return { ok: false, error: 'Message not found for gmail_message_id=' + messageId };
      }
      return { ok: true, messages: [msg], resolution: 'message_id' };
    } catch (err) {
      // Fall through to Advanced Gmail if available, else fail.
      try {
        if (typeof Gmail !== 'undefined' && Gmail.Users && Gmail.Users.Messages) {
          var raw = Gmail.Users.Messages.get('me', messageId, { format: 'minimal' });
          if (raw && raw.id) {
            var recovered = GmailApp.getMessageById(raw.id);
            if (recovered) {
              return { ok: true, messages: [recovered], resolution: 'message_id_advanced' };
            }
          }
        }
      } catch (advErr) {
        // ignore advanced failure; report original
      }
      return {
        ok: false,
        error: 'Unable to load gmail_message_id=' + messageId + ': ' + err
      };
    }
  }

  if (threadId) {
    try {
      var thread = GmailApp.getThreadById(threadId);
      if (!thread) {
        return { ok: false, error: 'Thread not found for gmail_thread_id=' + threadId };
      }
      return { ok: true, messages: thread.getMessages(), resolution: 'thread_id' };
    } catch (err) {
      return { ok: false, error: 'Unable to load gmail_thread_id=' + threadId + ': ' + err };
    }
  }

  if (searchQuery) {
    var threads = GmailApp.search(searchQuery, 0, 20);
    var messages = [];
    threads.forEach(function (t) {
      messages = messages.concat(t.getMessages());
    });
    if (messages.length === 0) {
      return { ok: false, error: 'search_query matched no messages: ' + searchQuery };
    }
    if (messages.length > 1) {
      return {
        ok: false,
        needsReview: true,
        error:
          'search_query matched ' +
          messages.length +
          ' messages; refusing to guess. Narrow the query or supply gmail_message_id. Query: ' +
          searchQuery,
        matchedIds: messages.map(function (m) {
          return m.getId();
        })
      };
    }
    return { ok: true, messages: messages, resolution: 'search_query' };
  }

  return {
    ok: false,
    error: 'Command requires gmail_message_id, gmail_thread_id, or search_query.'
  };
}

function getAccountRegistry_() {
  var ss = openControlSpreadsheet_();
  var sheet = ss.getSheetByName(CONFIG.TAB_ACCOUNTS);
  if (!sheet) {
    return {};
  }
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) {
    return {};
  }
  var headers = data[0];
  var idx = {};
  for (var i = 0; i < headers.length; i++) {
    idx[String(headers[i]).trim()] = i;
  }
  var registry = {};
  for (var r = 1; r < data.length; r++) {
    var row = data[r];
    var id = String(row[idx.account_id] || '').trim();
    if (!id) {
      continue;
    }
    registry[id] = {
      account_id: id,
      email_address: row[idx.email_address],
      display_name: row[idx.display_name],
      enabled: row[idx.enabled]
    };
  }
  return registry;
}
