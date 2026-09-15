// Testet die reine Parsing-/Filterlogik mit simulierten Tabellenzeilen
// (Zellen-Text-Arrays, wie sie $$eval aus der echten Seite liefern würde).
// Prüft NICHT die Playwright-Navigation - die lässt sich ohne Netzwerkzugriff
// nicht testen.

import assert from 'node:assert/strict';
import { extractRows, isOpen, mondaysAhead } from './scrape.mjs';

// Zeilen nachgebaut aus den PDF-Beispielen des HVNB-Regionsspielplans.
const sampleRows = [
  // Kopfzeile
  ['Tag', 'Datum', 'Zeit', 'Ort', 'Nr.', 'Liga', 'Staffel', 'Heimmannschaft', 'Gastmannschaft'],
  // Mo 14.09.2026 - D-Jugend, kein SR nötig, kein Eintrag -> NICHT offen
  ['Mo', '14.09.2026', '16:00', 'v', '809108', '1', 'ReK', 'WJF', 'WJF VR-5', 'TV Dinklage II', 'TV Dinklage', '0:16'],
  // gleiche Tageszeile fortgesetzt (rowspan) - C-Jugend, kein SR-Eintrag -> offen
  ['16:15', '809140', '3', 'LL', 'MJC', 'Landesliga MJC', 'FC Schüttorf 09', 'HSG Grönegau-Melle'],
  // Erwachsene, SR bereits angesetzt -> NICHT offen
  ['18:45', 'v', '808129', '2', 'LL', 'MJA', 'Landesliga MJA VR Ost', 'VfL Bad Iburg', 'TuS Lemförde', 'Bert./Bert.'],
  // Erwachsene, kein SR -> offen
  ['11:10', '808122', '13', 'ROL', 'M', 'Regionsoberliga M Süd', 'SV Concordia Belm-Powe e.V.', 'THC Westerkappeln'],
  // Vereins-Event / Freundschaftsturnier -> ausgeschlossen
  ['11:30', '803105', '1', 'Vereins-Event', 'MJF', 'Handballturnier', 'SV Dalum 1', 'SG Neuenhaus/Uelsen 1'],
];

const games = extractRows(sampleRows);
console.log('Geparste Spiele:', games.length);
for (const g of games) console.log(' -', g.datum, g.zeit, g.liga, g.altersklasse, g.heim, 'vs', g.gast, '| Erg:', g.ergebnis, '| SR:', g.schiedsrichter);

assert.equal(games.length, 5, 'Es sollten 5 Spielzeilen erkannt werden');

const open = games.filter(isOpen);
console.log('\nOffene Spiele:', open.length);
for (const g of open) console.log(' -', g.datum, g.zeit, g.liga, g.altersklasse, g.heim, 'vs', g.gast);

assert.equal(open.length, 2, 'Es sollten genau 2 offene Spiele erkannt werden (MJC + M)');
assert.ok(open.some((g) => g.altersklasse === 'MJC'));
assert.ok(open.some((g) => g.altersklasse === 'M'));

const weeks = mondaysAhead(3);
assert.equal(weeks.length, 3);
assert.ok(weeks.every((d) => d.getDay() === 1), 'Alle Termine müssen auf einen Montag fallen');

console.log('\nAlle Tests bestanden.');
