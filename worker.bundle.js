// ===========================================================================
// DEPLOY-FERTIGE EINZELDATEI fuer Cloudflare Workers (Dashboard Quick-Edit).
// Enthaelt zusammengefuehrt: categories.js + pdf.js + storage/google-drive.js +
// worker.js. Die einzelnen Quelldateien im Repo sind die "Wahrheit" fuer
// Weiterentwicklung - diese Datei wird daraus von Hand zusammengefuehrt und
// 1:1 in den Cloudflare-Worker-Editor eingefuegt (kein Build-Schritt, kein
// Node noetig).
//
// Benoetigte Secrets (Cloudflare Dashboard -> Settings -> Variables and Secrets):
//   GEMINI_API_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
//
// SEARCH_PASSWORD/UPLOAD_PASSWORD gibt es hier NICHT mehr als eigene Secrets -
// die Pruefung von GET /search und POST / ist an die zentrale ToolsUebersicht-
// Landingpage delegiert (Worker "landingpage", Secrets PW_BELEGSCANNER_SUCHE /
// PW_BELEGSCANNER_UPLOAD dort, siehe E:\ToolsUebersicht\admin-worker.js).
// ===========================================================================

// --- categories.js ---------------------------------------------------------

const CATEGORIES = [
  'Rechnungen/Hardware-Rechner',
  'Rechnungen/Software-Lizenzen',
  'Rechnungen/Telekommunikation',
  'Rechnungen/Versicherungen',
  'Rechnungen/Energie',
  'Rechnungen/KFZ',
  'Rechnungen/Gesundheit',
  'Belege/Sonstiges',
  'Notar',
  'Vertraege',
  'Steuern-Finanzamt',
  'Sonstiges',
];

const FALLBACK_CATEGORY = 'Sonstiges';

function isValidCategory(category) {
  return CATEGORIES.includes(category);
}

// --- pdf.js ------------------------------------------------------------------

const MAX_PAGE_WIDTH_PT = 1000;
const FONT_SIZE_PT = 9;
const LINE_HEIGHT_PT = 11;
const CHARS_PER_LINE = 100;

function readJpegInfo(bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error('Kein gueltiges JPEG (fehlender SOI-Marker)');
  }
  let offset = 2;
  let orientation = 1;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) { offset++; continue; }
    const marker = bytes[offset + 1];
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      const height = (bytes[offset + 5] << 8) | bytes[offset + 6];
      const width = (bytes[offset + 7] << 8) | bytes[offset + 8];
      const numComponents = bytes[offset + 9];
      return { width, height, numComponents, orientation };
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const segmentLength = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (marker === 0xe1) {
      const found = readExifOrientation(bytes, offset + 4);
      if (found) orientation = found;
    }
    offset += 2 + segmentLength;
  }
  throw new Error('JPEG-Abmessungen konnten nicht ermittelt werden (kein SOF-Marker gefunden)');
}

// Handy-Fotos (v.a. Hochformat) speichern oft unrotierte Pixel + EXIF-Orientation-Tag.
// /DCTDecode in PDF ignoriert diesen Tag, daher muss buildSearchablePdf ihn selbst anwenden.
function readExifOrientation(bytes, payloadStart) {
  if (
    bytes[payloadStart] !== 0x45 || bytes[payloadStart + 1] !== 0x78 ||
    bytes[payloadStart + 2] !== 0x69 || bytes[payloadStart + 3] !== 0x66
  ) {
    return null;
  }
  const tiffStart = payloadStart + 6;
  const littleEndian = bytes[tiffStart] === 0x49;
  const readU16 = (p) => (littleEndian ? bytes[p] | (bytes[p + 1] << 8) : (bytes[p] << 8) | bytes[p + 1]);
  const readU32 = (p) =>
    (littleEndian
      ? bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16) | (bytes[p + 3] << 24)
      : (bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]) >>> 0;
  const ifd0Start = tiffStart + readU32(tiffStart + 4);
  const numEntries = readU16(ifd0Start);
  for (let i = 0; i < numEntries; i++) {
    const entryOffset = ifd0Start + 2 + i * 12;
    if (readU16(entryOffset) === 0x0112) {
      return readU16(entryOffset + 8);
    }
  }
  return null;
}

function getOrientationMatrix(orientation, w, h) {
  switch (orientation) {
    case 2: return [-w, 0, 0, h, w, 0];
    case 3: return [-w, 0, 0, -h, w, h];
    case 4: return [w, 0, 0, -h, 0, h];
    case 5: return [0, -w, -h, 0, h, w];
    case 6: return [0, -w, h, 0, 0, w];
    case 7: return [0, w, h, 0, 0, 0];
    case 8: return [0, w, -h, 0, h, 0];
    default: return [w, 0, 0, h, 0, 0];
  }
}

const WIN_ANSI_EXTRA = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85,
  0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a,
  0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92,
  0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
  0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c,
  0x017e: 0x9e, 0x0178: 0x9f,
};

function escapePdfText(str) {
  let out = '';
  for (const ch of String(str ?? '')) {
    let code = ch.codePointAt(0);
    if (code in WIN_ANSI_EXTRA) code = WIN_ANSI_EXTRA[code];
    else if (code > 0xff) code = 0x3f;
    if (code === 0x28 || code === 0x29 || code === 0x5c) {
      out += '\\' + String.fromCharCode(code);
    } else if (code < 0x20) {
      out += ' ';
    } else {
      out += String.fromCharCode(code);
    }
  }
  return out;
}

function wrapText(text, charsPerLine) {
  const words = String(text ?? '').replace(/\s+/g, ' ').trim().split(' ');
  const lines = [];
  let current = '';
  for (const word of words) {
    if ((current + ' ' + word).trim().length > charsPerLine) {
      if (current) lines.push(current.trim());
      current = word;
    } else {
      current = (current + ' ' + word).trim();
    }
  }
  if (current) lines.push(current.trim());
  return lines;
}

function concatBytes(parts) {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

function strToBytes(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

function buildSearchablePdf(images, fullText) {
  const imageList = Array.isArray(images) ? images : [images];
  if (imageList.length === 0) {
    throw new Error('buildSearchablePdf benoetigt mindestens ein Bild');
  }
  const numPages = imageList.length;

  const pageNum = (i) => 3 + i * 3;
  const contentNum = (i) => 4 + i * 3;
  const imageNum = (i) => 5 + i * 3;
  const fontNum = 3 + numPages * 3;
  const numObjects = fontNum + 1;

  const lines = wrapText(fullText, CHARS_PER_LINE);

  const header = strToBytes('%PDF-1.4\n');
  const parts = [header];
  const offsets = [0];
  let currentOffset = header.length;

  function pushObject(num, bodyBytesArray) {
    const objHeader = strToBytes(`${num} 0 obj\n`);
    const objFooter = strToBytes('\nendobj\n');
    offsets[num] = currentOffset;
    parts.push(objHeader, ...bodyBytesArray, objFooter);
    currentOffset += objHeader.length + bodyBytesArray.reduce((s, b) => s + b.length, 0) + objFooter.length;
  }

  pushObject(1, [strToBytes('<< /Type /Catalog /Pages 2 0 R >>')]);

  const kids = [];
  for (let i = 0; i < numPages; i++) kids.push(`${pageNum(i)} 0 R`);
  pushObject(2, [strToBytes(`<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${numPages} >>`)]);

  for (let i = 0; i < numPages; i++) {
    const jpegBytes = imageList[i];
    const { width: imgW, height: imgH, numComponents, orientation } = readJpegInfo(jpegBytes);
    const colorSpace = numComponents === 1 ? '/DeviceGray' : numComponents === 4 ? '/DeviceCMYK' : '/DeviceRGB';

    const swapped = orientation >= 5 && orientation <= 8;
    const dispW = swapped ? imgH : imgW;
    const dispH = swapped ? imgW : imgH;

    const scale = dispW > MAX_PAGE_WIDTH_PT ? MAX_PAGE_WIDTH_PT / dispW : 1;
    const pageW = Math.round(dispW * scale);
    const pageH = Math.round(dispH * scale);
    const imgMatrix = getOrientationMatrix(orientation, Math.round(imgW * scale), Math.round(imgH * scale));

    let content = '';
    content += `q ${imgMatrix.join(' ')} cm /Im0 Do Q\n`;
    content += 'BT\n';
    content += '3 Tr\n';
    content += `/F0 ${FONT_SIZE_PT} Tf\n`;
    content += `${LINE_HEIGHT_PT} TL\n`;
    const y = pageH - 14;
    content += `1 0 0 1 4 ${y} Tm\n`;
    for (const line of lines) {
      content += `(${escapePdfText(line)}) Tj T*\n`;
    }
    content += 'ET\n';
    const contentBytes = strToBytes(content);

    pushObject(pageNum(i), [
      strToBytes(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] ` +
          `/Resources << /XObject << /Im0 ${imageNum(i)} 0 R >> /Font << /F0 ${fontNum} 0 R >> >> /Contents ${contentNum(i)} 0 R >>`
      ),
    ]);
    pushObject(contentNum(i), [
      strToBytes(`<< /Length ${contentBytes.length} >>\nstream\n`),
      contentBytes,
      strToBytes('\nendstream'),
    ]);
    pushObject(imageNum(i), [
      strToBytes(
        `<< /Type /XObject /Subtype /Image /Width ${imgW} /Height ${imgH} /ColorSpace ${colorSpace} ` +
          `/BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >>\nstream\n`
      ),
      jpegBytes,
      strToBytes('\nendstream'),
    ]);
  }

  pushObject(fontNum, [strToBytes('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')]);

  const xrefStart = currentOffset;
  let xref = `xref\n0 ${numObjects}\n0000000000 65535 f \n`;
  for (let i = 1; i < numObjects; i++) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${numObjects} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  parts.push(strToBytes(xref), strToBytes(trailer));

  return concatBytes(parts);
}

// --- storage/google-drive.js -------------------------------------------------

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_BASE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';
// Nicht "Belege" nennen: kollidiert mit der gleichnamigen Kategorie "Belege/Sonstiges".
const ROOT_FOLDER = 'Beleg-Scanner';

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

async function getFolderMeta(accessToken, folderId) {
  const res = await fetch(`${DRIVE_BASE}/files/${folderId}?fields=name,parents`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  return res.json();
}

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
    const folder = await getFolderMeta(accessToken, id);
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

async function searchDocuments(env, { q, kategorie, jahr }) {
  const accessToken = await getAccessToken(env);

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

// --- worker.js ---------------------------------------------------------------

const ALLOWED_ORIGIN = '*';
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const ALLOWED_MIME = /^image\/jpe?g$/;
const PDF_MIME = /^application\/pdf$/;
const MAX_PAGES = 10;
const MAX_MULTI_PAGE_TOTAL_BYTES = 14 * 1024 * 1024;

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Search-Password, X-Upload-Password',
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
  });
}

function sanitizeForFilename(text, maxLen = 40) {
  return String(text ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen) || 'Unbekannt';
}

function buildAnalysisPrompt(parts) {
  const isPdf = parts.length === 1 && parts[0].mimeType === 'application/pdf';
  const isMultiPage = parts.length > 1;
  const docDescription = isPdf
    ? 'das vollstaendige PDF-Dokument'
    : isMultiPage
      ? `${parts.length} Fotos, die zusammen die Seiten EINES Dokuments in der richtigen Reihenfolge zeigen`
      : 'das Foto eines Papierdokuments';

  return (
    `Du analysierst ${docDescription} (Rechnung, Beleg, Notarschreiben o.ae.). ` +
    'Antworte ausschliesslich mit einem JSON-Objekt (keine Markdown-Codeblocks, kein Fliesstext) ' +
    'mit genau diesen Feldern:\n' +
    '{\n' +
    '  "aussteller": string,   // Firma/Person, die das Dokument ausgestellt hat\n' +
    '  "grund": string,        // KURZE (2-5 Woerter) Zusammenfassung, WORUM es inhaltlich geht, z.B. "Stromrechnung Jahresabrechnung", "Kfz-Versicherung Beitrag", "Laptop-Kauf" - nicht identisch mit aussteller\n' +
    '  "datum": string,        // Format YYYY-MM-DD, falls erkennbar, sonst leer\n' +
    '  "betrag": string,       // Betrag inkl. Waehrung, falls vorhanden, sonst leer\n' +
    '  "kategorie": string,    // GENAU einer dieser Werte: ' + CATEGORIES.join(', ') + '\n' +
    '  "volltext": string      // kompletter erkannter Text ueber das gesamte Dokument (alle Seiten), fuer Volltextsuche\n' +
    '}\n' +
    'Waehle "kategorie" so genau wie moeglich passend zur Liste. Wenn du unsicher bist, nutze "' +
    FALLBACK_CATEGORY + '". "grund" soll kurz und eindeutig den Zweck des Dokuments beschreiben, nicht den Aussteller wiederholen.'
  );
}

async function analyzeWithGemini(env, parts) {
  const prompt = buildAnalysisPrompt(parts);

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            ...parts.map((p) => ({ inline_data: { mime_type: p.mimeType, data: p.base64 } })),
            { text: prompt },
          ],
        },
      ],
      generationConfig: { response_mime_type: 'application/json' },
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Gemini-Vision-Aufruf fehlgeschlagen (${res.status}): ${detail}`);
  }
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.find(p => p.text)?.text;
  if (!text) throw new Error('Gemini-Antwort enthielt keinen Text-Block');

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Gemini-Antwort war kein gueltiges JSON: ' + text.slice(0, 200));
  }
  if (!isValidCategory(parsed.kategorie)) parsed.kategorie = FALLBACK_CATEGORY;
  return parsed;
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

const LANDINGPAGE_WORKER_URL = 'https://landingpage.michel-brunner.workers.dev';

// Delegiert den Passwort-Vergleich an die zentrale Landingpage (Aktion
// verify-action-password) statt ihn lokal gegen ein eigenes Secret zu machen -
// faellt bei Netzfehler oder nicht konfiguriertem Secret dort sicher zu (kein Zugriff).
async function verifyActionPassword(scope, password) {
  try {
    const resp = await fetch(LANDINGPAGE_WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'verify-action-password', scope, password }),
    });
    return resp.ok;
  } catch (_) {
    return false;
  }
}

// Schuetzt die Suche (liest bestehende Belege); der Upload-Endpunkt ist separat
// per belegscanner-upload-Scope geschuetzt (siehe fetch-Handler unten).
async function handleSearch(request, env, url) {
  const password = request.headers.get('X-Search-Password') || '';
  if (!(await verifyActionPassword('belegscanner-suche', password))) {
    return jsonResponse({ ok: false, error: 'Falsches oder fehlendes Passwort.' }, 401);
  }

  try {
    const results = await searchDocuments(env, {
      q: url.searchParams.get('q') || '',
      kategorie: url.searchParams.get('kategorie') || '',
      jahr: url.searchParams.get('jahr') || '',
    });
    return jsonResponse({ ok: true, results });
  } catch (err) {
    return jsonResponse({ ok: false, error: err.message }, 500);
  }
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/search') {
      return handleSearch(request, env, url);
    }
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: corsHeaders() });
    }

    // Upload schuetzen: nur mit gueltigem Token. Verhindert, dass Fremde ueber die
    // (im Repo oeffentlich sichtbare) Worker-URL Uploads ausloesen -> Gemini-Quota-/Drive-Missbrauch.
    // Faellt "nach sicher": fehlt das Secret auf der Landingpage, sind alle Uploads gesperrt.
    if (!(await verifyActionPassword('belegscanner-upload', request.headers.get('X-Upload-Password') || ''))) {
      return jsonResponse({ ok: false, error: 'Falsches oder fehlendes Upload-Passwort.' }, 401);
    }

    try {
      const form = await request.formData();
      const files = form.getAll('photo').filter((f) => f && typeof f !== 'string');
      if (files.length === 0) {
        return jsonResponse({ ok: false, error: 'Kein Foto/Dokument in der Anfrage gefunden (Feld "photo").' }, 400);
      }
      for (const file of files) {
        if (file.size > MAX_FILE_BYTES) {
          return jsonResponse({ ok: false, error: `Datei zu gross (max. 15 MB): ${file.name || 'unbenannt'}` }, 400);
        }
      }

      const isPdfImport = files.length === 1 && PDF_MIME.test(files[0].type || '');
      const allJpeg = files.every((f) => ALLOWED_MIME.test(f.type || ''));
      if (!isPdfImport && !allJpeg) {
        return jsonResponse(
          { ok: false, error: 'Nicht unterstuetzte Kombination von Dateitypen. Erlaubt: mehrere JPEG-Fotos (Seiten eines Belegs) ODER eine einzelne PDF-Datei.' },
          400
        );
      }
      if (!isPdfImport) {
        if (files.length > MAX_PAGES) {
          return jsonResponse({ ok: false, error: `Zu viele Seiten in einer Anfrage (max. ${MAX_PAGES}).` }, 400);
        }
        const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
        if (totalBytes > MAX_MULTI_PAGE_TOTAL_BYTES) {
          return jsonResponse(
            { ok: false, error: 'Foto-Serie zu gross fuer eine gemeinsame Analyse (max. ca. 14 MB insgesamt) - bitte einzeln scannen oder Fotos komprimieren.' },
            400
          );
        }
      }

      const byteArrays = await Promise.all(files.map(async (f) => new Uint8Array(await f.arrayBuffer())));
      const mimeType = isPdfImport ? 'application/pdf' : 'image/jpeg';
      const parts = byteArrays.map((bytes) => ({ mimeType, base64: bytesToBase64(bytes) }));

      const analysis = await analyzeWithGemini(env, parts);

      const pdfBytes = isPdfImport ? byteArrays[0] : buildSearchablePdf(byteArrays, analysis.volltext || '');

      const datum = /^\d{4}-\d{2}-\d{2}$/.test(analysis.datum || '')
        ? analysis.datum
        : new Date().toISOString().slice(0, 10);
      const aussteller = sanitizeForFilename(analysis.aussteller);
      const grund = sanitizeForFilename(analysis.grund, 50);
      const filename = `${datum}_${aussteller}_${grund}.pdf`;

      const uploadResult = await uploadDocument(env, {
        category: analysis.kategorie,
        filename,
        bytes: pdfBytes,
        year: datum.slice(0, 4),
      });

      return jsonResponse({
        ok: true,
        kategorie: analysis.kategorie,
        aussteller: analysis.aussteller,
        datum,
        betrag: analysis.betrag,
        pfad: uploadResult.path,
        webUrl: uploadResult.webUrl,
      });
    } catch (err) {
      return jsonResponse({ ok: false, error: err.message }, 500);
    }
  },
};
