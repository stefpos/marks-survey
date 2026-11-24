/**
 * DGN survey endpoint
 *
 * Receives responses from the Mark Survey page and stores them in Drive:
 *   - the full response (answers + stroke data) as a JSON file in the
 *     "json" folder that sits next to this spreadsheet
 *   - one summary row per response in the first sheet of this spreadsheet
 *
 * Paste into Extensions › Apps Script in the "DGN survey responses" Sheet.
 * After any change, redeploy: Deploy › Manage deployments › edit (pencil)
 * › Version: New version › Deploy. The web app URL stays the same.
 */

const JSON_FOLDER_NAME = 'json';
const EXPECTED_FORMAT = 'mark-survey/3'; // six drawings: two each of line, short, dot
const MAX_BYTES = 5 * 1024 * 1024; // reject anything over 5MB

const HEADERS = [
  'receivedAt', 'responseId', 'openedAt', 'submittedAt', 'secondsOnPage',
  'consent', 'q1 name', 'q2 email', 'q3 DGN project title or affiliation',
  'q4 good digital society', 'q5.1 advice is for', 'q5.2 advice',
  'line strokes', 'line-2 strokes', 'short strokes', 'short-2 strokes',
  'dot strokes', 'dot-2 strokes', 'strokesPastEdge',
  'pointCount', 'inputTypes', 'jsonFile'
];

// ---- Web app entry points ----

// Visiting the URL in a browser shows this, so you can check it's live.
function doGet() {
  return ContentService.createTextOutput('DGN survey endpoint is running.');
}

function doPost(e) {
  try {
    const body = e && e.postData && e.postData.contents;
    if (!body) return reply({ ok: false, error: 'Empty request' });
    if (body.length > MAX_BYTES) return reply({ ok: false, error: 'Response too large' });

    let data;
    try { data = JSON.parse(body); }
    catch (err) { return reply({ ok: false, error: 'Not valid JSON' }); }

    const problem = checkResponse(data);
    if (problem) return reply({ ok: false, error: problem });

    // One response at a time, so rows and files never collide
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      const result = store(data, body);
      return reply({ ok: true, file: result.fileName, duplicate: result.duplicate });
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return reply({ ok: false, error: String(err && err.message || err) });
  }
}

// ---- Checks ----

function checkResponse(d) {
  if (!d || typeof d !== 'object') return 'Not a response';
  if (d.format !== EXPECTED_FORMAT) return 'Unknown format';
  if (typeof d.responseId !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(d.responseId)) return 'Bad response ID';
  if (!d.session || !d.answers || !Array.isArray(d.drawings)) return 'Missing sections';
  if (d.answers.consent !== 'yes') return 'Consent not given';
  for (const name of DRAWING_NAMES) {
    const dr = drawingFor(d, name);
    if (!dr || !Array.isArray(dr.strokes) || !dr.strokes.length) return 'Missing ' + name + ' drawing';
  }
  return null;
}

const DRAWING_NAMES = ['line', 'line-2', 'short', 'short-2', 'dot', 'dot-2'];

function drawingFor(d, name) {
  return d.drawings.filter(dr => dr && dr.template === name)[0];
}

// ---- Storage ----

function store(d, body) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const folder = jsonFolder(ss);
  const fileName = fileNameFor(d);

  // A resend of the same response (e.g. after a dropped connection) is
  // accepted but not stored twice
  if (folder.getFilesByName(fileName).hasNext()) {
    return { fileName: fileName, duplicate: true };
  }

  const file = folder.createFile(fileName, body, MimeType.PLAIN_TEXT);

  const sheet = ss.getSheets()[0];
  writeHeaders(sheet);

  const strokes = [].concat.apply([], d.drawings.map(dr => Array.isArray(dr.strokes) ? dr.strokes : []));
  const pastEdge = d.drawings.reduce((n, dr) => n + (Number(dr.strokesPastEdge) || 0), 0);
  const points = strokes.reduce((n, s) => n + (Array.isArray(s.points) ? s.points.length : 0), 0);
  const types = Array.from(new Set(strokes.map(s => s.pointerType))).join(' ');
  const opened = Date.parse(d.session.openedAt);
  const submitted = Date.parse(d.session.submittedAt);
  const secondsOnPage = isFinite(opened) && isFinite(submitted) ? Math.round((submitted - opened) / 1000) : '';
  const a = d.answers || {};

  sheet.appendRow([
    new Date(),
    d.responseId,
    safe(d.session.openedAt),
    safe(d.session.submittedAt),
    secondsOnPage,
    safe(a.consent), safe(a.q1), safe(a.q2), safe(a.q3), safe(a.q4), safe(a.q5a), safe(a.q5b),
  ].concat(DRAWING_NAMES.map(name => drawingFor(d, name).strokes.length), [
    pastEdge, points, safe(types),
    file.getUrl()
  ]));

  return { fileName: fileName, duplicate: false };
}

// Writes the header row on an empty sheet, and rewrites it if the
// columns have changed since it was last written
function writeHeaders(sheet) {
  const range = sheet.getRange(1, 1, 1, HEADERS.length);
  const current = sheet.getLastRow() === 0 ? [] : range.getValues()[0];
  if (current.join('|') === HEADERS.join('|')) return;
  if (sheet.getLastRow() === 0) sheet.appendRow(HEADERS);
  else range.setValues([HEADERS]);
  sheet.setFrozenRows(1);
  range.setFontWeight('bold');
}

function jsonFolder(ss) {
  const parents = DriveApp.getFileById(ss.getId()).getParents();
  if (!parents.hasNext()) throw new Error('Spreadsheet is not inside a folder');
  const parent = parents.next();
  const found = parent.getFoldersByName(JSON_FOLDER_NAME);
  if (!found.hasNext()) throw new Error('No "' + JSON_FOLDER_NAME + '" folder next to the spreadsheet');
  return found.next();
}

// Same naming as the survey's own downloads, e.g.
// response_2026-11-16T11-30-05_e8d37eee.json
function fileNameFor(d) {
  const t = new Date(d.session.submittedAt);
  const stamp = isNaN(t) ? 'unknown-time'
    : Utilities.formatDate(t, 'Europe/London', "yyyy-MM-dd'T'HH-mm-ss");
  return 'response_' + stamp + '_' + d.responseId.slice(0, 8) + '.json';
}

// Text typed by participants goes into cells as plain text, never as a formula
function safe(v) {
  if (v == null) return '';
  const s = String(v).slice(0, 5000);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---- Run this once from the editor to grant permissions and check setup ----

function testSetup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const folder = jsonFolder(ss);
  Logger.log('Spreadsheet: ' + ss.getName());
  Logger.log('JSON folder found: ' + folder.getName() + ' (inside ' +
    DriveApp.getFileById(ss.getId()).getParents().next().getName() + ')');
  Logger.log('All set. Now deploy as a web app.');
}