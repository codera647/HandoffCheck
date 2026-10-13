/* Owner-operated pilot connector. Secrets belong in Script Properties, never in Sheets. */
var OWNER_EMAIL = 'moiz44386@gmail.com';
var BRIDGE_URL = 'https://dpwzjmqvsqifbgspoylc.supabase.co/functions/v1/workspace-bridge';
var APP_URL = 'https://handoffcheck.vercel.app';
var QUESTIONS = [
  ['title', 'Feature title', 'text'],
  ['problem', 'Problem and evidence', 'paragraph'],
  ['audience', 'Target users', 'paragraph'],
  ['behavior', 'Expected behavior', 'paragraph'],
  ['scope', 'In scope', 'paragraph'],
  ['exclusions', 'Out of scope', 'paragraph'],
  ['criteria', 'Acceptance criteria — one per line', 'paragraph'],
  ['edgeCases', 'Edge cases', 'paragraph'],
  ['dependencies', 'Dependencies and constraints', 'paragraph'],
  ['dataImpact', 'Data and permissions', 'paragraph'],
  ['successMeasure', 'Success measure', 'paragraph'],
  ['rationale', 'Priority rationale', 'paragraph'],
  ['priority', 'Priority', 'choice'],
  ['targetDate', 'Target date — YYYY-MM-DD, or leave blank', 'text'],
  ['timezone', 'Timezone — e.g. Asia/Karachi', 'text'],
  ['references', 'Supporting links — one HTTPS URL per line, optionally Label | URL', 'paragraph'],
];

function owner_() {
  if (Session.getEffectiveUser().getEmail().toLowerCase() !== OWNER_EMAIL)
    throw new Error('Run this connector as ' + OWNER_EMAIL + '.');
}
function properties_() {
  return PropertiesService.getScriptProperties();
}
function bridge_(action, data) {
  var secret = properties_().getProperty('WORKSPACE_BRIDGE_SECRET');
  if (!secret || !/^[a-f0-9]{64}$/.test(secret))
    throw new Error('Set WORKSPACE_BRIDGE_SECRET in Script Properties before setup.');
  var raw = JSON.stringify({ action: action, data: data });
  var timestamp = String(Date.now()),
    nonce = Utilities.getUuid();
  var signature = Utilities.computeHmacSha256Signature(
    timestamp + '\n' + nonce + '\n' + raw,
    secret,
    Utilities.Charset.UTF_8,
  )
    .map(function (b) {
      return ('0' + ((b + 256) % 256).toString(16)).slice(-2);
    })
    .join('');
  var response = UrlFetchApp.fetch(BRIDGE_URL, {
    method: 'post',
    contentType: 'application/json',
    payload: raw,
    muteHttpExceptions: true,
    headers: {
      'X-Handoff-Timestamp': timestamp,
      'X-Handoff-Nonce': nonce,
      'X-Handoff-Signature': signature,
    },
  });
  var result = JSON.parse(response.getContentText());
  if (response.getResponseCode() !== 200) {
    var error = new Error(
      result.error ? result.error.message : 'Workspace service is unavailable.',
    );
    error.code = result.error ? result.error.code : 'SERVICE_ERROR';
    throw error;
  }
  return result;
}
function formsApi_(formId, method, payload) {
  var response = UrlFetchApp.fetch(
    'https://forms.googleapis.com/v1/forms/' + formId + (method === 'post' ? ':batchUpdate' : ''),
    {
      method: method,
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      payload: payload ? JSON.stringify(payload) : undefined,
      muteHttpExceptions: true,
    },
  );
  if (response.getResponseCode() !== 200)
    throw new Error(
      'Google Forms API failed. Enable the Forms API in the script’s Google Cloud project and authorize the manifest scopes.',
    );
  return JSON.parse(response.getContentText());
}
function verifiedForm_(formId) {
  var form = formsApi_(formId, 'get');
  if (!form.settings || form.settings.emailCollectionType !== 'VERIFIED')
    throw new Error(
      'Intake is stopped: the Form must collect verified Google emails. Run setupWorkspace again.',
    );
}
function table_(name, headers) {
  var sheet = SpreadsheetApp.openById(properties_().getProperty('SHEET_ID'));
  var tab = sheet.getSheetByName(name) || sheet.insertSheet(name);
  if (tab.getLastRow() === 0) {
    tab.appendRow(headers);
    tab.setFrozenRows(1);
    tab.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#efefeb');
  }
  return tab;
}
function literalCell_(value) {
  // Form input must not become a spreadsheet formula.
  var text = String(value == null ? '' : value);
  return /^[=+\-@\t\r]/.test(text) ? "'" + text : text;
}
function upsert_(tab, id, values) {
  var ids =
    tab.getLastRow() > 1 ? tab.getRange(2, 1, tab.getLastRow() - 1, 1).getDisplayValues() : [];
  var index = ids.findIndex(function (row) {
    return row[0] === id;
  });
  var row = index < 0 ? tab.getLastRow() + 1 : index + 2;
  tab.getRange(row, 1, 1, values.length).setValues([values.map(literalCell_)]);
}

/** Run once after linking the Cloud project, enabling Forms/Drive APIs and setting the secret. */
function setupWorkspace() {
  owner_();
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var props = properties_();
    if (!props.getProperty('WORKSPACE_BRIDGE_SECRET'))
      throw new Error('Set WORKSPACE_BRIDGE_SECRET in Script Properties.');
    if (!props.getProperty('SHEET_ID')) {
      var sheet = SpreadsheetApp.create('HandoffCheck — Feature tracking');
      props.setProperty('SHEET_ID', sheet.getId());
    }
    if (!props.getProperty('FOLDER_ID')) {
      var folder = Drive.Files.create(
        { name: 'HandoffCheck — Approved briefs', mimeType: 'application/vnd.google-apps.folder' },
        null,
        { fields: 'id' },
      );
      props.setProperty('FOLDER_ID', folder.id);
    }
    if (!props.getProperty('FORM_ID')) {
      var form = FormApp.create('HandoffCheck — Feature request', false);
      props.setProperty('FORM_ID', form.getId());
    }
    var formId = props.getProperty('FORM_ID'),
      intake = FormApp.openById(formId);
    // Keep intake closed until verified-email settings and the signed backend binding succeed.
    if (intake.supportsAdvancedResponderPermissions()) intake.setPublished(false);
    else intake.setAcceptingResponses(false);
    intake.setDescription(
      'For invited HandoffCheck employees. Sign in to HandoffCheck first. Submissions become drafts; edit them and assign reviewers in the app.',
    );
    intake.setConfirmationMessage(
      'Your response was recorded. HandoffCheck will import it if your Google account has active workspace access. Check the app after the next sync.',
    );
    intake.setAllowResponseEdits(false);
    var mapping = props.getProperty('ITEM_MAP') ? JSON.parse(props.getProperty('ITEM_MAP')) : {};
    QUESTIONS.forEach(function (question) {
      if (mapping[question[0]]) return;
      var existing = intake.getItems().filter(function (item) {
        return item.getTitle() === question[1];
      })[0];
      // New items already have their concrete type; only getItems() returns generic Items.
      var item;
      if (question[2] === 'choice') {
        item = existing ? existing.asListItem() : intake.addListItem();
        item.setChoiceValues(['normal', 'low', 'high']);
      } else if (question[2] === 'paragraph') {
        item = existing ? existing.asParagraphTextItem() : intake.addParagraphTextItem();
      } else {
        item = existing ? existing.asTextItem() : intake.addTextItem();
      }
      item.setTitle(question[1]);
      if (question[0] === 'title') item.setRequired(true);
      mapping[question[0]] = String(item.getId());
      props.setProperty('ITEM_MAP', JSON.stringify(mapping));
    });
    formsApi_(formId, 'post', {
      requests: [
        {
          updateSettings: {
            settings: { emailCollectionType: 'VERIFIED' },
            updateMask: 'emailCollectionType',
          },
        },
      ],
    });
    verifiedForm_(formId);
    intake.setDestination(FormApp.DestinationType.SPREADSHEET, props.getProperty('SHEET_ID'));
    table_('Requests', [
      'Request ID',
      'Feature',
      'State',
      'Revision',
      'Open questions',
      'Google Docs',
      'HandoffCheck',
      'Updated',
    ]);
    table_('Imports', ['Response ID', 'State', 'Request ID', 'Details', 'Checked']);
    bridge_('configure', {
      formId: formId,
      sheetId: props.getProperty('SHEET_ID'),
      folderId: props.getProperty('FOLDER_ID'),
    });
    var triggers = ScriptApp.getProjectTriggers();
    if (
      !triggers.some(function (t) {
        return t.getHandlerFunction() === 'onFeatureSubmit';
      })
    )
      ScriptApp.newTrigger('onFeatureSubmit').forForm(intake).onFormSubmit().create();
    if (
      !triggers.some(function (t) {
        return t.getHandlerFunction() === 'syncWorkspace';
      })
    )
      ScriptApp.newTrigger('syncWorkspace').timeBased().everyMinutes(5).create();
    if (intake.supportsAdvancedResponderPermissions()) intake.setPublished(true);
    intake.setAcceptingResponses(true);
    console.log('Setup complete. Intake: ' + intake.getPublishedUrl());
    console.log(
      'Tracking: https://docs.google.com/spreadsheets/d/' + props.getProperty('SHEET_ID') + '/edit',
    );
  } finally {
    lock.releaseLock();
  }
}

function fieldsFromAnswers_(answers) {
  var fields = {};
  QUESTIONS.forEach(function (q) {
    fields[q[0]] = String(answers[q[0]] || '').trim();
  });
  fields.criteria = fields.criteria
    .split(/\r?\n/)
    .map(function (s) {
      return s.trim();
    })
    .filter(Boolean);
  fields.references = fields.references
    .split(/\r?\n/)
    .filter(function (s) {
      return s.trim();
    })
    .map(function (line) {
      var split = line.lastIndexOf('|'),
        url = (split < 0 ? line : line.slice(split + 1)).trim();
      return { label: split < 0 ? 'Supporting link' : line.slice(0, split).trim(), url: url };
    });
  fields.priority = fields.priority || 'normal';
  fields.timezone = fields.timezone || 'Asia/Karachi';
  fields.unscheduled = !fields.targetDate;
  return fields;
}
function importResponse_(response) {
  var tab = table_('Imports', ['Response ID', 'State', 'Request ID', 'Details', 'Checked']);
  var rows = tab.getLastRow() > 1 ? tab.getRange(2, 1, tab.getLastRow() - 1, 5).getValues() : [];
  var previous = rows.find(function (row) {
    return row[0] === response.getId();
  });
  if (previous && previous[1] === 'Imported') return;
  var map = JSON.parse(properties_().getProperty('ITEM_MAP')),
    answers = {},
    itemAnswers = {};
  response.getItemResponses().forEach(function (item) {
    itemAnswers[String(item.getItem().getId())] = item.getResponse();
  });
  Object.keys(map).forEach(function (key) {
    answers[key] = itemAnswers[map[key]] || '';
  });
  try {
    var result = bridge_('import', {
      formId: properties_().getProperty('FORM_ID'),
      responseId: response.getId(),
      email: response.getRespondentEmail(),
      fields: fieldsFromAnswers_(answers),
    });
    upsert_(tab, response.getId(), [
      response.getId(),
      'Imported',
      result.requestId,
      '',
      new Date().toISOString(),
    ]);
  } catch (error) {
    upsert_(tab, response.getId(), [
      response.getId(),
      'Needs attention',
      '',
      error.message,
      new Date().toISOString(),
    ]);
    // Keep the response for an explicit retry; backend failures never imply successful import.
    if (['ACCESS_DENIED', 'INVALID_INPUT', 'KEY_REUSED', 'BODY_LIMIT'].indexOf(error.code) < 0)
      throw error;
  }
}
function onFeatureSubmit(event) {
  owner_();
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    verifiedForm_(properties_().getProperty('FORM_ID'));
    importResponse_(event.response);
  } finally {
    lock.releaseLock();
  }
}
function docLine_(line) {
  var heading = /^(#{1,3}) (.*)$/.exec(line),
    bullet = /^- (.*)$/.exec(line);
  var text = heading ? heading[2] : bullet ? bullet[1] : line;
  return {
    heading: heading ? heading[1].length : 0,
    bullet: !!bullet,
    text: text.replace(/\\([\\`*_{}\[\]()#+\-.!<>|])/g, '$1'),
  };
}
function exportBrief_(brief) {
  var folder = properties_().getProperty('FOLDER_ID');
  var query =
    "trashed = false and '" +
    folder +
    "' in parents and appProperties has { key='briefId' and value='" +
    brief.id +
    "' }";
  var files =
    Drive.Files.list({ q: query, spaces: 'drive', fields: 'files(id,appProperties)', pageSize: 10 })
      .files || [];
  if (files.length > 1)
    throw new Error(
      'Multiple Google Docs match brief ' + brief.id + '. Resolve them before retrying.',
    );
  var file =
    files[0] ||
    Drive.Files.create(
      {
        name: 'HC-' + String(brief.number).padStart(4, '0') + ' — revision ' + brief.revision,
        mimeType: 'application/vnd.google-apps.document',
        parents: [folder],
        appProperties: {
          briefId: brief.id,
          contentHash: brief.contentHash,
          exportState: 'building',
        },
      },
      null,
      { fields: 'id,appProperties' },
    );
  if (file.appProperties.contentHash !== brief.contentHash)
    throw new Error('The existing Google Doc has a different approved content hash.');
  if (file.appProperties.exportState !== 'complete') {
    var document = DocumentApp.openById(file.id),
      body = document.getBody();
    body.clear();
    brief.markdown.split('\n').forEach(function (line) {
      var parsed = docLine_(line),
        paragraph = parsed.bullet
          ? body.appendListItem(parsed.text).setGlyphType(DocumentApp.GlyphType.BULLET)
          : body.appendParagraph(parsed.text);
      if (parsed.heading)
        paragraph.setHeading(
          [
            null,
            DocumentApp.ParagraphHeading.TITLE,
            DocumentApp.ParagraphHeading.HEADING1,
            DocumentApp.ParagraphHeading.HEADING2,
          ][parsed.heading],
        );
      paragraph
        .editAsText()
        .setFontFamily('Arial')
        .setFontSize(
          parsed.heading === 1 ? 20 : parsed.heading === 2 ? 15 : parsed.heading === 3 ? 12 : 11,
        );
    });
    body
      .appendParagraph('Approved artifact SHA-256: ' + brief.contentHash)
      .editAsText()
      .setFontFamily('Arial')
      .setFontSize(9);
    document.saveAndClose();
    Drive.Files.update(
      {
        appProperties: {
          briefId: brief.id,
          contentHash: brief.contentHash,
          exportState: 'complete',
        },
      },
      file.id,
    );
  }
  bridge_('document', { briefId: brief.id, documentId: file.id, contentHash: brief.contentHash });
  return file.id;
}
function syncWorkspace() {
  owner_();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) throw new Error('Another sync is running. Retry after it finishes.');
  var started = Date.now();
  try {
    var props = properties_(),
      formId = props.getProperty('FORM_ID');
    verifiedForm_(formId);
    var since = props.getProperty('RESPONSE_CURSOR');
    var intake = FormApp.openById(formId);
    var responses = since
      ? intake.getResponses(new Date(Number(since) - 1000))
      : intake.getResponses();
    responses.sort(function (a, b) {
      return a.getTimestamp() - b.getTimestamp();
    });
    for (var i = 0; i < Math.min(responses.length, 50); i++) {
      if (Date.now() - started > 240000) return;
      importResponse_(responses[i]);
      props.setProperty('RESPONSE_CURSOR', String(responses[i].getTimestamp().getTime()));
    }
    var after = 0,
      tracking = table_('Requests', [
        'Request ID',
        'Feature',
        'State',
        'Revision',
        'Open questions',
        'Google Docs',
        'HandoffCheck',
        'Updated',
      ]);
    do {
      var page = bridge_('sync', { after: after });
      for (var j = 0; j < page.briefs.length; j++) {
        if (Date.now() - started > 240000) return;
        var brief = page.briefs[j],
          id = exportBrief_(brief);
        var request = page.requests.find(function (r) {
          return r.id === brief.requestId;
        });
        if (request) request.documents.push({ revision: brief.revision, documentId: id });
      }
      page.requests.forEach(function (r) {
        upsert_(tracking, r.id, [
          r.id,
          r.title,
          r.status,
          r.currentRevision,
          r.questions.join('\n'),
          r.documents
            .map(function (d) {
              return (
                'Revision ' +
                d.revision +
                ': https://docs.google.com/document/d/' +
                d.documentId +
                '/edit'
              );
            })
            .join('\n'),
          APP_URL + '/requests/' + r.id,
          r.updatedAt,
        ]);
      });
      after = page.next;
      if (Date.now() - started > 240000) return;
    } while (after !== null);
    bridge_('complete', {});
    console.log('Workspace sync completed.');
  } finally {
    lock.releaseLock();
  }
}
/** Run after fixing an invitation or rejected response. It does not edit imported drafts. */
function retryFailedImports() {
  owner_();
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var form = FormApp.openById(properties_().getProperty('FORM_ID'));
    verifiedForm_(form.getId());
    var tab = table_('Imports', ['Response ID', 'State', 'Request ID', 'Details', 'Checked']);
    var rows = tab.getLastRow() > 1 ? tab.getRange(2, 1, tab.getLastRow() - 1, 5).getValues() : [];
    rows
      .filter(function (r) {
        return r[1] !== 'Imported';
      })
      .slice(0, 25)
      .forEach(function (r) {
        importResponse_(form.getResponse(r[0]));
      });
  } finally {
    lock.releaseLock();
  }
}
