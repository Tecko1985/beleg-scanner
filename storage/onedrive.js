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
const ROOT_FOLDER = 'Belege'; // Oberster Ordner in OneDrive, unter dem alle Kategorien liegen

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
  const url = `${GRAPH_BASE}/me/drive/root:/${path.split('/').map(encodeURIComponent).join('/')}:/content`;

  const res = await fetch(url, {
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

export { uploadDocument };
