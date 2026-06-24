// ===========================================================================
// DEPLOY-FERTIGE EINZELDATEI fuer Cloudflare Workers (Dashboard Quick-Edit).
// Enthaelt zusammengefuehrt: categories.js + pdf.js + storage/onedrive.js +
// worker.js. Die einzelnen Quelldateien im Repo sind die "Wahrheit" fuer
// Weiterentwicklung - diese Datei wird daraus von Hand zusammengefuehrt und
// 1:1 in den Cloudflare-Worker-Editor eingefuegt (kein Build-Schritt, kein
// Node noetig).
//
// Benoetigte Secrets (Cloudflare Dashboard -> Settings -> Variables and Secrets):
//   GEMINI_API_KEY, MS_CLIENT_ID, MS_CLIENT_SECRET, MS_REFRESH_TOKEN
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

const PAGE_MARGIN_PT = 0;
const MAX_PAGE_WIDTH_PT = 1000;
const FONT_SIZE_PT = 9;
const LINE_HEIGHT_PT = 11;
const CHARS_PER_LINE = 100;

function readJpegInfo(bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error('Kein gueltiges JPEG (fehlender SOI-Marker)');
  }
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) { offset++; continue; }
    const marker = bytes[offset + 1];
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      const height = (bytes[offset + 5] << 8) | bytes[offset + 6];
      const width = (bytes[offset + 7] << 8) | bytes[offset + 8];
      const numComponents = bytes[offset + 9];
      return { width, height, numComponents };
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const segmentLength = (bytes[offset + 2] << 8) | bytes[offset + 3];
    offset += 2 + segmentLength;
  }
  throw new Error('JPEG-Abmessungen konnten nicht ermittelt werden (kein SOF-Marker gefunden)');
}

function escapePdfText(str) {
  let out = '';
  for (const ch of String(str ?? '')) {
    let code = ch.codePointAt(0);
    if (code === 0x20ac) code = 0x80;
    if (code > 0xff) code = 0x3f;
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

function buildSearchablePdf(jpegBytes, fullText) {
  const { width: imgW, height: imgH, numComponents } = readJpegInfo(jpegBytes);
  const colorSpace = numComponents === 1 ? '/DeviceGray' : numComponents === 4 ? '/DeviceCMYK' : '/DeviceRGB';

  const scale = imgW > MAX_PAGE_WIDTH_PT ? MAX_PAGE_WIDTH_PT / imgW : 1;
  const pageW = Math.round(imgW * scale);
  const pageH = Math.round(imgH * scale);

  const lines = wrapText(fullText, CHARS_PER_LINE);

  let content = '';
  content += `q ${pageW} 0 0 ${pageH} ${PAGE_MARGIN_PT} ${PAGE_MARGIN_PT} cm /Im0 Do Q\n`;
  content += 'BT\n';
  content += '3 Tr\n';
  content += `/F0 ${FONT_SIZE_PT} Tf\n`;
  content += `${LINE_HEIGHT_PT} TL\n`;
  let y = pageH - 14;
  content += `1 0 0 1 4 ${y} Tm\n`;
  for (const line of lines) {
    content += `(${escapePdfText(line)}) Tj T*\n`;
  }
  content += 'ET\n';

  const contentBytes = strToBytes(content);

  const objects = [];
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  objects.push(
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] ` +
      '/Resources << /XObject << /Im0 5 0 R >> /Font << /F0 6 0 R >> >> /Contents 4 0 R >>'
  );
  objects.push(null);
  objects.push(null);
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');

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

  pushObject(1, [strToBytes(objects[0])]);
  pushObject(2, [strToBytes(objects[1])]);
  pushObject(3, [strToBytes(objects[2])]);
  pushObject(4, [strToBytes(`<< /Length ${contentBytes.length} >>\nstream\n`), contentBytes, strToBytes('\nendstream')]);
  pushObject(5, [
    strToBytes(
      `<< /Type /XObject /Subtype /Image /Width ${imgW} /Height ${imgH} /ColorSpace ${colorSpace} ` +
        `/BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >>\nstream\n`
    ),
    jpegBytes,
    strToBytes('\nendstream'),
  ]);
  pushObject(6, [strToBytes(objects[5])]);

  const xrefStart = currentOffset;
  const numObjects = 7;
  let xref = `xref\n0 ${numObjects}\n0000000000 65535 f \n`;
  for (let i = 1; i < numObjects; i++) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  const trailer = `trailer\n<< /Size ${numObjects} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  parts.push(strToBytes(xref), strToBytes(trailer));

  return concatBytes(parts);
}

// --- storage/onedrive.js ----------------------------------------------------

const TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const ROOT_FOLDER = 'Belege';

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

// --- worker.js ---------------------------------------------------------------

const ALLOWED_ORIGIN = '*';
const MAX_FILE_BYTES = 15 * 1024 * 1024;
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
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen) || 'Unbekannt';
}

async function analyzeWithGemini(env, base64Image) {
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

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${env.GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { inline_data: { mime_type: 'image/jpeg', data: base64Image } },
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

      const analysis = await analyzeWithGemini(env, base64Image);

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
