# Beleg-Scanner

Foto vom Handy → Google Gemini (kostenloser Tier) analysiert & kategorisiert → durchsuchbares PDF
→ landet automatisch im richtigen Ordner in OneDrive.

## Struktur

- `public/index.html` — mobile Scan-Seite (Kamera-Aufnahme, Upload, Ergebnisanzeige). Wird statisch gehostet (z.B. GitHub Pages, wie bei sc-heiligenstadt-budget).
- `worker.js` — Cloudflare Worker: Empfängt das Foto, ruft Gemini auf, baut das PDF, lädt es in OneDrive hoch.
- `categories.js` — Liste der Kategorien/Ordner (Rechnungen/Hardware-Rechner, Belege, Notar, ...).
- `pdf.js` — erzeugt aus JPEG + erkanntem Text ein durchsuchbares PDF, ohne externe Abhängigkeiten.
- `storage/onedrive.js` — Microsoft-Graph-Anbindung, austauschbar gegen andere Storage-Provider.
- `test-pdf.html` / `test-sample.jpg` — manuelles Test-Tool für `pdf.js` (kein Teil der eigentlichen App).

## Einmalige Einrichtung

### 0. Gemini-API-Key (kostenlos, für die Bild-Analyse)

1. https://aistudio.google.com/apikey öffnen, mit Google-Account einloggen.
2. "Create API key" klicken, Key kopieren → das ist `GEMINI_API_KEY`.
3. Kostenloser Tier reicht für privaten Gebrauch dauerhaft aus (Rate-Limits liegen weit über dem, was ein paar Belege pro Tag brauchen).

### 1. Azure-App-Registrierung (für OneDrive-Zugriff)

1. https://portal.azure.com → "App-Registrierungen" → "Neue Registrierung".
2. Name frei wählbar (z.B. "Beleg-Scanner"), Kontotyp "Nur Konten in diesem Organisationsverzeichnis" oder "Persönliche Microsoft-Konten", je nachdem welches OneDrive genutzt wird.
3. Unter "API-Berechtigungen" → "Berechtigung hinzufügen" → "Microsoft Graph" → "Delegierte Berechtigungen" → `Files.ReadWrite` und `offline_access` hinzufügen.
4. Unter "Zertifikate & Geheimnisse" → "Neuer geheimer Clientschlüssel" erzeugen, Wert sofort kopieren (wird nur einmal angezeigt) → das ist `MS_CLIENT_SECRET`.
5. "Übersicht"-Seite → Anwendungs-ID (Client-ID) kopieren → das ist `MS_CLIENT_ID`.
6. Einmaligen Consent-Flow durchführen, um den ersten Refresh-Token zu bekommen (z.B. über den OAuth2-Authorization-Code-Flow im Browser, dann gegen `https://login.microsoftonline.com/common/oauth2/v2.0/token` eintauschen) → Ergebnis ist `MS_REFRESH_TOKEN`.

### 2. Cloudflare Worker deployen

1. Cloudflare-Dashboard → Workers & Pages → Worker erstellen.
2. Code-Editor öffnen, `worker.js` einfügen. Da der Worker `categories.js`, `pdf.js` und `storage/onedrive.js` importiert: im Editor als zusätzliche Dateien anlegen (Module-Worker unterstützen mehrere Dateien). Falls die genutzte Dashboard-Version das nicht anbietet, ersatzweise die drei Dateien manuell in `worker.js` einfügen und die `import`/`export`-Zeilen entfernen.
3. Unter "Settings" → "Variables" als **Secrets** anlegen: `GEMINI_API_KEY`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_REFRESH_TOKEN`.
4. Worker deployen, die zugewiesene `*.workers.dev`-URL kopieren.

### 3. Frontend verbinden & hosten

1. In `public/index.html` die Konstante `WORKER_URL` auf die Worker-URL aus Schritt 2 setzen.
2. `public/index.html` z.B. per GitHub Pages hosten (analog zu `sc-heiligenstadt-budget/beleg-eingang.html`), oder lokal über das Handy im selben Netzwerk aufrufen.

## Hinweise

- Jede Code-Änderung an `worker.js` muss nach dem Push **zusätzlich manuell** im Cloudflare-Dashboard neu deployed werden (kein Auto-Deploy aus dem Git-Repo, wie auch bei sc-heiligenstadt-budget).
- Der Text-Layer im PDF liegt nicht pixelgenau über dem Bildinhalt (Gemini liefert nur Volltext, keine Wort-Positionen) — für die Volltextsuche in OneDrive/Google Drive reicht das.
- Kategorien sind in `categories.js` zentral gepflegt und fließen automatisch in den Gemini-Prompt ein — neue Kategorien einfach dort ergänzen.
