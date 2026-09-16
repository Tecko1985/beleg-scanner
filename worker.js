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

// ⚠️ Bis zum 06.09.2026 stand hier '*' mit dem Vermerk „Anpassen, sobald die
// Scan-Seite ein festes Hosting hat“. Sie hat eines: index.html und search.html
// liegen unter https://tecko1985.github.io/beleg-scanner/ und rufen von dort
// https://beleg-scanner.michel-brunner.workers.dev.
//
// Mit '*' durfte JEDE Seite im Netz den Worker im Browser eines Besuchers rufen.
// Ohne Passwort war das folgenlos -- aber es hat den Passwortschutz zum einzigen
// Riegel gemacht, und ein Riegel allein ist keine Tiefe.
//
// ⚠️ Wenn die Scan-Seite je umzieht, MUSS diese Zeile mit. Sonst laufen alle
// Uploads in einen CORS-Fehler, den der Browser nur in der Konsole zeigt --
// die Seite sieht dann einfach kaputt aus. Und: lokale Vorschau (localhost)
// ist damit ausgeschlossen; zum Entwickeln hier voruebergehend '*' setzen.
const ALLOWED_ORIGIN = 'https://tecko1985.github.io';
const MAX_FILE_BYTES = 15 * 1024 * 1024; // 15 MB pro Einzeldatei (Foto oder PDF)
// Hoechstens so viele FEHLversuche je IP und Stunde. Ein vertipptes Passwort
// braucht ein paar Anlaeufe, ein Durchprobieren scheitert daran. Vorbild:
// bremseOffen/bremseFehlschlag in E:\agelan\worker.js und
// pwBremseOffen/pwBremseFehlschlag in E:\ToolsUebersicht\admin-worker.js.
const FEHL_MAX_PRO_STUNDE = 30;
const FEHL_ZAEHLER = new Map();
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

// Gemini weist bei Kapazitaetsengpaessen mit 503 ("high demand") ab - laut Google ein
// voruebergehender Zustand, den der Client durch Wiederholen ueberbruecken soll. Ohne
// das verbrennt ein Sekunden-Wackler den kompletten Beleg, und der kostenlose Tier wird
// bei Engpaessen zuerst abgewiesen. Bewusst knapp gehalten (max. ~10s zusaetzlich): der
// Upload laeuft ohnehin schon 30-60s, und die Warteschlange im Frontend arbeitet die
// Belege nacheinander ab - jede Wartezeit hier verzoegert auch alle folgenden.
const GEMINI_RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const GEMINI_RETRY_DELAYS_MS = [1500, 3000, 6000];

// Google schickt bei 429 gelegentlich ein Retry-After (in Sekunden) - respektieren,
// aber nach oben deckeln, damit ein grosszuegiger Wert den Request nicht ins
// Verbindungs-Timeout laufen laesst.
function geminiRetryDelay(res, attempt) {
  const fallback = GEMINI_RETRY_DELAYS_MS[attempt];
  const retryAfter = Number(res.headers.get('retry-after'));
  if (!Number.isFinite(retryAfter) || retryAfter <= 0) return fallback;
  return Math.min(Math.max(retryAfter * 1000, fallback), 8000);
}

async function analyzeWithGemini(env, parts) {
  const prompt = buildAnalysisPrompt(parts);

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`;
  const body = JSON.stringify({
    contents: [
      {
        parts: [
          ...parts.map((p) => ({ inline_data: { mime_type: p.mimeType, data: p.base64 } })),
          { text: prompt },
        ],
      },
    ],
    generationConfig: { response_mime_type: 'application/json' },
  });

  let res;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    if (res.ok) break;
    // Alles ausserhalb der Kapazitaets-Codes (400 kaputter Request, 403 Key, 404 Modell)
    // wird durch Warten nicht besser - sofort durchreichen.
    if (!GEMINI_RETRY_STATUS.has(res.status) || attempt >= GEMINI_RETRY_DELAYS_MS.length) {
      const detail = await res.text().catch(() => '');
      const versuche = attempt + 1;
      throw new Error(
        `Gemini-Vision-Aufruf fehlgeschlagen (${res.status}) nach ${versuche} Versuch${versuche === 1 ? '' : 'en'}: ${detail}`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, geminiRetryDelay(res, attempt)));
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

function bremseIp(request) {
  return String((request.headers && request.headers.get('CF-Connecting-IP')) || '');
}


// ⚠️⚠️ Zum Zaehlwerk hier darueber (2026-09-15 gemessen): es greift LIVE
// praktisch nie. Cloudflare fuehrt den Worker in Isolates aus, die frei
// erzeugt und verworfen werden -- die Map im Modul-Rumpf ist ein
// Wegwerf-Gedaechtnis. Belegt an einem Wegwerf-Worker: 30 gleichzeitige
// Anfragen verteilten sich auf mindestens ZWOELF Isolates, hoechster
// Zaehlerstand 5. Eine Stundengrenze wird so nie erreicht.
//
// Die Map bleibt stehen (kostet nichts, greift wenn zwei Anfragen dasselbe
// Isolate treffen). Der wirksame Teil ist die Funktion darunter.

// Cloudflares eigenes Zaehlwerk (Bindung "BREMSE"). Zaehlt AUSSERHALB des
// Isolates und ueberlebt den Instanzwechsel.
//
// ⚠️ EHRLICH ZU DEN GRENZEN -- das ist KEIN Ersatz fuer die Stundengrenze
// darueber, sondern ein Deckel gegen Dauerbeschuss:
//   - Cloudflare kennt nur Fenster von 10 oder 60 Sekunden, keine Stunde.
//   - Gezaehlt wird je Cloudflare-Standort. Eine Welle aus einem Anschluss
//     verteilt sich; bis ein Standort ueber die Grenze kommt, braucht es
//     grob das Zwanzigfache der Grenze an Anfragen.
// Wer eine echte Stundengrenze braucht, muss in D1 zaehlen.
//
// Zwei Faelle geben bewusst frei statt zu sperren: Bindung fehlt (aelterer
// Deploy) und Bindung wirft. ⚠️ Eine fehlende Client-Adresse gab bis 16.09.2026
// ebenfalls frei; sie zaehlt jetzt in den gemeinsamen Topf "ohne-ip" -- dieser
// Worker hat keinen Aufrufer ohne eigene Herkunft, der das braeuchte.
async function bremseLimit(env, schluessel) {
  if (!env || !env.BREMSE || typeof env.BREMSE.limit !== "function") return true;
  try {
    const r = await env.BREMSE.limit({ key: schluessel });
    return !!r && r.success !== false;
  } catch (fehler) {
    console.warn("BREMSE-Bindung nicht nutzbar: " + ((fehler && fehler.message) || fehler));
    return true;
  }
}

// ⚠️ Abnahme 16.09.2026 (Fund 2): limit() kann nicht nachsehen, ohne mitzuzaehlen.
// Deshalb stand die Bindung nur im Fehlschlag-Zweig -- bei voller Grenze bekam ein
// falsches Passwort 429, ein RICHTIGES aber weiter 200, und ein Rater erkannte den
// Treffer trotzdem. limit() auch beim Erfolg auf DEMSELBEN Schluessel wuerde
// dagegen den regulaeren Nutzer aussperren, der viel scannt oder sucht.
//
// Der Bau: FAECHER. Ein Fehlversuch zaehlt in allen BREMSE_FAECHER Faechern, ein
// Erfolg nur in einem (reihum). Nach 10 Fehlversuchen (Grenze der Bindung) sind
// alle Faecher voll, also bekommt auch der Treffer 429. Wer das Passwort kennt,
// belastet je Aufruf nur ein Sechzehntel -- erst ~160 erfolgreiche Aufrufe je
// Minute aus einer Adresse (am selben Standort) fuellen die Faecher. Gleicher Bau wie in
// E:\ToolsUebersicht\admin-worker.js (bindungFehlschlagZaehlen).
//
// Restluecke: die Bindung zaehlt je Cloudflare-Standort und ist traege; wer auf
// viele Standorte verteilt, bekommt weiter Urteile, nur gedeckelt.
const BREMSE_FAECHER = 16;

function bremseSchluessel(request, kennung) {
  const ip = String((request && request.headers && request.headers.get("CF-Connecting-IP")) || "");
  return kennung + ":" + (ip || "ohne-ip");
}

async function bindungFehlschlagZaehlen(env, request, kennung) {
  const basis = bremseSchluessel(request, kennung);
  const aufrufe = [];
  for (let i = 0; i < BREMSE_FAECHER; i++) aufrufe.push(bremseLimit(env, basis + ":f" + i));
  return (await Promise.all(aufrufe)).every(Boolean);
}

// Reihum statt Wuerfel: im selben Isolate verteilen sich die Treffer exakt
// gleichmaessig, der Startpunkt ist je Isolate zufaellig.
let bremseRundlauf = Math.floor(Math.random() * BREMSE_FAECHER);
async function bindungErfolgPruefen(env, request, kennung) {
  bremseRundlauf = (bremseRundlauf + 1) % BREMSE_FAECHER;
  return bremseLimit(env, bremseSchluessel(request, kennung) + ":f" + bremseRundlauf);
}

function bremseOffen(request) {
  const ip = bremseIp(request);
  if (!ip) return true;
  const eintrag = FEHL_ZAEHLER.get(ip);
  if (!eintrag || Date.now() - eintrag.start > 3600000) return true;
  return eintrag.n < FEHL_MAX_PRO_STUNDE;
}

// Nur nach einem FEHLversuch aufrufen, nie nach einem erfolgreichen -- sonst
// sperrt sich aus, wer das Passwort kennt und viel scannt.
function bremseFehlschlag(request) {
  const ip = bremseIp(request);
  if (!ip) return;
  const jetzt = Date.now();
  const eintrag = FEHL_ZAEHLER.get(ip);
  if (!eintrag || jetzt - eintrag.start > 3600000) {
    FEHL_ZAEHLER.set(ip, { start: jetzt, n: 1 });
    // Aufraeumen, damit die Map in einem langlebigen Isolate nicht waechst.
    if (FEHL_ZAEHLER.size > 500) {
      for (const [k, v] of FEHL_ZAEHLER) {
        if (jetzt - v.start > 3600000) FEHL_ZAEHLER.delete(k);
      }
    }
    return;
  }
  eintrag.n++;
}

// Der Dateityp aus den ERSTEN BYTES. f.type ist der Content-Type aus dem
// Multipart-Rumpf und damit eine Angabe des Absenders: mit
// type: 'application/pdf' gingen beliebige Bytes unveraendert nach Drive.
// Dieser Worker kennt genau zwei Formen -- JPEG-Fotos und PDF.
function erkenneDateiTyp(b) {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'pdf';
  return null;
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
  // Die Bremse VOR dem Vergleich: sonst kostet jeder Rateversuch weiterhin
  // einen vollen Durchlauf. Die alte Verzoegerung war keine Bremse -- sie hielt
  // nur auf, wer nacheinander probiert, und parallele Versuche gar nicht.
  if (!bremseOffen(request)) {
    return jsonResponse({ ok: false, error: 'Zu viele Fehlversuche. Bitte spaeter erneut versuchen.' }, 429);
  }
  if (!(await checkPassword(env, 'SEARCH_PASSWORD', password))) {
    bremseFehlschlag(request);
    // ⚠️ Der Zaehler, der den Isolate-Wechsel ueberlebt -- bewusst HIER im
    // Fehlschlag-Zweig und nicht oben am Eingang: limit() zaehlt jeden Aufruf
    // mit, und wer das Passwort kennt, sucht womoeglich oft. Am Eingang
    // wuerde sich also der regulaere Nutzer selbst aussperren.
    if (!(await bindungFehlschlagZaehlen(env, request, "beleg-suche"))) {
      return jsonResponse({ ok: false, error: 'Zu viele Fehlversuche. Bitte spaeter erneut versuchen.' }, 429);
    }
    return jsonResponse({ ok: false, error: 'Falsches oder fehlendes Passwort.' }, 401);
  }
  // Auch der Treffer fragt die Bremse (siehe bindungFehlschlagZaehlen).
  if (!(await bindungErfolgPruefen(env, request, "beleg-suche"))) {
    return jsonResponse({ ok: false, error: 'Zu viele Fehlversuche. Bitte spaeter erneut versuchen.' }, 429);
  }

  try {
    const { results, abgeschnitten } = await searchDocuments(env, {
      q: url.searchParams.get('q') || '',
      kategorie: url.searchParams.get('kategorie') || '',
      jahr: url.searchParams.get('jahr') || '',
    });
    // abgeschnitten = der Seiten-Deckel wurde erreicht, es gibt mehr. Die Suchseite
    // muss das sagen duerfen, sonst sieht eine halbe Liste aus wie eine ganze.
    return jsonResponse({ ok: true, results, abgeschnitten });
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
    // Bremse vor dem Vergleich, siehe handleSearch. Ein Treffer auf
    // UPLOAD_PASSWORD oeffnet Gemini-Kontingent und den Drive-Ordner.
    if (!bremseOffen(request)) {
      return jsonResponse({ ok: false, error: 'Zu viele Fehlversuche. Bitte spaeter erneut versuchen.' }, 429);
    }
    if (!(await checkPassword(env, 'UPLOAD_PASSWORD', request.headers.get('X-Upload-Password') || ''))) {
      bremseFehlschlag(request);
      // Wie bei der Suche: im Fehlschlag-Zweig. Wer viele Belege hochlaedt,
      // soll sein eigenes Kontingent nicht aufbrauchen.
      if (!(await bindungFehlschlagZaehlen(env, request, "beleg-upload"))) {
        return jsonResponse({ ok: false, error: 'Zu viele Fehlversuche. Bitte spaeter erneut versuchen.' }, 429);
      }
      return jsonResponse({ ok: false, error: 'Falsches oder fehlendes Upload-Passwort.' }, 401);
    }
    // Auch der Treffer fragt die Bremse (siehe bindungFehlschlagZaehlen).
    if (!(await bindungErfolgPruefen(env, request, "beleg-upload"))) {
      return jsonResponse({ ok: false, error: 'Zu viele Fehlversuche. Bitte spaeter erneut versuchen.' }, 429);
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
      const kopfBytes = await Promise.all(
        files.map(async (f) => new Uint8Array(await f.slice(0, 8).arrayBuffer()))
      );
      const typen = kopfBytes.map(erkenneDateiTyp);
      const isPdfImport = files.length === 1 && typen[0] === 'pdf';
      const allJpeg = typen.length > 0 && typen.every((t) => t === 'jpeg');
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
