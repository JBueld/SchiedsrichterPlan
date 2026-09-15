// Scrapt den Regionsspielplan (nuLiga/WebObjects) des HVNB und findet Spiele,
// die noch keine Schiedsrichter-Ansetzung haben.
//
// Navigation: Die Wochenansicht wird über zwei Radio-Gruppen im Filterformular
// gesteuert (kein Link-Markup, wie ursprünglich angenommen):
//   <input type="radio" name="month" value="0-11">        (0=Januar ... 11=Dezember)
//   <input type="radio" name="dayOfYear" value="N">        (Kalendertag-des-Jahres des
//                                                            Montags der jeweiligen Woche)
// Ein Klick löst "this.form.submit()" aus (volle Seitennavigation, kein AJAX).
// Die Radios sind visuell versteckt (eigenes Styling), weshalb Playwrights
// normale .click()-Aktionierbarkeitsprüfung ("outside viewport") fehlschlägt;
// wir klicken sie daher direkt im DOM per $eval an.
//
// Tabellenstruktur: Jede Zeile hat fix 13 Spalten (nach Auflösung von colspan):
// Tag, Datum, Zeit, Ort, Nr., "Liga Altersklasse" (eine Zelle!), Staffel,
// Heimmannschaft, Gastmannschaft, dann Ergebnis-ODER-Schiedsrichter + Reserve.
// Tag/Datum sind nur in der ersten Zeile eines Tages gefüllt (Folgezeilen leer).
// Bei Spielen ohne Termin ("Termin offen") verschmelzen Tag+Datum per colspan=2
// zu einer Zelle.
//
// Die nuLiga-Seite antwortet vereinzelt mit einer Fehlerseite ("Fehler: Wert
// fehlt") statt der erwarteten Wochenansicht; navigateToWeek() erkennt das und
// versucht es nach einem Neuladen erneut.
//
// Hallenadressen: Der "Ort"-Code jedes Spiels (z.B. "809108") ist nur eine
// interne Hallennummer. Über ein einfaches GET auf locationSearch mit
// searchFor=<Ort-Code> liefert die Seite direkt Hallenname + Anschrift
// zurück (resolveHallAddress). Die Anschrift wird per Nominatim (OSM)
// einmalig geokodiert und in scraper/hallen-cache.json zwischengespeichert,
// damit spätere Läufe bereits bekannte Hallen nicht erneut auflösen/geokodieren
// müssen.

import { chromium } from 'playwright';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BASE_URL =
  'https://hvnb-handball.liga.nu/cgi-bin/WebObjects/nuLigaHBDE.woa/wa/regionMeetingFilter?championship=HRWN+26%2F27';
const LOCATION_SEARCH_URL =
  'https://hvnb-handball.liga.nu/cgi-bin/WebObjects/nuLigaHBDE.woa/wa/locationSearch?federation=HVNB&searchFor=';

// Persistenter Cache: Ort-Code -> Hallenadresse + Koordinaten. Wird committet,
// damit nicht bei jedem CI-Lauf alle Hallen neu aufgelöst/geokodiert werden
// müssen (Nominatim-Nutzungsrichtlinie: sparsam anfragen, Ergebnisse cachen).
const HALLEN_CACHE_FILE = path.join('scraper', 'hallen-cache.json');
const NOMINATIM_USER_AGENT = 'SchiedsrichterPlan (https://github.com/JBueld/SchiedsrichterPlan)';

// Ganze Saison (bis ca. Ende Juni), damit die Wochenend-/Intervallauswahl im
// Frontend genug Auswahl hat - die Daten werden clientseitig gefiltert.
const WEEKS_AHEAD = Number(process.env.WEEKS_AHEAD || 42);
const DEBUG = process.env.DEBUG === '1';
const OUTPUT_FILE = path.join('docs', 'data.json');
const DEBUG_DIR = 'debug';

// Altersklassen, die laut Regelwerk KEINEN Schiedsrichter benötigen
// (D-/E-/F-Jugend). Alles andere (C-/B-/A-Jugend, Erwachsene, Senioren)
// braucht laut Nutzerangabe eine Ansetzung.
const NO_REFEREE_NEEDED = new Set([
  'WJF', 'MJF', 'WJE', 'MJE', 'WJD', 'MJD',
]);

// "Vereins-Event"/"VE" markiert Freundschaftsturniere, die nicht offiziell
// angesetzt werden. "Mini" (Minihandball) braucht ebenfalls keinen SR.
// VL/OL/RL (Verbandsliga/Oberliga/Regionalliga) pfeift der Nutzer grundsätzlich
// nicht - unabhängig von der Altersklasse komplett ausschließen.
const EXCLUDE_LIGA = new Set(['Vereins-Event', 'VE', 'Mini', 'VL', 'OL', 'RL']);

const TABLE_COLUMNS = 13;

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

// Tag-des-Jahres, wie ihn das "dayOfYear"-Radio im Wochenformular erwartet.
// Rein über Date.UTC() berechnet, damit der Sommer-/Winterzeit-Wechsel
// (CET/CEST) keine Off-by-one-Fehler verursacht (lokale Date-Subtraktion
// verliert an der Umstellung eine Stunde).
function dayOfYear(date) {
  const utcStart = Date.UTC(date.getFullYear(), 0, 1);
  const utcDate = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.round((utcDate - utcStart) / 86400000) + 1;
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

async function clickRadioAndWait(page, selector) {
  // Die Radios sind für Sichtprüfungen "outside viewport" (eigenes CSS-Styling),
  // daher direkt im DOM klicken statt page.locator(...).click() zu verwenden.
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle' }),
    page.$eval(selector, (el) => el.click()),
  ]);
}

async function isHealthyCalendarPage(page) {
  return (await page.$('input[name="month"]')) !== null;
}

async function navigateToWeek(page, monday) {
  const monthValue = String(monday.getMonth());
  const targetDay = String(dayOfYear(monday));
  const label = monday.toISOString().slice(0, 10);

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const currentMonth = await page.$eval('input[name="month"]:checked', (el) => el.value).catch(() => null);
      if (currentMonth !== monthValue) {
        await clickRadioAndWait(page, `input[name="month"][value="${monthValue}"]`);
      }

      const weekSelector = `input[name="dayOfYear"][value="${targetDay}"]`;
      const weekRadio = await page.$(weekSelector);
      if (!weekRadio) {
        throw new Error(`Keine Woche mit dayOfYear=${targetDay} (Monat ${monthValue}) gefunden`);
      }
      const alreadyChecked = await page.$eval(weekSelector, (el) => el.checked);
      if (!alreadyChecked) {
        await clickRadioAndWait(page, weekSelector);
      }

      if (await isHealthyCalendarPage(page)) return;
      throw new Error('unerwartete Antwort (keine Kalenderseite)');
    } catch (err) {
      // Egal ob die Seite mit einer WebObjects-Fehlerseite antwortet, ein
      // Selektor mitten im Klick-Ablauf plötzlich fehlt oder die Navigation
      // hängt: der gesamte Versuch zählt als fehlgeschlagen. Wichtig ist,
      // dass wir IMMER frisch von der Basis-URL neu laden, bevor wir es
      // erneut versuchen - sonst hängt die Seite in einem kaputten Zustand
      // fest und jede weitere Woche schlägt kaskadenartig fehl.
      console.warn(`  Woche ${label}: Versuch ${attempt}/3 fehlgeschlagen (${err.message}) - lade neu`);
      await dumpDebug(page, `error-${label}-attempt${attempt}`);
      await page.goto(BASE_URL, { waitUntil: 'networkidle' }).catch(() => {});
    }
  }
  throw new Error(`Woche ${label}: ließ sich nach mehreren Versuchen nicht laden`);
}

function parseScore(text) {
  return /^\d+\s*:\s*\d+$/.test(text.trim());
}

function splitLigaAltersklasse(cell) {
  const idx = cell.indexOf(' ');
  if (idx === -1) return { liga: cell, altersklasse: '' };
  return { liga: cell.slice(0, idx), altersklasse: cell.slice(idx + 1).toUpperCase() };
}

function extractRows(cellRows) {
  const games = [];
  let currentTag = '';
  let currentDatum = '';

  for (const cells of cellRows) {
    const trimmed = cells.map((c) => c.trim());
    if (trimmed.length !== TABLE_COLUMNS) continue; // Fremdzeilen (z.B. Fehlerseiten) überspringen

    let [tag, datum, zeit, ort, , ligaCell, staffel, heim, gast, ...rest] = trimmed;

    if (tag && tag === datum) {
      // Verschmolzene Tag+Datum-Zelle (colspan=2), z.B. "Termin offen".
      datum = tag;
      tag = '';
    }
    if (tag) currentTag = tag;
    if (datum) currentDatum = datum;

    if (!ligaCell || ligaCell === 'Liga' || !heim || !gast) continue; // Kopf-/Leerzeile

    const { liga, altersklasse } = splitLigaAltersklasse(ligaCell);

    let ergebnis = '';
    let schiedsrichter = '';
    for (const raw of rest) {
      if (!raw) continue;
      if (parseScore(raw)) {
        ergebnis = raw;
      } else if (!schiedsrichter) {
        schiedsrichter = raw;
      }
    }

    games.push({
      tag: currentTag,
      datum: currentDatum,
      zeit,
      ort,
      liga,
      altersklasse,
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
  // Zellen einsammeln und dabei colspan auflösen, damit Zeilen wie
  // "Termin offen" (Tag+Datum in einer Zelle) auf die volle Spaltenzahl
  // aufgefüllt werden und nicht die nachfolgenden Spalten verschieben.
  const rows = await page.$$eval('table tr', (trs) =>
    trs.map((tr) => {
      const out = [];
      for (const td of tr.querySelectorAll('td,th')) {
        const text = (td.textContent || '').trim();
        for (let i = 0; i < td.colSpan; i++) out.push(text);
      }
      return out;
    })
  );
  return extractRows(rows);
}

function isOpen(game) {
  if (EXCLUDE_LIGA.has(game.liga)) return false;
  if (game.datum === 'Termin offen') return false; // noch kein Termin -> nicht sinnvoll planbar
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

export {
  extractRows,
  isOpen,
  mondaysAhead,
  parseGermanDate,
  dayOfYear,
  resolveHallAddress,
  geocodeHall,
  resolveHallen,
  loadHallenCache,
  saveHallenCache,
};

async function loadHallenCache() {
  try {
    return JSON.parse(await readFile(HALLEN_CACHE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

async function saveHallenCache(cache) {
  await writeFile(HALLEN_CACHE_FILE, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
}

async function isErrorPage(page) {
  return page.evaluate(() => document.body.textContent.includes('nuLiga - Fehlermeldung'));
}

// Löst einen Ort-Code (z.B. "809108") über die Hallensuche der nuLiga-Seite
// auf. Ein einfaches GET auf locationSearch mit searchFor=<Ort-Code> liefert
// direkt eine result-set-Tabelle mit Hallenname und Anschrift - kein Klicken
// durch das Suchformular nötig.
async function resolveHallAddress(page, ortCode) {
  const url = `${LOCATION_SEARCH_URL}${encodeURIComponent(ortCode)}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.goto(url, { waitUntil: 'networkidle' });
    if (await isErrorPage(page)) {
      console.warn(`  Halle ${ortCode}: unerwartete Antwort (Versuch ${attempt}/3) - versuche erneut`);
      continue;
    }
    const rows = await page.$$eval('table.result-set tr', (trs) =>
      trs.slice(1).map((tr) => {
        const tds = tr.querySelectorAll('td');
        const name = (tds[0]?.textContent || '').replace(/\(\d+\)\s*$/, '').trim();
        const addressCell = tds[1] || null;
        const addressText = addressCell
          ? Array.from(addressCell.childNodes)
              .filter((n) => n.nodeType === Node.TEXT_NODE)
              .map((n) => (n.textContent || '').trim())
              .filter(Boolean)
              .join(', ')
          : '';
        return { name, addressText };
      })
    );
    return rows[0] || null;
  }
  console.warn(`  Halle ${ortCode}: ließ sich nach mehreren Versuchen nicht auflösen`);
  return null;
}

async function geocodeAddress(query) {
  if (!query) return null;
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': NOMINATIM_USER_AGENT } });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.length) return null;
    return { lat: Number(data[0].lat), lon: Number(data[0].lon) };
  } catch {
    return null;
  }
}

async function politeGeocode(query) {
  // Nominatim-Nutzungsrichtlinie: max. 1 Anfrage/Sekunde.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  return geocodeAddress(query);
}

// Ortsteil-Zusätze wie "(OT Mitte)" oder Detailhinweise wie "hinter Halle Nr.
// 806126" stehen zwar auf der nuLiga-Seite, verhindern bei Nominatim aber oft
// einen Treffer für die sonst korrekte Adresse.
function cleanAddressText(addressText) {
  return addressText
    .replace(/\([^)]*\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Manche Straßen/Hallen sind in OpenStreetMap schlicht nicht erfasst. Als
// Fallback wenigstens auf PLZ+Ort geokodieren (Genauigkeit auf Ortsebene
// reicht für eine Umkreis-Suche in km allemal).
async function geocodeHall(addressText) {
  if (!addressText) return null;
  const cleaned = cleanAddressText(addressText);
  const full = await politeGeocode(`${cleaned}, Deutschland`);
  if (full) return full;
  const plzOrt = cleaned.match(/\d{5}\s+.+$/);
  if (plzOrt) {
    return politeGeocode(`${plzOrt[0]}, Deutschland`);
  }
  return null;
}

// Löst alle übergebenen Ort-Codes zu Hallenname/-adresse/-koordinaten auf.
// Bereits im Cache vorhandene Hallen werden übersprungen (weder erneute
// nuLiga-Anfrage noch erneutes Geokodieren).
async function resolveHallen(page, ortCodes, cache) {
  const hallen = {};
  for (const ort of ortCodes) {
    if (cache[ort]) {
      hallen[ort] = cache[ort];
      continue;
    }
    try {
      console.log(`  Halle ${ort}: löse Adresse auf...`);
      const hall = await resolveHallAddress(page, ort);
      if (!hall) {
        console.warn(`  Halle ${ort}: keine Adresse gefunden`);
        continue;
      }
      const coords = await geocodeHall(hall.addressText);
      if (!coords) {
        console.warn(`  Halle ${ort}: Adresse "${hall.addressText}" ließ sich nicht geokodieren`);
      }
      const entry = {
        name: hall.name,
        address: hall.addressText,
        lat: coords?.lat ?? null,
        lon: coords?.lon ?? null,
      };
      cache[ort] = entry;
      hallen[ort] = entry;
    } catch (err) {
      console.error(`  Halle ${ort}: Fehler - ${err.message}`);
    }
  }
  return hallen;
}

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
      // Für die nächste Woche garantiert wieder von einer sauberen Basisseite
      // starten, statt einen eventuell kaputten Zustand mitzuschleppen.
      await page.goto(BASE_URL, { waitUntil: 'networkidle' }).catch(() => {});
    }
  }

  const openGames = [...allGames.values()]
    .filter(isOpen)
    .sort((a, b) => {
      const da = parseGermanDate(a.datum);
      const db = parseGermanDate(b.datum);
      if (da && db && da.getTime() !== db.getTime()) return da - db;
      return (a.zeit || '').localeCompare(b.zeit || '');
    });

  console.log(`Insgesamt ${allGames.size} Spiele gesehen, davon ${openGames.length} offen.`);

  const hallenCache = await loadHallenCache();
  const ortCodes = [...new Set(openGames.map((g) => g.ort).filter(Boolean))];
  const neueHallen = ortCodes.filter((o) => !hallenCache[o]).length;
  console.log(`Löse Hallenadressen für ${ortCodes.length} Hallen auf (${neueHallen} neu)...`);
  const hallen = await resolveHallen(page, ortCodes, hallenCache);
  await saveHallenCache(hallenCache);

  await browser.close();

  await mkdir(path.dirname(OUTPUT_FILE), { recursive: true });
  await writeFile(
    OUTPUT_FILE,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        weeksScanned: weeks.length,
        totalGamesSeen: allGames.size,
        openGames,
        hallen,
      },
      null,
      2
    ),
    'utf8'
  );
  console.log(`Geschrieben: ${OUTPUT_FILE}`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
