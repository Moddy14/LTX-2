# R2-Bundle-Implementierungsstand — 11.08.2026

## Urteil

Das statische R2-Gate ist bestanden; R2 insgesamt bleibt **hold**, bis der
vorregistrierte 40×-Cold-Browservergleich samt p95 ausgewertet ist.

## Änderung

- Editor, Feldhilfen, Experimente, objektive Analyse, Qualitätskarte und
  Synchronvergleich sind echte dynamische Chunks.
- Die Experimentoberfläche wird erst nach einer ausdrücklichen Nutzeraktion
  geladen. Moduswahl und Laufmonitor bleiben sofort im Entry-Chunk.
- Chunkfehler nach einem Deploywechsel lösen genau einen automatischen Reload
  pro Chunk aus. Schlägt auch dieser Versuch fehl, zeigt eine Error Boundary
  einen sichtbaren, bedienbaren Aktualisierungspfad statt einer leeren UI.
- Das Vite-Warnlimit wurde nicht verändert; es gibt keinen kosmetischen
  manuellen Vendor-Chunk.
- `npm run bundle:report` erzeugt aus dem realen `dist` Raw-, gzip- und
  Brotli-Größen sowie eine maschinenlesbare Gateentscheidung.

## Ergebnis

Der initiale JavaScript-Chunk sank von 533.430/155.280 Bytes raw/gzip auf
388.269/115.561 Bytes. Das entspricht −27,2 % raw und −25,6 % gzip und liegt
klar unter den R2-Grenzen 450.000/140.000 Bytes. Vite baut ohne Chunkwarnung.
Der vollständige Bericht liegt in `docs/evidence/bundle-r2-2026-08-11.json`.

Playwright belegt sowohl den Lazy-Load-Erfolg als auch den zweistufigen
Deployfehlerpfad (ein Reload, danach sichtbarer Fehler mit Aktualisierungs-
Schaltfläche).

## Noch offen

Der belastbare Performance-Exit braucht weiterhin je Basis und Kandidat
mindestens 40 neue, cachefreie Chromium-Kontexte auf demselben Hostprofil,
tatsächlich übertragene Bytes sowie Median, p95 und Streuung bis zur ersten
bedienbaren Moduswahl. Ohne diesen Vergleich bleibt **R2 = hold**.
