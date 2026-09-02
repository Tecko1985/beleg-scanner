# 📄 Beleg-Scanner

Belege abfotografieren, den Inhalt automatisch auslesen und als durchsuchbares PDF ablegen.

**➡️ [Beleg scannen öffnen](https://tecko1985.github.io/beleg-scanner/)**

> Steht bewusst nicht mehr auf der Kachelübersicht.

## Seiten

| Seite | Wofür |
|---|---|
| [Beleg scannen](https://tecko1985.github.io/beleg-scanner/) | Die eigentliche App: Beleg abfotografieren, auslesen und ablegen |
| [Beleg-Suche](https://tecko1985.github.io/beleg-scanner/search.html) | Begleitseite zum Nachschlagen, erreichbar über die Lupe oben rechts — legt selbst nichts ab |
| [PDF-Testseite](https://tecko1985.github.io/beleg-scanner/test-pdf.html) | Werkbank für die PDF-Erzeugung, kein Teil der App und nicht verlinkt |

## Was die App kann

Ein Beleg wird mit der Handykamera fotografiert, auch mehrseitig. Bereits
digitale PDF-Rechnungen lassen sich stattdessen stapelweise importieren. Inhalt,
Kategorie und Datum werden automatisch erkannt; das Ergebnis landet als
durchsuchbares PDF in Google Drive, einsortiert nach Kategorie. Die Uploads
laufen im Hintergrund, der nächste Beleg kann also sofort gescannt werden. Ist
die Erkennung gerade überlastet, versucht die App es mehrmals erneut, statt den
Vorgang abzubrechen. Die Liste **Vorgänge** zeigt, was gerade läuft, was fertig
ist und was wiederholt werden muss.

Die **Beleg-Suche** durchsucht anschließend den erkannten Text der abgelegten
Belege — nicht nur die Dateinamen —, lässt sich auf Kategorie und Zeitraum
eingrenzen und öffnet einen Treffer direkt als PDF.

## Zugang

Dieses Werkzeug braucht keine Anmeldung über das Vereinskonto. Für das Hochladen
gibt es ein eigenes Upload-Passwort, das einmalig eingegeben und auf dem Gerät
gemerkt wird; geprüft wird es beim Hochladen serverseitig.

## Lokal starten

Über den Eintrag `beleg-scanner` in `E:\.claude\launch.json` — der Server läuft dann auf `http://localhost:8776/`.

## Technik

Vanilla JavaScript ohne Build-Schritt — die Dateien werden so ausgeliefert, wie sie im Repo liegen. Veröffentlicht über GitHub Pages. Eigene Cloudflare-Worker in diesem Repo: `worker.bundle.js`, `worker.js`. Die werden **nicht** über GitHub Pages ausgeliefert, sondern separat bei Cloudflare veröffentlicht.

Der Worker nimmt das Foto entgegen, lässt es von Google Gemini auslesen, baut
daraus über `pdf.js` ein PDF mit unsichtbar hinterlegter Textebene und legt es
über die Google-Drive-API ab. Die Kategorien stehen in `categories.js`.

---

Ein Werkzeug des 1. SC 1911 Heiligenstadt. Alle Werkzeuge auf einen Blick: [Tools-Übersicht](https://sc1911heiligenstadt.github.io/ToolsUebersicht/) · Erklärungen im [Toolbox Wiki](https://sc1911heiligenstadt.github.io/Vereinswiki/).
