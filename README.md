# Beleg-Scanner (v1.0)

Foto vom Handy → Google Gemini (kostenloser Tier) analysiert & kategorisiert → durchsuchbares PDF
→ landet automatisch im richtigen Ordner in Google Drive.

**Live:** https://tecko1985.github.io/beleg-scanner/ (Scan-Seite), [.../search.html](https://tecko1985.github.io/beleg-scanner/search.html) (Suche)

## Struktur

- `index.html` — mobile Scan-Seite (Kamera-Aufnahme, Upload, Ergebnisanzeige). Liegt bewusst im Repo-Root, damit GitHub Pages (Quelle: `master`/`/`) sie direkt als Startseite ausliefert.
- `search.html` — Such-Seite (Freitext + Kategorie-/Jahr-Filter), passwortgeschützt über die GET-`/search`-Route des Workers. Gleiches Hosting wie `index.html`.
- `worker.js` — Cloudflare Worker: Empfängt das Foto, ruft Gemini auf, baut das PDF, lädt es in Google Drive hoch (`POST /`); beantwortet zusätzlich Suchanfragen (`GET /search`).
- `categories.js` — Liste der Kategorien/Ordner (Rechnungen/Hardware-Rechner, Belege, Notar, ...).
- `pdf.js` — erzeugt aus JPEG + erkanntem Text ein durchsuchbares PDF, ohne externe Abhängigkeiten.
- `storage/google-drive.js` — Google-Drive-API-Anbindung (Upload in `Kategorie/Jahr`-Ordner + Suche), austauschbar gegen andere Storage-Provider.
- `test-pdf.html` / `test-sample.jpg` — manuelles Test-Tool für `pdf.js` (kein Teil der eigentlichen App).

## Einmalige Einrichtung

### 0. Gemini-API-Key (kostenlos, für die Bild-Analyse)

1. https://aistudio.google.com/apikey öffnen, mit Google-Account einloggen.
2. "Create API key" klicken, Key kopieren → das ist `GEMINI_API_KEY`.
3. Kostenloser Tier reicht für privaten Gebrauch dauerhaft aus (Rate-Limits liegen weit über dem, was ein paar Belege pro Tag brauchen).

### 1. Google-Cloud-OAuth-Client (für Google-Drive-Zugriff)

1. https://console.cloud.google.com → Projekt anlegen (oder bestehendes wählen), z.B. "Beleg-Scanner".
2. "APIs & Dienste" → "Bibliothek" → **"Google Drive API"** suchen und aktivieren.
3. "APIs & Dienste" → "OAuth-Zustimmungsbildschirm": Nutzertyp "Extern" wählen, App-Name/Support-E-Mail ausfüllen. Unter "Bereiche" reicht `https://www.googleapis.com/auth/drive.file` (Zugriff nur auf vom Worker erstellte Dateien/Ordner). Solange die App im Status "Testing" bleibt, muss dein eigener Google-Account unter "Testnutzer" eingetragen werden.
4. "Anmeldedaten" → "+ Anmeldedaten erstellen" → "OAuth-Client-ID" → Anwendungstyp **"Desktop-App"** (vereinfacht den Consent-Flow im Browser ohne festen Redirect-Host). Name frei wählbar.
5. Erzeugt **Client-ID** (`GOOGLE_CLIENT_ID`) und **Client-Secret** (`GOOGLE_CLIENT_SECRET`) — beide kopieren.
6. Einmaligen Consent-Flow durchführen, um den Refresh-Token zu bekommen:
   - Im Browser öffnen (Client-ID einsetzen, scope `drive.file`):
     `https://accounts.google.com/o/oauth2/v2/auth?client_id=GOOGLE_CLIENT_ID&redirect_uri=http://localhost&response_type=code&scope=https://www.googleapis.com/auth/drive.file&access_type=offline&prompt=consent`
   - Mit deinem Google-Account einloggen, Zugriff erlauben. Du landest auf einer `localhost`-Seite, die nicht lädt — das ist normal, der Code steht in der URL-Adressleiste hinter `?code=...`.
   - Diesen Code gegen einen Refresh-Token eintauschen, z.B. per `curl` oder Postman:
     `POST https://oauth2.googleapis.com/token` mit Body `code=DER_CODE&client_id=GOOGLE_CLIENT_ID&client_secret=GOOGLE_CLIENT_SECRET&redirect_uri=http://localhost&grant_type=authorization_code`
   - In der Antwort steht `refresh_token` → das ist `GOOGLE_REFRESH_TOKEN`.

### 2. Cloudflare Worker deployen

1. Cloudflare-Dashboard → Workers & Pages → Worker erstellen.
2. Code-Editor öffnen, `worker.js` einfügen. Da der Worker `categories.js`, `pdf.js` und `storage/google-drive.js` importiert: im Editor als zusätzliche Dateien anlegen (Module-Worker unterstützen mehrere Dateien). Falls die genutzte Dashboard-Version das nicht anbietet, ersatzweise `worker.bundle.js` (bereits zusammengeführt) 1:1 einfügen.
3. Unter "Settings" → "Variables" als **Secrets** anlegen: `GEMINI_API_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `SEARCH_PASSWORD` (schützt die `/search`-Route, Header `X-Search-Password`) und `UPLOAD_PASSWORD` (schützt den Upload `POST /`, Header `X-Upload-Password`). Beide frei wählbar; für getrennte Rechte unterschiedliche Werte vergeben, sonst einfach denselben. **Wichtig:** Ohne gesetztes `UPLOAD_PASSWORD` sind alle Uploads gesperrt (fail-closed) — das Secret also vor oder mit dem Deploy anlegen.
4. Worker deployen, die zugewiesene `*.workers.dev`-URL kopieren.

### 3. Frontend verbinden & hosten

1. In `index.html` **und** `search.html` die Konstante `WORKER_URL` auf die Worker-URL aus Schritt 2 setzen (beide Seiten halten diesen Wert getrennt, müssen also gemeinsam aktualisiert werden).
2. Beide Seiten liegen im Repo-Root und werden automatisch über GitHub Pages ausgeliefert (Push auf `master`), oder lokal über das Handy im selben Netzwerk aufrufen.

## Hinweise

- Jede Code-Änderung an `worker.js` muss nach dem Push **zusätzlich manuell** im Cloudflare-Dashboard neu deployed werden (kein Auto-Deploy aus dem Git-Repo, wie auch bei sc-heiligenstadt-budget). `worker.bundle.js` muss dabei händisch synchron zu `worker.js`/`storage/google-drive.js`/`categories.js` gehalten werden (kein Build-Schritt).
- Der Text-Layer im PDF liegt nicht pixelgenau über dem Bildinhalt (Gemini liefert nur Volltext, keine Wort-Positionen) — für die Volltextsuche in Google Drive reicht das.
- Kategorien sind in `categories.js` zentral gepflegt und fließen automatisch in den Gemini-Prompt ein — neue Kategorien einfach dort ergänzen. `search.html` hält dafür eine eigene Kopie der Liste (siehe Kommentar dort), die bei Änderungen ebenfalls angepasst werden muss.
- Ablage-Struktur in Google Drive: `Beleg-Scanner/<Kategorie>/<Jahr>/<Datum>_<Absender>_<Grund>.pdf`. Der Betrag steht weiterhin im Analyse-Ergebnis (UI/JSON-Antwort), aber nicht mehr im Dateinamen.
- Die Suche (`GET /search?q=&kategorie=&jahr=`) ist über `SEARCH_PASSWORD` geschützt (Header `X-Search-Password`). Der Upload (`POST /`) ist über `UPLOAD_PASSWORD` geschützt (Header `X-Upload-Password`); `index.html` fragt das Passwort einmalig ab und merkt es sich im `localStorage` des Geräts. Beide Passwort-Prüfungen laufen serverseitig **vor** jedem Google-Zugriff und versagen „nach sicher", falls das jeweilige Secret fehlt.
