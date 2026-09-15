// Scrapt den Regionsspielplan (nuLiga/WebObjects) des HVNB und findet Spiele,
// die noch keine Schiedsrichter-Ansetzung haben.
//
// WICHTIG: Diese alte nuLiga-Seite hat keine saubere API. Die Navigation
// (Monat/Woche-Auswahl) läuft über Klicks, nicht über GET-Parameter in der
// URL. Die Selektoren unten basieren auf zwei PDF-Exporten der Seite, nicht
// auf der echten Live-DOM-Struktur (die Sandbox, in der dieses Skript
// geschrieben wurde, hatte keinen Netzwerkzugriff auf die Seite). Bei DEBUG=1
// wird nach jedem Seitenaufruf ein HTML-Snapshot unter debug/ abgelegt, damit
// sich die Selektoren bei Bedarf schnell nachjustieren lassen.

import { chromium } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const BASE_URL =
  'https://hvnb-handball.liga.nu/cgi-bin/WebObjects/nuLigaHBDE.woa/wa/regionMeetingFilter?championship=HRWN+26%2F27';

const WEEKS_AHEAD = Number(process.env.WEEKS_AHEAD || 9);
const DEBUG = process.env.DEBUG === '1';
const OUTPUT_FILE = path.join('docs', 'data.json');
const DEBUG_DIR = 'debug';

const GERMAN_MONTHS = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

// Altersklassen, die laut Regelwerk KEINEN Schiedsrichter benötigen
// (D-/E-/F-Jugend). Alles andere (C-/B-/A-Jugend, Erwachsene, Senioren)
// braucht laut Nutzerangabe eine Ansetzung.
const NO_REFEREE_NEEDED = new Set([
  'WJF', 'MJF', 'WJE', 'MJE', 'WJD', 'MJD',
]);

// Bekannte Liga-Kürzel, wie sie in der ersten Spalte nach der Spielnummer
// auftauchen (ReK, LL, ROL, ReL, OL, VL, RL). "Vereins-Event" markiert
// Freundschaftsturniere, die nicht offiziell angesetzt werden.
const LIGA_CODES = ['ReK', 'LL', 'ROL', 'ReL', 'OL', 'VL', 'RL'];
const EXCLUDE_LIGA = ['Vereins-Event'];

function mondaysAhead(count) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  // Montag der aktuellen Woche finden (getDay(): 0=So,1=Mo,...)
  const dayOfWeek = today.getDay();
  const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const firstMonday = new Date(today);
  firstMonday.setDate(today.getDate() + diffToMonday);

  const mondays = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(firstMonday);
    d.setDate(firstMonday.getDate() + i * 7);
    mondays.push(d);
  }
  return mondays;
}

async function dumpDebug(page, label) {
  if (!DEBUG) return;
  await mkdir(DEBUG_DIR, { recursive: true });
  const safe = label.replace(/[^a-z0-9-_]/gi, '_');
  await writeFile(path.join(DEBUG_DIR, `${safe}.html`), await page.content(), 'utf8');
  try {
    await page.screenshot({ path: path.join(DEBUG_DIR, `${safe}.png`), fullPage: true });
  } catch {
    // Screenshot ist nur Debug-Komfort, kein Abbruchgrund.
  }
}

async function navigateToWeek(page, monday) {
  const monthName = GERMAN_MONTHS[monday.getMonth()];
  const dayNumber = String(monday.getDate());

  // Monat auswählen, falls nicht schon aktiv.
  const monthLink = page.getByRole('link', { name: monthName, exact: true });
  if (await monthLink.count()) {
    await monthLink.first().click();
    await page.waitForLoadState('networkidle').catch(() => {});
  }

  // Innerhalb des Wochen-Kalenders den passenden Tag (Montag) anklicken.
  // Der Tag steht als reine Zahl da; wir suchen bevorzugt nach einem Link.
  const dayCandidates = page.getByRole('link', { name: dayNumber, exact: true });
  const count = await dayCandidates.count();
  if (count === 0) {
    throw new Error(`Kein anklickbarer Tag "${dayNumber}" (${monthName}) gefunden`);
  }
  // Bei mehreren Treffern (z.B. Überlauf-Tage vom Vor-/Folgemonat) den
  // ersten sichtbaren nehmen - im Zweifel wird das per Debug-Snapshot sichtbar.
  await dayCandidates.first().click();
  await page.waitForLoadState('networkidle').catch(() => {});
}

function parseScore(text) {
  return /^\d+\s*:\s*\d+$/.test(text.trim());
}

function extractRows(cellRows) {
  const games = [];
  let currentTag = '';
  let currentDatum = '';

  for (const cells of cellRows) {
    const trimmed = cells.map((c) => c.trim());
    const rowText = trimmed.join(' | ');

    // Tag/Datum stehen wegen rowspan nur in der ersten Zeile eines Tages.
    const datumMatch = rowText.match(/\b(\d{2})\.(\d{2})\.(\d{4})\b/);
    const tagMatch = rowText.match(/\b(Mo|Di|Mi|Do|Fr|Sa|So)\b/);
    if (datumMatch) currentDatum = datumMatch[0];
    if (tagMatch) currentTag = tagMatch[0];
    if (!currentDatum) continue; // noch keine Tageszeile gesehen -> Header o.ä.

    // Liga-Code (und direkt danach die Altersklasse) suchen.
    let ligaIdx = -1;
    let liga = null;
    for (let i = 0; i < trimmed.length; i++) {
      if (LIGA_CODES.includes(trimmed[i]) || EXCLUDE_LIGA.includes(trimmed[i])) {
        ligaIdx = i;
        liga = trimmed[i];
        break;
      }
    }
    if (ligaIdx === -1) continue; // keine Spielzeile (z.B. leere/Kopfzeile)

    const ak = (trimmed[ligaIdx + 1] || '').toUpperCase();
    const staffel = trimmed[ligaIdx + 2] || '';
    const heim = trimmed[ligaIdx + 3] || '';
    const gast = trimmed[ligaIdx + 4] || '';

    // Uhrzeit: erstes hh:mm-Muster VOR dem Liga-Code.
    let zeit = '';
    for (let i = 0; i < ligaIdx; i++) {
      const m = trimmed[i].match(/\b\d{1,2}:\d{2}\b/);
      if (m) {
        zeit = m[0];
        break;
      }
    }

    // Ergebnis/Schiedsrichter: alles nach Gastmannschaft.
    let ergebnis = '';
    let schiedsrichter = '';
    for (const raw of trimmed.slice(ligaIdx + 5)) {
      if (!raw) continue;
      if (parseScore(raw)) {
        ergebnis = raw;
      } else if (!schiedsrichter) {
        schiedsrichter = raw;
      }
    }

    if (!heim || !gast) continue;

    games.push({
      tag: currentTag,
      datum: currentDatum,
      zeit,
      liga,
      altersklasse: ak,
      staffel,
      heim,
      gast,
      ergebnis,
      schiedsrichter,
    });
  }
  return games;
}

async function scrapeCurrentTable(page) {
  // Alle Tabellenzeilen einsammeln und deren Zelltexte zurückgeben.
  const rows = await page.$$eval('table tr', (trs) =>
    trs.map((tr) => Array.from(tr.querySelectorAll('td,th')).map((td) => td.textContent || ''))
  );
  return extractRows(rows);
}

function isOpen(game) {
  if (EXCLUDE_LIGA.includes(game.liga)) return false;
  if (game.ergebnis) return false; // Spiel schon gelaufen
  if (game.schiedsrichter) return false; // schon angesetzt
  if (NO_REFEREE_NEEDED.has(game.altersklasse)) return false; // braucht keinen SR
  return true;
}

function parseGermanDate(datum) {
  const m = datum.match(/(\d{2})\.(\d{2})\.(\d{4})/);
  if (!m) return null;
  return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
}

export { extractRows, isOpen, mondaysAhead, parseGermanDate };

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const allGames = new Map(); // dedupe key -> game

  const weeks = mondaysAhead(WEEKS_AHEAD);
  console.log(`Scrape ${weeks.length} Wochen ab ${weeks[0].toISOString().slice(0, 10)}`);

  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  await dumpDebug(page, 'initial');

  for (const monday of weeks) {
    const label = monday.toISOString().slice(0, 10);
    try {
      await navigateToWeek(page, monday);
      await dumpDebug(page, `week-${label}`);
      const games = await scrapeCurrentTable(page);
      console.log(`  Woche ${label}: ${games.length} Spiele gefunden`);
      for (const g of games) {
        const key = `${g.datum}_${g.zeit}_${g.heim}_${g.gast}`;
        allGames.set(key, g);
      }
    } catch (err) {
      console.error(`  Woche ${label}: Fehler - ${err.message}`);
    }
  }

  await browser.close();

  const openGames = [...allGames.values()]
    .filter(isOpen)
    .sort((a, b) => {
      const da = parseGermanDate(a.datum);
      const db = parseGermanDate(b.datum);
      if (da && db && da.getTime() !== db.getTime()) return da - db;
      return (a.zeit || '').localeCompare(b.zeit || '');
    });

  console.log(`Insgesamt ${allGames.size} Spiele gesehen, davon ${openGames.length} offen.`);

  await mkdir(path.dirname(OUTPUT_FILE), { recursive: true });
  await writeFile(
    OUTPUT_FILE,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        weeksScanned: weeks.length,
        totalGamesSeen: allGames.size,
        openGames,
      },
      null,
      2
    ),
    'utf8'
  );
  console.log(`Geschrieben: ${OUTPUT_FILE}`);
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
