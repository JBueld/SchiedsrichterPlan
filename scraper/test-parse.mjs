// Testet die reine Parsing-/Filterlogik mit simulierten Tabellenzeilen
// (Zellen-Text-Arrays, wie sie $$eval nach Auflösung von colspan aus der
// echten Seite liefern würde - siehe scrape.mjs für die 13-Spalten-Struktur).
// Prüft NICHT die Playwright-Navigation - die lässt sich ohne Netzwerkzugriff
// nicht testen.

import assert from 'node:assert/strict';
import { extractRows, isOpen, mondaysAhead, dayOfYear } from './scrape.mjs';

// Zeilen nachgebaut aus echten Live-Snapshots des HVNB-Regionsspielplans
// (13 Spalten: Tag, Datum, Zeit, Ort, Nr., "Liga Altersklasse", Staffel,
// Heimmannschaft, Gastmannschaft, Ergebnis/Schiedsrichter, Reserve x3).
const sampleRows = [
  // Kopfzeile
  ['Tag', 'Datum', 'Zeit', 'Ort', 'Nr.', 'Liga', 'Staffel', 'Heimmannschaft', 'Gastmannschaft', '', '', '', ''],
  // Mo 14.09.2026 - F-Jugend, kein SR nötig, Spiel bereits gelaufen -> NICHT offen
  ['Mo', '14.09.2026', '16:00', '809108', '1', 'ReK WJF', 'WJF VR-5', 'TV Dinklage II', 'TV Dinklage', '0:16', '', '', ''],
  // gleiche Tageszeile fortgesetzt (Tag/Datum leer) - C-Jugend, kein SR-Eintrag -> offen
  ['', '', '16:15', '809140', '3', 'LL MJC', 'Landesliga MJC', 'FC Schüttorf 09', 'HSG Grönegau-Melle', '', '', '', ''],
  // Erwachsene, SR bereits angesetzt -> NICHT offen
  ['', '', '18:45', '808129', '2', 'LL MJA', 'Landesliga MJA VR Ost', 'VfL Bad Iburg', 'TuS Lemförde', 'Bert./Bert.', '', '', ''],
  // Erwachsene, kein SR -> offen
  ['', '', '11:10', '808122', '13', 'ROL M', 'Regionsoberliga M Süd', 'SV Concordia Belm-Powe e.V.', 'THC Westerkappeln', '', '', '', ''],
  // Vereins-Event / Freundschaftsturnier -> ausgeschlossen
  ['', '', '11:30', '803105', '1', 'Vereins-Event MJF', 'Handballturnier', 'SV Dalum 1', 'SG Neuenhaus/Uelsen 1', '', '', '', ''],
  // Minihandball -> ausgeschlossen (kein SR nötig, kein Altersklassen-Code)
  ['Sa', '19.09.2026', '10:00', '809107', '2', 'Mini', '26.09.2026 Dinklage', 'SFN Vechta II', 'SFN Vechta III', '', '', '', ''],
  // "Termin offen": Tag+Datum per colspan zu einer Zelle verschmolzen -> ausgeschlossen (kein Termin)
  ['Termin offen', 'Termin offen', '', '808146', '8', 'ReK M', 'Regionsklasse M Süd', 'Eickener SpVg II', 'Eickener SpVg III', '', '', '', ''],
  // Verbandsliga -> ausgeschlossen (Nutzer pfeift VL/OL/RL grundsätzlich nicht)
  ['So', '20.09.2026', '17:00', '808134', '9', 'VL M', 'Verbandsliga M West', 'SG Teuto Handball', 'TuS Bramsche', '', '', '', ''],
];

const games = extractRows(sampleRows);
console.log('Geparste Spiele:', games.length);
for (const g of games) console.log(' -', g.datum, g.zeit, g.liga, g.altersklasse, g.heim, 'vs', g.gast, '| Erg:', g.ergebnis, '| SR:', g.schiedsrichter);

assert.equal(games.length, 8, 'Es sollten 8 Spielzeilen erkannt werden');
assert.equal(games[0].ort, '809108', 'Der Ort-Code (Hallennummer) muss erfasst werden');

const open = games.filter(isOpen);
console.log('\nOffene Spiele:', open.length);
for (const g of open) console.log(' -', g.datum, g.zeit, g.liga, g.altersklasse, g.heim, 'vs', g.gast);

assert.equal(open.length, 2, 'Es sollten genau 2 offene Spiele erkannt werden (MJC, ROL M)');
assert.ok(open.some((g) => g.altersklasse === 'MJC'));
assert.ok(open.some((g) => g.altersklasse === 'M' && g.heim === 'SV Concordia Belm-Powe e.V.'));
assert.ok(!open.some((g) => g.liga === 'Vereins-Event'), 'Vereins-Event darf nie offen sein');
assert.ok(!open.some((g) => g.liga === 'Mini'), 'Minihandball darf nie offen sein');
assert.ok(!open.some((g) => g.liga === 'VL'), 'Verbandsliga darf nie offen sein');
assert.ok(!open.some((g) => g.datum === 'Termin offen'), 'Spiele ohne festen Termin dürfen nicht offen sein');

// Zeilen mit abweichender Spaltenzahl (z.B. eine WebObjects-Fehlerseite mit
// eigenem kleinem Tabellenlayout) müssen ignoriert werden, statt Chaos anzurichten.
const malformed = extractRows([['nur', 'zwei']]);
assert.equal(malformed.length, 0, 'Zeilen mit falscher Spaltenzahl müssen übersprungen werden');

const weeks = mondaysAhead(3);
assert.equal(weeks.length, 3);
assert.ok(weeks.every((d) => d.getDay() === 1), 'Alle Termine müssen auf einen Montag fallen');

// Regressionstest für den DST-Fehler (CEST->CET Ende Oktober): rein über
// Date.UTC() berechnet, damit lokale Zeitzonenwechsel keine Off-by-one-Fehler
// verursachen.
assert.equal(dayOfYear(new Date(2026, 8, 14)), 257, 'Sept. 14 2026 muss Tag 257 sein (Referenzwert von der echten Seite)');
assert.equal(dayOfYear(new Date(2027, 0, 4)), 4, 'Jan. 4 2027 muss Tag 4 sein');
assert.equal(dayOfYear(new Date(2026, 9, 26)), 299, 'Okt. 26 2026 (nach der Zeitumstellung) muss Tag 299 sein');

console.log('\nAlle Tests bestanden.');
