# 📄 Beleg-Scanner

Belege abfotografieren, den Inhalt automatisch auslesen und als durchsuchbares PDF ablegen.

**➡️ [Beleg scannen öffnen](https://sc1911heiligenstadt.github.io/beleg-scanner/)**

> Steht bewusst nicht mehr auf der Kachelübersicht.

## Seiten

| Seite | Wofür |
|---|---|
| [Beleg scannen](https://sc1911heiligenstadt.github.io/beleg-scanner/) | Beleg abfotografieren, auslesen und ablegen |
| [Beleg-Suche](https://sc1911heiligenstadt.github.io/beleg-scanner/search.html) | Abgelegte Belege durchsuchen |
| [PDF-Testwerkzeug](https://sc1911heiligenstadt.github.io/beleg-scanner/test-pdf.html) | Testwerkzeug für die PDF-Anzeige — kein Teil der eigentlichen App |

## Zugang

Dieses Werkzeug braucht keine Anmeldung über das Vereinskonto.

## Lokal starten

Über den Eintrag `beleg-scanner` in `E:\.claude\launch.json` — der Server läuft dann auf `http://localhost:8776/`.

## Technik

Vanilla JavaScript ohne Build-Schritt — die Dateien werden so ausgeliefert, wie sie im Repo liegen. Veröffentlicht über GitHub Pages. Eigene Cloudflare-Worker in diesem Repo: `worker.bundle.js`, `worker.js`. Die werden **nicht** über GitHub Pages ausgeliefert, sondern separat bei Cloudflare veröffentlicht.

---

Ein Werkzeug des 1. SC 1911 Heiligenstadt. Alle Werkzeuge auf einen Blick: [Tools-Übersicht](https://sc1911heiligenstadt.github.io/ToolsUebersicht/) · Erklärungen im [Toolbox Wiki](https://sc1911heiligenstadt.github.io/Vereinswiki/).
