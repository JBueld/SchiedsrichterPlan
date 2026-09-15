# SchiedsrichterPlan

Findet automatisch Spiele im Regionsspielplan **HR West Niedersachsen**
(HVNB, nuLiga), die noch **keinen Schiedsrichter zugeordnet** haben, und
zeigt sie als einfache Übersichtsseite an.

Quelle: https://hvnb-handball.liga.nu/cgi-bin/WebObjects/nuLigaHBDE.woa/wa/regionMeetingFilter?championship=HRWN+26%2F27

## Wie es funktioniert

1. `scraper/scrape.mjs` (Node.js + Playwright) klickt sich durch die
   Wochenansicht der Seite (die Navigation läuft dort über Klicks, nicht
   über die URL) und liest die Spieltabelle für die nächsten
   `WEEKS_AHEAD` Wochen (Standard: 42, also ungefähr die ganze Saison bis
   Ende Juni) aus.
2. Ein Spiel gilt als **offen**, wenn:
   - die Schiedsrichter-Spalte leer ist,
   - das Spiel noch nicht gespielt wurde (kein Ergebnis),
   - ein Termin feststeht (Spiele mit „Termin offen" werden ausgeschlossen),
   - die Altersklasse einen Schiedsrichter benötigt (ab C-Jugend
     aufwärts sowie Erwachsene/Senioren – D-/E-/F-Jugend werden
     ausgeschlossen),
   - es kein reines Vereins-Event/Freundschaftsturnier oder Minihandball ist,
   - die Liga nicht Verbandsliga (VL), Oberliga (OL) oder Regionalliga (RL)
     ist (diese pfeift der Nutzer grundsätzlich nicht; Regionsoberliga/ROL
     bleibt bewusst drin).
3. Für jede offene Halle (Spalte „Ort") wird zusätzlich einmalig die
   Adresse über die Hallensuche der nuLiga-Seite aufgelöst und per
   [Nominatim](https://nominatim.openstreetmap.org/) geokodiert. Das
   Ergebnis landet dauerhaft in `scraper/hallen-cache.json` (wird
   committet), damit spätere Läufe bereits bekannte Hallen nicht erneut
   anfragen müssen.
4. Das Ergebnis landet in `docs/data.json` (offene Spiele + Hallendaten),
   `docs/index.html` zeigt es an – mit Filtern für Zeitraum
   (Woche/Wochenende/eigener Zeitraum), Uhrzeit (von/bis), Altersgruppe
   (Jugend A/B/C vs. Senioren/Erwachsene), Liga (Landesliga/Regionsklasse/
   Regionsliga/Regionsoberliga einzeln abwählbar) und einer Radius-Suche
   (eigener Standort + Umkreis in km, Luftlinie über die geokodierten
   Hallenkoordinaten). Alle Filter werden lokal im Browser gespeichert.
5. Ein GitHub-Actions-Workflow (`.github/workflows/scrape.yml`) führt den
   Scraper alle 6 Stunden automatisch aus und committet die aktualisierten
   Daten (inkl. Hallen-Cache).

## Einmalige Einrichtung

1. **GitHub Pages aktivieren:** Repo-Einstellungen → *Pages* → Source:
   *Deploy from a branch*, Branch: `main` (bzw. der Branch, auf dem dieser
   Code landet), Ordner: `/docs`.
2. Der Workflow läuft geplant (`schedule`) nur, wenn die Workflow-Datei
   auf dem **Default-Branch** liegt. Bis das gemerged ist, lässt er sich
   manuell über *Actions → Offene Spiele aktualisieren → Run workflow*
   starten.

## Bekannte Einschränkung

Die Seite ist ein altes WebObjects/nuLiga-System ohne öffentliche API und
ohne URL-Navigation. Die Monats-/Wochenauswahl läuft über zwei versteckte
Radio-Button-Gruppen (`month`, `dayOfYear`) in einem Formular, das bei
jedem Klick per `this.form.submit()` neu geladen wird; die Tabellenspalten
sind fix (13 Spalten nach Auflösung von `colspan`), aber Liga und
Altersklasse stehen in einer gemeinsamen Zelle (z.B. `"ReK WJF"`).
`scraper/scrape.mjs` ist gegen diese Struktur getestet (inkl. Zeitumstellung
und vereinzelten Sonderfällen wie „Termin offen"-Spielen).

Hallenadressen werden über ein simples GET auf `locationSearch` mit dem
in der Spielplan-Tabelle sichtbaren Hallen-Code (Spalte „Ort") aufgelöst
(`resolveHallAddress` in `scraper/scrape.mjs`) – das liefert direkt Name
und Anschrift, ohne durchs Suchformular klicken zu müssen. Ortsteil-Zusätze
wie „(OT Mitte)" werden vor dem Geokodieren entfernt (verwirren Nominatim);
schlägt die volle Adresse trotzdem fehl, wird ersatzweise nur auf
PLZ+Ort geokodiert (`geocodeHall`).

Die Seite antwortet gelegentlich mit einer WebObjects-Fehlerseite
("Fehler: Wert fehlt") statt der erwarteten Wochenansicht; der Scraper
erkennt das und lädt die betroffene Woche automatisch neu (bis zu 3
Versuche). Sollte sich die Seitenstruktur künftig ändern, zum Debuggen:

- Workflow manuell mit **„debug" = true** starten.
- Das Artefakt `scrape-debug` enthält HTML-Snapshots und Screenshots
  jeder aufgerufenen Woche.
- Diese Snapshots zeigen, woran ein fehlgeschlagener Selektor liegt –
  darauf lässt sich `scraper/scrape.mjs` gezielt anpassen.

## Lokal ausführen

```bash
npm install
npx playwright install --with-deps chromium
DEBUG=1 npm run scrape
```
