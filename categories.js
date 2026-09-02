// Kategorie-Taxonomie fuer den Beleg-Scanner.
// Wird sowohl im Claude-Vision-Prompt (worker.js) als auch fuer den
// Ablage-Pfad bei der Storage-Abstraktion (storage/google-drive.js) verwendet.
//
// "Sonstiges" ist immer der Fallback, wenn die KI sich nicht sicher ist
// oder kein Kategoriewert aus der Liste zurueckgibt.
//
// ACHTUNG: public/search.html haelt aus Hosting-Gruenden eine eigene Kopie
// dieser Liste (kein Import, um die statische Seite nicht an einen festen
// relativen Pfad zu binden) - bei Aenderungen hier auch dort nachziehen.

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

export { CATEGORIES, FALLBACK_CATEGORY, isValidCategory };
