// Erzeugt ein durchsuchbares PDF aus einem JPEG-Foto + extrahiertem Volltext.
// Reines JS ohne Abhaengigkeiten (kein pdf-lib o.ae.) - laeuft unveraendert
// im Cloudflare Worker (V8-Isolate) UND im Browser (Test via Claude_Preview),
// weil keine Node- oder DOM-spezifischen APIs verwendet werden.
//
// Strategie: Die Original-JPEG-Bytes werden 1:1 per /DCTDecode als
// Image-XObject eingebettet (kein Re-Encoding, keine Qualitaetsverluste).
// Der von der KI erkannte Volltext wird als unsichtbarer Text-Layer
// (Render-Mode "3 Tr") darueber gelegt, damit OneDrive/Google Drive den
// Inhalt in ihrer eigenen Volltextsuche indizieren.
//
// Einschraenkung: Ohne Wort-Bounding-Boxes liegt der Text nicht
// pixelgenau ueber dem Bildbereich - fuer Volltextsuche reicht das.

const PAGE_MARGIN_PT = 0; // Bild deckt die volle Seite ab (kein Rand)
const MAX_PAGE_WIDTH_PT = 1000; // Begrenzung, damit sehr hochaufloeste Fotos kein Riesen-PDF ergeben
const FONT_SIZE_PT = 9;
const LINE_HEIGHT_PT = 11;
const CHARS_PER_LINE = 100;

// --- JPEG-Header parsen, um Breite/Hoehe/Farbkomponenten zu bestimmen ---
function readJpegInfo(bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error('Kein gueltiges JPEG (fehlender SOI-Marker)');
  }
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) { offset++; continue; }
    const marker = bytes[offset + 1];
    // SOF0..SOF15 ausser DHT(0xC4), JPG(0xC8), DAC(0xCC)
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

// --- Hilfsfunktionen fuer PDF-Strings/Bytes ---
function escapePdfText(str) {
  // PDFDocEncoding/WinAnsiEncoding deckt Latin-1 (inkl. deutscher Umlaute) 1:1 ab.
  // Zeichen ausserhalb von 0x00-0xFF (z.B. Emoji) werden durch '?' ersetzt.
  let out = '';
  for (const ch of String(str ?? '')) {
    let code = ch.codePointAt(0);
    if (code === 0x20ac) code = 0x80; // Euro-Zeichen liegt in WinAnsi auf 0x80
    if (code > 0xff) code = 0x3f; // '?'
    if (code === 0x28 || code === 0x29 || code === 0x5c) {
      out += '\\' + String.fromCharCode(code); // ( ) \ escapen
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
  // Nur Latin-1-Bereich wird in PDF-Strukturzeichenfolgen (Header, Dictionaries) verwendet.
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

/**
 * Erzeugt ein durchsuchbares PDF.
 * @param {Uint8Array} jpegBytes - Original-Foto als JPEG.
 * @param {string} fullText - Von der KI extrahierter Volltext (wird unsichtbar eingebettet).
 * @returns {Uint8Array} Komplette PDF-Datei.
 */
function buildSearchablePdf(jpegBytes, fullText) {
  const { width: imgW, height: imgH, numComponents } = readJpegInfo(jpegBytes);
  const colorSpace = numComponents === 1 ? '/DeviceGray' : numComponents === 4 ? '/DeviceCMYK' : '/DeviceRGB';

  // Seitengroesse = Bildgroesse (in pt, 1px = 1pt), gekappt auf MAX_PAGE_WIDTH_PT.
  const scale = imgW > MAX_PAGE_WIDTH_PT ? MAX_PAGE_WIDTH_PT / imgW : 1;
  const pageW = Math.round(imgW * scale);
  const pageH = Math.round(imgH * scale);

  const lines = wrapText(fullText, CHARS_PER_LINE);

  // --- Content-Stream: Bild zeichnen, dann unsichtbaren Text drueberlegen ---
  let content = '';
  content += `q ${pageW} 0 0 ${pageH} ${PAGE_MARGIN_PT} ${PAGE_MARGIN_PT} cm /Im0 Do Q\n`;
  content += 'BT\n';
  content += '3 Tr\n'; // Render-Mode 3 = unsichtbar (aber selektierbar/durchsuchbar)
  content += `/F0 ${FONT_SIZE_PT} Tf\n`;
  content += `${LINE_HEIGHT_PT} TL\n`;
  let y = pageH - 14;
  content += `1 0 0 1 4 ${y} Tm\n`;
  for (const line of lines) {
    content += `(${escapePdfText(line)}) Tj T*\n`;
  }
  content += 'ET\n';

  const contentBytes = strToBytes(content);

  // --- PDF-Objekte zusammensetzen ---
  const objects = [];
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  objects.push(
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] ` +
      '/Resources << /XObject << /Im0 5 0 R >> /Font << /F0 6 0 R >> >> /Contents 4 0 R >>'
  );
  // Objekt 4 (Content-Stream) und 5 (Bild-XObject) werden unten als Binaer-Teile gebaut, da sie
  // rohe Bytes (Stream-Daten) enthalten - kein reiner Text wie die anderen Objekte.
  objects.push(null); // Platzhalter Index 3 (Objekt 4)
  objects.push(null); // Platzhalter Index 4 (Objekt 5)
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');

  const header = strToBytes('%PDF-1.4\n');
  const parts = [header];
  const offsets = [0]; // Objekt 0 existiert nicht (Free-Object), Index ab 1 relevant
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
  const numObjects = 7; // 0..6
  let xref = `xref\n0 ${numObjects}\n0000000000 65535 f \n`;
  for (let i = 1; i < numObjects; i++) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  const trailer =
    `trailer\n<< /Size ${numObjects} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  parts.push(strToBytes(xref), strToBytes(trailer));

  return concatBytes(parts);
}

export { buildSearchablePdf, readJpegInfo };
