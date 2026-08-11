# R0-Implementierungsstand — 11.08.2026

## Urteil

Der Control-Plane-Umbau ist als lokaler Releasekandidat implementiert, aber R0
ist noch **nicht abgenommen**. Der laufende Studio-Dienst wurde nicht neu
gestartet und der verpflichtende Live-Canary wurde nicht ausgeführt. Zum
Prüfzeitpunkt war die DGX-Queue leer, der Orchestrator-Snapshot jedoch wegen
83,4 °C und nur 36,7 GiB verfügbarem Speicher auf `warn`. Ein GPU-Start wäre
damit weder aussagekräftig noch vertragskonform gewesen.

## Implementierter Vertrag

- `POST /dgx/scheduler/segment-boundary/decide` ist die einzige
  Scheduling-Wahrheit. Die Antwort wird eng auf Job-ID, eine der vier Actions
  und eine ganzzahlige nichtnegative Retry-Zeit geprüft.
- Der Python-Runner schreibt an jeder tatsächlichen Euler-Grenze atomar
  `boundary-ready.json`. DGX-Job-ID, Run-Fingerprint, Generation, Loop und
  nächster Step bilden die persistierbare Boundary-Identität.
- Node holt erst nach diesem Ready-Signal eine frische Entscheidung und bindet
  `boundary-decision.json` an genau dieselbe Grenze. Stale Generationen oder
  fremde Job-/Run-Bindungen erlauben keinen Weiterlauf.
- `continue_current` wird genau für diese Grenze konsumiert. Bei
  `yield_to_waiting_job`, ungültiger Running-Action, API-/Schemafehler oder
  fehlender Antwort nach zehn Sekunden schreibt Python atomar den bestehenden
  Euler-Checkpoint und endet mit Code 75.
- Ein gewählter Yield setzt den Orchestrator vor dem Checkpoint auf `pausing`.
  Erst nach bestätigtem Prozessende wird `paused` gemeldet.
- Der pausierte Pfad pollt ausschließlich die kanonische Entscheidung:
  `wait_for_successor` bleibt ohne Worker fail-closed pausiert,
  `resume_current` führt über das frische `paused -> resuming`-Start-Gate.
  Dieselbe Orchestrator-Job-ID bleibt über den gesamten Lauf erhalten.
- Die frühere Qwen-Demand-/Idle-Grace-Logik ist aus dem produktiven Schedulerpfad
  entfernt. Das alte lokale `yield-request`-Dateiformat bleibt nur als
  migrationssicherer lokaler Safety-Trigger lesbar.

## Reproduzierbare CPU-Belege

- `npm test`: 59 Dateien, 572 Tests bestanden.
- `npm run lint`: ohne Warnung bestanden.
- `npm run build`: bestanden. Der damals offene Bundle-Hinweis wurde
  anschließend in R2 geschlossen: 388.269 B raw / 115.561 B gzip, ohne
  Vite-Chunkwarnung; siehe `R2_BUNDLE_IMPLEMENTATION_2026-08-11.md`.
- `test_cooperative_checkpoint.py`: 7 Tests bestanden, darunter gebundener
  Continue, Yield, stale Decision und 10-s-Timeoutpfad mit verkürzter Testzeit.
- `git diff --check`: bestanden.

Der Python-Test bestätigt zugleich den bereits bekannten Shared-Environment-
Fehler: `requests` warnt wegen der unzulässigen Kombination mit `chardet 7.4.3`.
Das ist kein neuer R0-Fehler; R1 beseitigt ihn mit der eigenen gelockten
Releaseumgebung.

## Verbleibende R0-Abnahme

1. Negative Reconciliation-Tests für Runtime-API-, Studio- und Runner-Restart
   vervollständigen. Insbesondere darf keine alte Boundary-Entscheidung nach
   einer neuen Generation akzeptiert werden; bei Studio-Shutdown bleibt der
   bestehende fail-closed Terminalisierungspfad maßgeblich.
2. Erst in einem grünen Betreiberfenster den laufenden Dienst kontrolliert auf
   den neuen Commit aktualisieren und `/api/health` erneut prüfen.
3. Einen allowlisteten Wegwerf-Nicht-Qwen-Waiter über normale APIs einreichen
   und `LTX -> Waiter -> LTX` belegen: dieselbe LTX-Job-ID, genau ein Resume,
   keine verwaisten/duplizierten Jobs, beide Records terminal und Checkpoint
   plus Ressourcenfreiheit unter 60 Sekunden.

Bis diese drei Punkte belegt sind, bleibt **R0 = hold** und damit auch
`production_overall` sowie `sota_overall` geschlossen.
