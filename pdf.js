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

const MAX_PAGE_WIDTH_PT = 1000; // Begrenzung, damit sehr hochaufloeste Fotos kein Riesen-PDF ergeben
const FONT_SIZE_PT = 9;
const LINE_HEIGHT_PT = 11;
const CHARS_PER_LINE = 100;

// --- JPEG-Header parsen, um Breite/Hoehe/Farbkomponenten/EXIF-Rotation zu bestimmen ---
function readJpegInfo(bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error('Kein gueltiges JPEG (fehlender SOI-Marker)');
  }
  let offset = 2;
  let orientation = 1;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) { offset++; continue; }
    const marker = bytes[offset + 1];
    // SOF0..SOF15 ausser DHT(0xC4), JPG(0xC8), DAC(0xCC)
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
    return null; // kein "Exif"-Header in diesem APP1-Segment
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

// Platzierungsmatrix [a b c d e f] fuer den 'cm'-Operator, die die EXIF-Orientierung
// korrigiert. w/h sind die (skalierten) rohen Bilddimensionen (vor Rotation).
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

// --- Hilfsfunktionen fuer PDF-Strings/Bytes ---
// WinAnsiEncoding (Windows-1252) weicht im Bereich 0x80-0x9F von Latin-1 ab und bildet
// dort u.a. typografische Anfuehrungszeichen/Gedankenstriche ab, die OCR-Text oft enthaelt.
const WIN_ANSI_EXTRA = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85,
  0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a,
  0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92,
  0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
  0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c,
  0x017e: 0x9e, 0x0178: 0x9f,
};

function escapePdfText(str) {
  // Latin-1-Bereich (0x00-0xFF) deckt WinAnsiEncoding direkt ab (inkl. deutscher Umlaute).
  // Zeichen ausserhalb davon (z.B. Emoji) werden durch '?' ersetzt.
  let out = '';
  for (const ch of String(str ?? '')) {
    let code = ch.codePointAt(0);
    if (code in WIN_ANSI_EXTRA) code = WIN_ANSI_EXTRA[code];
    else if (code > 0xff) code = 0x3f; // '?'
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
  const { width: imgW, height: imgH, numComponents, orientation } = readJpegInfo(jpegBytes);
  const colorSpace = numComponents === 1 ? '/DeviceGray' : numComponents === 4 ? '/DeviceCMYK' : '/DeviceRGB';

  // Bei 90/270-Grad-Drehung (Orientation 5-8) vertauschen sich Anzeige-Breite/-Hoehe.
  const swapped = orientation >= 5 && orientation <= 8;
  const dispW = swapped ? imgH : imgW;
  const dispH = swapped ? imgW : imgH;

  // Seitengroesse = Anzeigegroesse (in pt, 1px = 1pt), gekappt auf MAX_PAGE_WIDTH_PT.
  const scale = dispW > MAX_PAGE_WIDTH_PT ? MAX_PAGE_WIDTH_PT / dispW : 1;
  const pageW = Math.round(dispW * scale);
  const pageH = Math.round(dispH * scale);
  const imgMatrix = getOrientationMatrix(orientation, Math.round(imgW * scale), Math.round(imgH * scale));

  const lines = wrapText(fullText, CHARS_PER_LINE);

  // --- Content-Stream: Bild (EXIF-korrekt rotiert) zeichnen, dann unsichtbaren Text drueberlegen ---
  let content = '';
  content += `q ${imgMatrix.join(' ')} cm /Im0 Do Q\n`;
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
