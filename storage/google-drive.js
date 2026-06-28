// Google-Drive-Storage-Anbindung ueber die Drive API v3.
// Erfuellt das gemeinsame Storage-Interface uploadDocument({category, filename, bytes, year})
// und liefert zusaetzlich searchDocuments({q, kategorie, jahr}) fuer die Suchseite.
//
// Auth: Google OAuth2 "Refresh Token Flow". Der Refresh-Token wird einmalig per
// Google-Cloud-OAuth-Client + Consent erzeugt und als Cloudflare-Secret
// GOOGLE_REFRESH_TOKEN hinterlegt (siehe README.md). Der Worker tauscht ihn bei
// jedem Request gegen ein kurzlebiges Access-Token - kein Caching zwischen
// Requests (Workers sind stateless).

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_BASE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';
// Nicht "Belege" nennen: kollidiert mit der gleichnamigen Kategorie "Belege/Sonstiges"
// (Pfad waere sonst Belege/Belege/Sonstiges/...).
const ROOT_FOLDER = 'Beleg-Scanner'; // Oberster Ordner in Google Drive, unter dem alle Kategorien liegen

async function getAccessToken(env) {
  const body = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    refresh_token: env.GOOGLE_REFRESH_TOKEN,
    grant_type: 'refresh_token',
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Google-Token-Refresh fehlgeschlagen (${res.status}): ${detail}`);
  }
  const data = await res.json();
  return data.access_token;
}

function escapeForQuery(name) {
  return name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function findChild(accessToken, name, parentId, mimeTypeFilter) {
  const q = [
    `name='${escapeForQuery(name)}'`,
    `'${parentId}' in parents`,
    'trashed=false',
    mimeTypeFilter,
  ].join(' and ');
  const url = `${DRIVE_BASE}/files?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=1`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Google-Drive-Suche fehlgeschlagen (${res.status}) fuer ${name}: ${detail}`);
  }
  const data = await res.json();
  return data.files?.[0]?.id ?? null;
}

async function ensureFolder(accessToken, name, parentId) {
  const existing = await findChild(accessToken, name, parentId, "mimeType='application/vnd.google-apps.folder'");
  if (existing) return existing;

  const res = await fetch(`${DRIVE_BASE}/files?fields=id`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Google-Drive-Ordner-Erstellung fehlgeschlagen (${res.status}) fuer ${name}: ${detail}`);
  }
  const data = await res.json();
  return data.id;
}

async function startResumableSession(accessToken, { filename, parentId, existingFileId, totalBytes, mimeType }) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json; charset=UTF-8',
    'X-Upload-Content-Type': mimeType,
    'X-Upload-Content-Length': String(totalBytes),
  };

  const url = existingFileId
    ? `${DRIVE_UPLOAD_BASE}/files/${existingFileId}?uploadType=resumable&fields=id,webViewLink`
    : `${DRIVE_UPLOAD_BASE}/files?uploadType=resumable&fields=id,webViewLink`;
  const body = existingFileId ? JSON.stringify({}) : JSON.stringify({ name: filename, parents: [parentId] });

  const res = await fetch(url, { method: existingFileId ? 'PATCH' : 'POST', headers, body });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Google-Drive-Upload-Session fehlgeschlagen (${res.status}) fuer ${filename}: ${detail}`);
  }
  const sessionUrl = res.headers.get('Location');
  if (!sessionUrl) throw new Error(`Google-Drive-Upload-Session ohne Location-Header fuer ${filename}`);
  return sessionUrl;
}

async function putContent(sessionUrl, bytes, mimeType) {
  const res = await fetch(sessionUrl, {
    method: 'PUT',
    headers: { 'Content-Type': mimeType, 'Content-Length': String(bytes.length) },
    body: bytes,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Google-Drive-Upload fehlgeschlagen (${res.status}): ${detail}`);
  }
  return res.json();
}

/**
 * Laedt ein Dokument in den passenden Kategorie-/Jahres-Ordner in Google Drive hoch.
 * @param {object} env - Worker-Environment (Secrets GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN).
 * @param {{category: string, filename: string, bytes: Uint8Array, year: string|number}} doc
 * @returns {Promise<{path: string, webUrl: string}>}
 */
async function uploadDocument(env, { category, filename, bytes, year }) {
  const accessToken = await getAccessToken(env);
  let folderId = await ensureFolder(accessToken, ROOT_FOLDER, 'root');
  // Kategorien wie "Rechnungen/Hardware-Rechner" sind verschachtelte Pfade -
  // anders als OneDrive legt Drive Zwischenordner nicht automatisch an.
  for (const segment of category.split('/')) {
    folderId = await ensureFolder(accessToken, segment, folderId);
  }
  folderId = await ensureFolder(accessToken, String(year), folderId); // Jahres-Ebene, innerster Ordner
  const categoryId = folderId;
  const existingFileId = await findChild(accessToken, filename, categoryId, "mimeType!='application/vnd.google-apps.folder'");

  const mimeType = 'application/pdf';
  const sessionUrl = await startResumableSession(accessToken, {
    filename,
    parentId: categoryId,
    existingFileId,
    totalBytes: bytes.length,
    mimeType,
  });
  const result = await putContent(sessionUrl, bytes, mimeType);

  return { path: `${ROOT_FOLDER}/${category}/${year}/${filename}`, webUrl: result.webViewLink };
}

// Loest einen Ordnerpfad ab ROOT_FOLDER zu einer Ordner-ID auf, OHNE etwas anzulegen.
// Gibt null zurueck, falls ein Segment nicht existiert (= keine Treffer, kein Fehler).
async function findFolderByPath(accessToken, segments) {
  let parentId = await findChild(accessToken, ROOT_FOLDER, 'root', "mimeType='application/vnd.google-apps.folder'");
  if (!parentId) return null;
  for (const segment of segments) {
    parentId = await findChild(accessToken, segment, parentId, "mimeType='application/vnd.google-apps.folder'");
    if (!parentId) return null;
  }
  return parentId;
}

async function queryDrive(accessToken, q, pageSize = 100) {
  // Drive verbietet orderBy bei fullText-Queries (Ergebnisse sind dann immer nach Relevanz sortiert).
  const orderBy = q.includes('fullText') ? '' : '&orderBy=createdTime desc';
  const url = `${DRIVE_BASE}/files?q=${encodeURIComponent(q)}&fields=files(id,name,createdTime,webViewLink,parents)&pageSize=${pageSize}${orderBy}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Google-Drive-Suche fehlgeschlagen (${res.status}): ${detail}`);
  }
  const data = await res.json();
  return data.files ?? [];
}

// Sucht innerhalb von scopeQ (Ordner-/Trash-/Mimetype-Bedingungen ohne Textfilter) nach q.
// Kombiniert zwei Strategien, weil Drive's eigene Operatoren keine echte Teilstring-Suche
// im Dateinamen bieten: "name contains 'x'" matched nur GANZE Tokens (z.B. findet "wiese"
// nicht "Wiesemann"). Deshalb zusaetzlich client-seitig per String.includes() auf den
// Dateinamen aller Kandidaten im Scope filtern und mit den Drive-fullText-Treffern
// (deckt den erkannten Dokument-Inhalt ab) ueber die Datei-ID zusammenfuehren.
async function searchWithinScope(accessToken, scopeQ, q) {
  if (!q) return queryDrive(accessToken, scopeQ);

  const escaped = escapeForQuery(q);
  const [fullTextHits, allInScope] = await Promise.all([
    queryDrive(accessToken, `${scopeQ} and fullText contains '${escaped}'`),
    queryDrive(accessToken, scopeQ, 200),
  ]);
  const needle = q.toLowerCase();
  const nameHits = allInScope.filter((f) => f.name.toLowerCase().includes(needle));

  const byId = new Map();
  for (const f of [...fullTextHits, ...nameHits]) byId.set(f.id, f);
  return Array.from(byId.values());
}

async function getFolderName(accessToken, folderId) {
  const res = await fetch(`${DRIVE_BASE}/files/${folderId}?fields=name,parents`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  return res.json();
}

// Rekonstruiert den vollen Kategorie-Pfad (z.B. "Belege/Sonstiges") oberhalb des
// Jahres-Ordners, indem von dort bis ROOT_FOLDER nach oben gelaufen wird. Wichtig:
// nur der Blattname wuerde "Sonstiges" und "Belege/Sonstiges" verwechseln.
// getFolder: memoisierter Lookup (folderId -> {name, parents}), damit derselbe
// Eltern-Ordner nicht pro Datei erneut abgefragt wird.
async function resolveCategoryPath(getFolder, yearFolder) {
  const segments = [];
  let current = yearFolder;
  while (current?.parents?.[0]) {
    const parent = await getFolder(current.parents[0]);
    if (!parent || parent.name === ROOT_FOLDER) break;
    segments.unshift(parent.name);
    current = parent;
  }
  return segments.join('/');
}

// Sucht PDFs in einer Menge bekannter Blatt-Ordner (die direkt PDFs enthalten) und haengt
// pro Treffer Jahr/Kategorie aus dem Ziel-Ordner an. Eine OR-Query ueber alle Ordner-IDs
// statt Aufloesen pro Datei -> wenige Subrequests, unabhaengig von der Dateimenge.
async function searchInFolders(accessToken, targetFolders, q) {
  if (targetFolders.length === 0) return [];
  const metaByParent = new Map(targetFolders.map((f) => [f.id, f]));
  const ors = targetFolders.map((f) => `'${f.id}' in parents`).join(' or ');
  const scopeQ = `(${ors}) and trashed=false and mimeType='application/pdf'`;
  const files = await searchWithinScope(accessToken, scopeQ, q);
  return files.map((f) => {
    const meta = metaByParent.get(f.parents?.[0]) || {};
    return toResult(f, meta.jahr || '', meta.kategorie || '');
  });
}

// Nur-Jahr-Filter: alle Ordner namens <jahr> (einer je Kategorie) in EINER Abfrage holen und
// je Ordner den vollen Kategorie-Pfad rekonstruieren (memoisiert, gebunden durch #Kategorien).
async function yearFolderTargets(accessToken, jahr) {
  const folderQ = `name='${escapeForQuery(String(jahr))}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const yearFolders = await queryDrive(accessToken, folderQ);
  const folderCache = new Map();
  const getFolder = async (id) => {
    if (folderCache.has(id)) return folderCache.get(id);
    const folder = await getFolderName(accessToken, id);
    folderCache.set(id, folder);
    return folder;
  };
  const targets = [];
  for (const yf of yearFolders) {
    const kategorie = await resolveCategoryPath(getFolder, yf);
    targets.push({ id: yf.id, jahr: String(jahr), kategorie });
  }
  return targets;
}

// Nur-Kategorie-Filter: Kategorie-Ordner einmal aufloesen, dann dessen Jahres-Unterordner listen.
async function categoryFolderTargets(accessToken, kategorie) {
  const catId = await findFolderByPath(accessToken, kategorie.split('/'));
  if (!catId) return [];
  const folderQ = `'${catId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const yearFolders = await queryDrive(accessToken, folderQ);
  return yearFolders.map((yf) => ({ id: yf.id, jahr: yf.name, kategorie }));
}

function toResult(file, year, kategorie) {
  return { name: file.name, webUrl: file.webViewLink, createdTime: file.createdTime, jahr: year, kategorie: kategorie || '' };
}

/**
 * Sucht Dokumente, die dieser Worker selbst angelegt hat (drive.file-Scope beschraenkt
 * die Sichtbarkeit der API automatisch auf die eigenen Dateien - kein Sicherheitsrisiko
 * durch breite Queries).
 * @param {object} env
 * @param {{q?: string, kategorie?: string, jahr?: string}} params
 * @returns {Promise<Array<{name: string, webUrl: string, createdTime: string, jahr: string}>>}
 */
async function searchDocuments(env, { q, kategorie, jahr }) {
  const accessToken = await getAccessToken(env);

  // Kategorie + Jahr beide gesetzt -> kollabiert auf genau einen Ordner, exakt aufloesbar.
  if (kategorie && jahr) {
    const segments = [...kategorie.split('/'), String(jahr)];
    const folderId = await findFolderByPath(accessToken, segments);
    if (!folderId) return [];
    const scopeQ = `'${folderId}' in parents and trashed=false and mimeType='application/pdf'`;
    const files = await searchWithinScope(accessToken, scopeQ, q);
    return files.map((f) => toResult(f, String(jahr), kategorie));
  }

  // Einzelfilter -> Ziel-Ordner top-down aufloesen (wenige Abfragen, unabhaengig von der
  // Dateimenge) und PDFs direkt darin suchen. Vermeidet die fruehere Subrequest-Explosion.
  if (jahr) return searchInFolders(accessToken, await yearFolderTargets(accessToken, jahr), q);
  if (kategorie) return searchInFolders(accessToken, await categoryFolderTargets(accessToken, kategorie), q);

  // Kein Filter -> breite Query (drive.file-Scope beschraenkt automatisch auf eigene Dateien).
  const broadScopeQ = `trashed=false and mimeType='application/pdf'`;
  const candidates = await searchWithinScope(accessToken, broadScopeQ, q);
  return candidates.map((f) => toResult(f, '', ''));
}

export { uploadDocument, searchDocuments };
