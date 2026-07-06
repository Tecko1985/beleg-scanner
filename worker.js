// Cloudflare Worker: nimmt ein Beleg-Foto vom Handy entgegen, laesst es von
// Google Gemini (kostenloser Tier) analysieren (Text + Kategorie), baut daraus
// ein durchsuchbares PDF und legt es im passenden Kategorie-Ordner in Google Drive ab.
//
// Deploy: Cloudflare Dashboard -> Workers & Pages -> Worker erstellen -> Code
// dieser Datei einfuegen. Da dieser Worker mehrere Module importiert
// (categories.js, pdf.js, storage/google-drive.js), entweder im Dashboard-Editor
// als zusaetzliche Dateien anlegen (Module-Worker-Format unterstuetzt das),
// oder falls das in eurer Dashboard-Version nicht geht: Inhalte der drei
// Dateien manuell in dieses Script einfuegen und die import/export-Zeilen
// entfernen.
//
// Benoetigte Secrets (Cloudflare Dashboard -> Settings -> Variables):
//   GEMINI_API_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN,
//   SEARCH_PASSWORD, UPLOAD_PASSWORD
//
// SEARCH_PASSWORD schuetzt GET /search, UPLOAD_PASSWORD schuetzt POST / (Upload) -
// beide Werte frei waehlbar, Vergleich per SHA-256-Digest + konstante Zeit (siehe
// checkPassword weiter unten). Vollstaendig eigenstaendig, keine Abhaengigkeit von
// einem anderen Worker oder Service Binding.

import { CATEGORIES, FALLBACK_CATEGORY, isValidCategory } from './categories.js';
import { buildSearchablePdf } from './pdf.js';
import { uploadDocument, searchDocuments } from './storage/google-drive.js';

const ALLOWED_ORIGIN = '*'; // Anpassen, sobald die Scan-Seite ein festes Hosting hat (siehe README)
const MAX_FILE_BYTES = 15 * 1024 * 1024; // 15 MB pro Einzeldatei (Foto oder PDF)
const ALLOWED_MIME = /^image\/jpe?g$/;
const PDF_MIME = /^application\/pdf$/;
const MAX_PAGES = 10; // max. Fotos pro mehrseitigem Beleg
// Gemini begrenzt Inline-Requests auf ~20MB (Base64 inflationiert Roh-Bytes um ~33%) -
// daher eigene, niedrigere Grenze fuer die Summe mehrerer Foto-Seiten in einem Request.
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
    .replace(/[̀-ͯ]/g, '') // Akzente entfernen (Aussteller-Namen vereinheitlichen)
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen) || 'Unbekannt';
}

// parts: Array von {mimeType, base64} - entweder 1..N image/jpeg (Foto-Seiten eines
// Dokuments in Reihenfolge) oder genau 1 application/pdf (bereits digitales Dokument).
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

// Vergleich ueber SHA-256-Digests gleicher Laenge + konstante-Zeit-Vergleich, damit
// weder Timing noch ein Laengen-Check das Passwort verraet. Fehlt das Secret, sind
// alle Zugriffe gesperrt (fail-closed).
async function checkPassword(env, secretName, given) {
  const secret = env[secretName];
  if (!secret) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(given || '')),
    crypto.subtle.digest('SHA-256', enc.encode(secret)),
  ]);
  const aBytes = new Uint8Array(a);
  const bBytes = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) diff |= aBytes[i] ^ bBytes[i];
  return diff === 0;
}

// Schuetzt die Suche (liest bestehende Belege); der Upload-Endpunkt ist separat
// per eigenem UPLOAD_PASSWORD-Secret geschuetzt (siehe fetch-Handler unten).
async function handleSearch(request, env, url) {
  const password = request.headers.get('X-Search-Password') || '';
  if (!(await checkPassword(env, 'SEARCH_PASSWORD', password))) {
    await new Promise((resolve) => setTimeout(resolve, 800)); // Bremse gegen Durchprobieren, ohne Login erreichbar
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

    // Upload schuetzen: nur mit gueltigem Passwort. Verhindert, dass Fremde ueber die
    // (im Repo oeffentlich sichtbare) Worker-URL Uploads ausloesen -> Gemini-Quota-/Drive-Missbrauch.
    // Faellt "nach sicher": fehlt das Secret, sind alle Uploads gesperrt.
    if (!(await checkPassword(env, 'UPLOAD_PASSWORD', request.headers.get('X-Upload-Password') || ''))) {
      await new Promise((resolve) => setTimeout(resolve, 800));
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

      // Genau 1 PDF -> bereits digitales Dokument importieren (kein Foto-Pfad).
      // Sonst muessen alle Eintraege JPEG-Fotos sein (1..N Seiten desselben Belegs).
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

      // Eine digitale PDF ist bereits durchsuchbar - kein Neubau, Original-Bytes 1:1 hochladen.
      // Foto(s) werden wie bisher zu einer durchsuchbaren PDF (1 Seite pro Foto) zusammengebaut.
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
