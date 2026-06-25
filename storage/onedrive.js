// OneDrive-Storage-Anbindung ueber Microsoft Graph API.
// Erfuellt das gemeinsame Storage-Interface uploadDocument({category, filename, bytes}),
// damit spaetere Provider (z.B. Google Drive) worker.js nicht anfassen muessen.
//
// Auth: Microsoft OAuth2 "Refresh Token Flow". Der Refresh-Token wird einmalig per
// Azure-App-Registrierung + Consent erzeugt und als Cloudflare-Secret MS_REFRESH_TOKEN
// hinterlegt (siehe README.md). Der Worker tauscht ihn bei jedem Request gegen ein
// kurzlebiges Access-Token - kein Caching zwischen Requests (Workers sind stateless).

const TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
// Nicht "Belege" nennen: kollidiert mit der gleichnamigen Kategorie "Belege/Sonstiges"
// (Pfad waere sonst Belege/Belege/Sonstiges/...).
const ROOT_FOLDER = 'Beleg-Scanner'; // Oberster Ordner in OneDrive, unter dem alle Kategorien liegen
const SIMPLE_UPLOAD_LIMIT = 4 * 1024 * 1024; // Graph-Limit fuer PUT .../content
const UPLOAD_CHUNK_SIZE = 10 * 1024 * 1024; // muss Vielfaches von 320 KiB sein (Graph-Vorgabe)

async function getAccessToken(env) {
  const body = new URLSearchParams({
    client_id: env.MS_CLIENT_ID,
    client_secret: env.MS_CLIENT_SECRET,
    refresh_token: env.MS_REFRESH_TOKEN,
    grant_type: 'refresh_token',
    scope: 'Files.ReadWrite offline_access',
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Microsoft-Token-Refresh fehlgeschlagen (${res.status}): ${detail}`);
  }
  const data = await res.json();
  return data.access_token;
}

/**
 * Laedt ein Dokument in den passenden Kategorie-Ordner in OneDrive hoch.
 * @param {object} env - Worker-Environment (Secrets MS_CLIENT_ID, MS_CLIENT_SECRET, MS_REFRESH_TOKEN).
 * @param {{category: string, filename: string, bytes: Uint8Array}} doc
 * @returns {Promise<{path: string, webUrl: string}>}
 */
async function uploadDocument(env, { category, filename, bytes }) {
  const accessToken = await getAccessToken(env);
  const path = `${ROOT_FOLDER}/${category}/${filename}`;
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');

  if (bytes.length <= SIMPLE_UPLOAD_LIMIT) {
    return uploadSimple(accessToken, path, encodedPath, bytes);
  }
  // Microsoft Graph verlangt fuer Dateien >4MB eine Upload-Session statt PUT .../content
  return uploadInChunks(accessToken, path, encodedPath, bytes);
}

async function uploadSimple(accessToken, path, encodedPath, bytes) {
  const res = await fetch(`${GRAPH_BASE}/me/drive/root:/${encodedPath}:/content`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/pdf',
    },
    body: bytes,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`OneDrive-Upload fehlgeschlagen (${res.status}) fuer ${path}: ${detail}`);
  }
  const data = await res.json();
  return { path, webUrl: data.webUrl };
}

async function uploadInChunks(accessToken, path, encodedPath, bytes) {
  const sessionRes = await fetch(`${GRAPH_BASE}/me/drive/root:/${encodedPath}:/createUploadSession`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace' } }),
  });
  if (!sessionRes.ok) {
    const detail = await sessionRes.text().catch(() => '');
    throw new Error(`OneDrive-Upload-Session fehlgeschlagen (${sessionRes.status}) fuer ${path}: ${detail}`);
  }
  const { uploadUrl } = await sessionRes.json();

  let offset = 0;
  let lastData = null;
  while (offset < bytes.length) {
    const end = Math.min(offset + UPLOAD_CHUNK_SIZE, bytes.length);
    const chunk = bytes.subarray(offset, end);
    const res = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Length': String(chunk.length),
        'Content-Range': `bytes ${offset}-${end - 1}/${bytes.length}`,
      },
      body: chunk,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`OneDrive-Upload (Chunk ${offset}-${end - 1}) fehlgeschlagen (${res.status}) fuer ${path}: ${detail}`);
    }
    if (end === bytes.length) lastData = await res.json();
    offset = end;
  }
  return { path, webUrl: lastData?.webUrl };
}

export { uploadDocument };
