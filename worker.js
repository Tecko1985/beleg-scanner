// Cloudflare Worker: nimmt ein Beleg-Foto vom Handy entgegen, laesst es von
// Claude Vision analysieren (Text + Kategorie), baut daraus ein durchsuchbares
// PDF und legt es im passenden Kategorie-Ordner in OneDrive ab.
//
// Deploy: Cloudflare Dashboard -> Workers & Pages -> Worker erstellen -> Code
// dieser Datei einfuegen. Da dieser Worker mehrere Module importiert
// (categories.js, pdf.js, storage/onedrive.js), entweder im Dashboard-Editor
// als zusaetzliche Dateien anlegen (Module-Worker-Format unterstuetzt das),
// oder falls das in eurer Dashboard-Version nicht geht: Inhalte der drei
// Dateien manuell in dieses Script einfuegen und die import/export-Zeilen
// entfernen.
//
// Benoetigte Secrets (Cloudflare Dashboard -> Settings -> Variables):
//   ANTHROPIC_API_KEY, MS_CLIENT_ID, MS_CLIENT_SECRET, MS_REFRESH_TOKEN

import { CATEGORIES, FALLBACK_CATEGORY, isValidCategory } from './categories.js';
import { buildSearchablePdf } from './pdf.js';
import { uploadDocument } from './storage/onedrive.js';

const ALLOWED_ORIGIN = '*'; // Anpassen, sobald die Scan-Seite ein festes Hosting hat (siehe README)
const MAX_FILE_BYTES = 15 * 1024 * 1024; // 15 MB pro Foto
const ALLOWED_MIME = /^image\/jpe?g$/;

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
  });
}

function sanitizeForFilename(text, maxLen = 40) {
  return (text || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // Akzente entfernen (Aussteller-Namen vereinheitlichen)
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen) || 'Unbekannt';
}

async function analyzeWithClaude(env, base64Image) {
  const prompt =
    'Du analysierst das Foto eines Papierdokuments (Rechnung, Beleg, Notarschreiben o.ae.). ' +
    'Antworte ausschliesslich mit einem JSON-Objekt (keine Markdown-Codeblocks, kein Fliesstext) ' +
    'mit genau diesen Feldern:\n' +
    '{\n' +
    '  "aussteller": string,   // Firma/Person, die das Dokument ausgestellt hat\n' +
    '  "datum": string,        // Format YYYY-MM-DD, falls erkennbar, sonst leer\n' +
    '  "betrag": string,       // Betrag inkl. Waehrung, falls vorhanden, sonst leer\n' +
    '  "kategorie": string,    // GENAU einer dieser Werte: ' + CATEGORIES.join(', ') + '\n' +
    '  "volltext": string      // kompletter erkannter Text auf dem Dokument, fuer Volltextsuche\n' +
    '}\n' +
    'Waehle "kategorie" so genau wie moeglich passend zur Liste. Wenn du unsicher bist, nutze "' +
    FALLBACK_CATEGORY + '".';

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64Image } },
            { type: 'text', text: prompt },
          ],
        },
      ],
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Claude-Vision-Aufruf fehlgeschlagen (${res.status}): ${detail}`);
  }
  const data = await res.json();
  const textBlock = data.content?.find(c => c.type === 'text');
  if (!textBlock) throw new Error('Claude-Antwort enthielt keinen Text-Block');

  let parsed;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch {
    throw new Error('Claude-Antwort war kein gueltiges JSON: ' + textBlock.text.slice(0, 200));
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

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: corsHeaders() });
    }

    try {
      const form = await request.formData();
      const file = form.get('photo');
      if (!file || typeof file === 'string') {
        return jsonResponse({ ok: false, error: 'Kein Foto in der Anfrage gefunden (Feld "photo").' }, 400);
      }
      if (!ALLOWED_MIME.test(file.type || '')) {
        return jsonResponse({ ok: false, error: 'Nur JPEG-Fotos werden unterstuetzt.' }, 400);
      }
      if (file.size > MAX_FILE_BYTES) {
        return jsonResponse({ ok: false, error: 'Foto zu gross (max. 15 MB).' }, 400);
      }

      const jpegBytes = new Uint8Array(await file.arrayBuffer());
      const base64Image = bytesToBase64(jpegBytes);

      const analysis = await analyzeWithClaude(env, base64Image);

      const pdfBytes = buildSearchablePdf(jpegBytes, analysis.volltext || '');

      const datum = /^\d{4}-\d{2}-\d{2}$/.test(analysis.datum || '')
        ? analysis.datum
        : new Date().toISOString().slice(0, 10);
      const aussteller = sanitizeForFilename(analysis.aussteller);
      const betrag = sanitizeForFilename(analysis.betrag, 15);
      const filename = `${datum}_${aussteller}${betrag !== 'Unbekannt' ? '_' + betrag : ''}.pdf`;

      const uploadResult = await uploadDocument(env, {
        category: analysis.kategorie,
        filename,
        bytes: pdfBytes,
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
