# R2-Bundle-Implementierungsstand — 11.08.2026

## Urteil

Das statische R2-Gate und der vorregistrierte Cold-Browser-Vergleich sind für
den damaligen Digest bestanden. Spätere Projektworkflow-Änderungen haben die
Digestbindung invalidiert; der aktuelle Engineering-Stand bleibt statisch
grün und muss für den nächsten Finalkandidaten neu gemessen werden.

## Änderung

- Editor, Feldhilfen, Experimente, objektive Analyse, Qualitätskarte und
  Synchronvergleich sind echte dynamische Chunks.
- Die Experimentoberfläche wird erst nach einer ausdrücklichen Nutzeraktion
  geladen. Moduswahl und Laufmonitor bleiben sofort im Entry-Chunk.
- Der Projektworkspace einschließlich Projektabruf, Polling und Mutations-API
  wird ebenfalls erst nach einer ausdrücklichen Nutzeraktion geladen.
- Chunkfehler nach einem Deploywechsel lösen genau einen automatischen Reload
  pro Chunk aus. Schlägt auch dieser Versuch fehl, zeigt eine Error Boundary
  einen sichtbaren, bedienbaren Aktualisierungspfad statt einer leeren UI.
- Das Vite-Warnlimit wurde nicht verändert; es gibt keinen kosmetischen
  manuellen Vendor-Chunk.
- `npm run bundle:report -- --performance-evidence docs/evidence/startup-r2-2026-08-11.json`
  erzeugt aus dem realen `dist` Raw-, gzip- und
  Brotli-Größen sowie eine maschinenlesbare Gateentscheidung.
- `startup:measure` kann eine Rohmessung atomar neu anlegen;
  `startup:compare` prüft Protokoll, Hostprofil, Artefakthash, N und p95 und
  erzeugt den write-once Vergleich. Vorhandene Belege werden nie überschrieben.
- Der finale Bundlebericht akzeptiert eine Releasebindung nur nach vollständiger
  Manifest-/Artefaktprüfung und nennt Release-Digest, Git-Commit und Git-Tree;
  ein bloß übergebenes, ungeprüftes Digest-Label genügt nicht.

## Ergebnis

Der initiale JavaScript-Chunk sank von 533.430/155.280 Bytes raw/gzip auf
388.269/115.561 Bytes. Das entspricht −27,2 % raw und −25,6 % gzip und liegt
klar unter den R2-Grenzen 450.000/140.000 Bytes. Vite baut ohne Chunkwarnung.
Der vollständige Bericht liegt in `docs/evidence/bundle-r2-2026-08-11.json`.

Playwright belegt sowohl den Lazy-Load-Erfolg als auch den zweistufigen
Deployfehlerpfad (ein Reload, danach sichtbarer Fehler mit Aktualisierungs-
Schaltfläche).

## Performance-Abnahme

Basis und Kandidat liefen jeweils in 40 neuen cachefreien Chromium-Kontexten
auf demselben Host mit identischer API-Abbruch-, Viewport- und Readiness-Regel.
Der p95 bis zur ersten sichtbaren Moduswahl sank von 175,42 ms auf 131,58 ms
(-24,99 %), der Median von 138,19 ms auf 117,00 ms (-15,34 %). Tatsächlich
übertragene Bytes sanken von 165.594 auf 158.408 (-4,34 %). Kandidatenstreuung
und Maximum sind ebenfalls kleiner. Browser, Node, Kernel, Hostprofil, N,
Min/Max, Mittelwert, Standardabweichung, Median und p95 sind in
`docs/evidence/startup-r2-2026-08-11.json` gebunden.

Damit waren Größen-, Warnungs-, Lazy-Load-, Deployfehler- und p95-Gate für den
damaligen Digest erfüllt. Für den aktuellen Code gilt bis zur erneuten
Digestbindung **R2 = hold**, nicht still `pass`.
