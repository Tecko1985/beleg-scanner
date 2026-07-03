# beleg-scanner

Foto-zu-PDF-Tool (github.com/Tecko1985/beleg-scanner): Foto vom Handy → Google Gemini analysiert & kategorisiert → durchsuchbares PDF → landet automatisch im richtigen Ordner in Google Drive.

## Struktur

- `worker.js` — Cloudflare Worker (separat deployed, nicht über GitHub Pages), macht die eigentliche Arbeit.
- `index.html` / `search.html` — die zwei statischen Frontend-Seiten (Scan bzw. Suche), liegen an der Repo-Root (GitHub Pages Source = `master:/`).
- `worker.bundle.js` — manuell synchron zu haltende Bundle-Kopie von `worker.js` + `storage/google-drive.js` + `categories.js` fürs Cloudflare-Dashboard (kein Build-Schritt).

## Setup

Erfordert Gemini-API-Key + Google-OAuth-Client (Drive-Zugriff) + Cloudflare-Worker-Secrets (`GEMINI_API_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`) — volle Anleitung in `README.md`. Die Passwörter für Suche/Upload (`SEARCH_PASSWORD`/`UPLOAD_PASSWORD`) sind keine eigenen Secrets mehr, sondern werden per `verify-action-password` an die ToolsUebersicht-Landingpage delegiert (Scopes `belegscanner-suche`/`belegscanner-upload`, Secrets `PW_BELEGSCANNER_SUCHE`/`PW_BELEGSCANNER_UPLOAD` dort).

## Gotcha — GitHub Pages zeigt nur README statt App

**Ursache-Muster:** Wenn die Live-URL nur Doku/Text statt der eigentlichen App zeigt, zuerst `gh api repos/<owner>/<repo>/pages` prüfen (Feld `source.path`) und abgleichen, ob dort wirklich eine `index.html` liegt. Hier lagen die echten Frontend-Seiten ursprünglich unter `public/index.html`/`public/search.html`, aber GitHub Pages war auf Repo-Root konfiguriert — ohne `index.html` im Root rendert GitHub Pages automatisch die `README.md` (Jekyll-Fallback). Gefixt durch `git mv` beider Dateien an die Root (keine relativen Pfade betroffen, `categories.js` bewusst nicht importiert, siehe Kommentar in `search.html`).
