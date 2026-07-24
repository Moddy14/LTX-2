# LipDub SOTA-Plan

Stand: 2026-07-24

## Ziel

Die native LTX-2.3-LipDub-Pipeline soll Sprache, Mundbewegung und Identität so
stabil verbinden, dass sie gegenüber dem bisherigen nativen A2V-Pfad und dem
optionalen LongCat-Mund-Compositing reproduzierbar überlegen ist.

`10/10` ist erst erreicht, wenn ein festes Referenzset die technischen Gates
besteht, die Ergebnisse blind bewertet wurden und kein High- oder
Medium-Reviewbefund offen ist. Ein einzelner optisch guter Clip ist kein
Abnahmenachweis.

## Autoritativer Pipeline-Vertrag

Der lokale Code ist maßgeblich:

- `packages/ltx-pipelines/src/ltx_pipelines/lipdub.py`
- `packages/ltx-pipelines/src/ltx_pipelines/utils/args.py`
- `packages/ltx-pipelines/docs/pipelines.md`

Der native LipDub-Pfad benötigt:

- `ltx-2.3-22b-distilled-1.1.safetensors`
- `ltx-2.3-spatial-upscaler-x2-1.1.safetensors`
- einen vollständigen Gemma-Root
- `ltx-2.3-22b-ic-lora-lipdub-0.9.safetensors`
- ein Referenzvideo mit Video- und Audiospur

Frames und FPS kommen ausschließlich aus dem Referenzvideo. Die Pipeline
snappt Frames nach unten auf `8k+1` und kodiert die Ausgabe mit ganzzahliger
Quell-FPS. Deshalb sind konstante 24, 25 oder 30 FPS und eine bereits passende
Framezahl Qualitätsvoraussetzungen.

## Erledigter Unterbau

- Eigener Studio-Modus `LipDub / Lipsync` mit dem nativen CLI-Vertrag.
- Promptverbesserung im LipDub-Modus standardmäßig aus.
- Genau ein LipDub-IC-LoRA; keine zusätzlichen Stil-LoRAs oder Bilder.
- Modellinventar mit offiziellen Dateinamen und Readiness-Gates.
- Video-/Audio-, Dauer-, FPS-, Frame-, Format- und Dialogtempo-Prüfung.
- Strukturierte Referenzdiagnose in der Oberfläche.
- Vorbereitungsweg für H.264, AAC 48 kHz Stereo, CFR und `8k+1`.
- Optionaler, framegenauer 2- bis 5-Sekunden-Kalibrierclip.
- Gemeinsames Video-/Audiofenster mit maximal 40 ms tolerierter Drift.
- Studio-Asset-Grenze für Diagnose und Vorbereitung.
- Einstellungen aus fertigen Videos können vollständig wieder geladen werden.
- LongCat bleibt vorhanden, ist aber standardmäßig aus und kein SOTA-Hauptpfad.
- DGX-Queue, Thermalwächter und Wiederanlauf bleiben Teil jedes GPU-Laufs.

## Aktueller Blocker

Das offizielle gated LipDub-LoRA fehlt lokal:

`/home/moddy/LTX-2.3-max/Lightricks__LTX-2.3-22b-IC-LoRA-LipDub/ltx-2.3-22b-ic-lora-lipdub-0.9.safetensors`

Der Studio-Modellcheck darf diesen Zustand nicht übergehen. Codex akzeptiert
keine Modelllizenz stellvertretend. Nach Freigabe durch den Benutzer darf der
Download ausschließlich über den DGX-Modell- und Orchestratorweg erfolgen.

## Referenzset

Mindestens fünf kurze Clips werden als feste Kalibrierfälle geführt:

1. Frontal, ruhiger Kopf, klare deutsche Sprache.
2. Leichte natürliche Kopfbewegung ohne Profilansicht.
3. Wechsel zwischen geschlossenen und offenen Lauten.
4. Unterschiedliche Sprechgeschwindigkeit innerhalb 65 bis 220 WPM.
5. Schwierige, aber zulässige Beleuchtung ohne Mundverdeckung.

Für jeden Clip gelten:

- ein erwachsener Sprecher;
- Mund und Kiefer während des gesamten Clips sichtbar;
- keine Hände, Haare oder Gegenstände vor dem Mund;
- kein Schnitt und keine starke Bewegungsunschärfe;
- saubere Sprache ohne Musik für die erste Messrunde;
- 2 bis 5 Sekunden, CFR und exakt `8k+1` Frames;
- Audio und Video beginnen gemeinsam und weichen höchstens 40 ms ab.

Musik, Übersetzung, mehrere Sprecher und lange Clips folgen erst, nachdem die
Grundmessung bestanden ist.

## Testmatrix

Zuerst wird nur eine Variable pro Lauf verändert:

| Runde | Variable | Werte |
| --- | --- | --- |
| A | Referenzstärke | 0,80 / 0,90 / 1,00 / 1,10 |
| B | Seed | drei feste Seeds mit der besten Referenzstärke |
| C | Auflösung | referenznahes 64er-Format / nächstgrößeres Format |
| D | Sprache | identischer Wortlaut / neuer gleich langer Wortlaut |
| E | Bewegung | statisch / leichte Kopfbewegung |

Alle übrigen Felder bleiben identisch. Jeder Lauf wird aus der gespeicherten
Jobkonfiguration reproduziert und über die DGX-Queue gestartet.

## Bewertung

Jedes Ergebnis erhält getrennte Bewertungen:

- LipSync: zeitliche Übereinstimmung von Phonem und Mundbewegung.
- Identität: Gesicht, Augen, Nase, Kiefer und Proportionen bleiben erhalten.
- Mundnatur: keine Fremdmundkante, kein schiefer Mund, keine springende Nase.
- Hautstabilität: keine schwabbelige oder flackernde Mundumgebung.
- Bewegung: Kopf- und Gesichtsdynamik bleiben natürlich.
- Audio: verständlich, sauber und ohne Versatz oder Aussetzer.

Die nächste App-Phase ergänzt dafür eine persistente Scorecard pro Job. Später
werden objektive Evaluatoren ergänzt:

- Audio-/Video-Offset und Sync-Konfidenz;
- Identitätsähnlichkeit gegen den Referenzclip;
- Landmark-Stabilität von Mund, Nase und Kiefer;
- ASR-Abgleich des erzeugten Dialogs;
- Artefakt- und Flimmererkennung.

Schwellenwerte werden erst anhand von Positiv- und Negativkontrollen auf dieser
Maschine kalibriert. Unkalibrierte Zahlen dürfen keine `10/10`-Freigabe geben.

## Abnahme

Die SOTA-Freigabe verlangt gleichzeitig:

- offizielles LipDub-LoRA vorhanden und vom Modellinventar erkannt;
- alle Referenzgates grün;
- mindestens fünf Referenzfälle erfolgreich;
- keine sichtbare Fremdmundkante oder unnatürliche Gesichtsverformung;
- keine relevante Identitätsabweichung;
- kein wahrnehmbarer Audio-/Video-Versatz;
- Blindbewertung von LipSync, Identität und Mundnatur jeweils mindestens 9/10;
- beste Einstellungen und Ausgangsmedien vollständig reproduzierbar;
- Build, Lint, Unit-, Medien- und Desktop-/Mobile-E2E-Tests grün;
- unabhängiges Codex-Review ohne offene High-/Medium-Befunde;
- kein fremder DGX-Dienst wurde manuell beendet oder verdrängt.

Bis diese Punkte belegt sind, bleibt der Status `SOTA in Arbeit`.
