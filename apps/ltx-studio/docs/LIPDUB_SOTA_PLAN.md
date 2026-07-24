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
- Persistente 0-bis-10-Scorecard pro Sprachvideo für LipSync, Identität,
  Mundnatur, Hautstabilität, Bewegung und Audio.
- Bewertung und Notiz liegen im geprüften MP4-Sidecar und bleiben auch nach
  Bereinigung der begrenzten Jobhistorie erhalten.
- Bestwert und Einzelbewertungen sind in Auswahl, Jobliste und 2er-Vergleich
  sichtbar.
- Asynchrone CPU-Ausgabeanalyse mit ffprobe und YuNet für den technischen
  Audio-/Videovertrag sowie normalisierte Nasen- und Mundgeometrie.
- Echte CPU-Identitätsmessung mit dem Apache-2.0-lizenzierten OpenCV-SFace-
  FP32-Modell, gepinnt auf Upstream-Revision und SHA-256.
- SFace meldet Referenz-/Ausgabeabdeckung, Median, schlechtestes Dezil,
  Minimum, Referenz-Selbstkonsistenz und zeitliche Ausgabekonsistenz; rohe
  Embeddings werden nie persistiert.
- Ein räumlich-zeitlicher Zieltrack verhindert, dass die Messung bei
  Mehrpersonenbildern pro Frame auf den ähnlichsten Hintergrundakteur springt.
  SFace sowie Nasen- und Mundgeometrie verwenden denselben Track. Inkonsistente
  Referenzidentitäten, Mehrpersonen-Referenzvideos und eine verlorene Zielspur
  ergeben `insufficient`, nicht einen scheinbar guten Mischwert.
- Visuelle Identitätsreferenzen werden vor dem Render über Studio-Asset-ID,
  Größe, mtime, ctime, Inode und SHA-256 gebunden und vor sowie nach der
  Generierung erneut geprüft. Der Analyzer lädt Modelle, Ausgabe und Referenzen
  nur aus verifizierten Lauf-Snapshots. Snapshots sind auf 2 GiB je Datei und
  4 GiB gesamt begrenzt, brauchen zusätzlich 512 MiB freien Restplatz und werden
  serverseitig auch nach Timeout oder Prozessabbruch entfernt. Alte oder externe
  Referenzen ergeben ausdrücklich `reference-provenance-missing`.
- Analysezustand und Rohwerte liegen in einem getrennten, atomisch geschriebenen
  Sidecar und sind an Größe, mtime, ctime, Inode und Studio-Job gebunden.
- Analysequeue, Timeout, Prozessgruppenabbruch, Neustart-Recovery und
  Desktop-/Mobile-Anzeige sind getestet; kein DGX-Modell wird dafür belegt.
- Unzureichende Messungen, VFR, fehlende Audiodauer, fehlende Provenienz und
  fehlende Evaluatorstufen werden ausdrücklich angezeigt. Unkalibrierte
  Rohwerte erzeugen keine automatische Qualitätsnote.
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

Die persistente Scorecard liegt im revisionsgebundenen
MP4-Einstellungs-Sidecar Version 4; ältere Versionen werden bei belegbarer
Job-Provenienz kompatibel gelesen. Der objektive CPU-Evaluatorblock ist
umgesetzt:

- Audio-/Video-Start- und Daueroffset aus den echten Streams;
- Gesichtserkennungs- und Geometrieabdeckung;
- normalisierte Rohwerte für Nasenbewegung, Nasenbeschleunigung,
  Mundwinkel und Mundwinkeldynamik;
- revisionsgebundene SFace-Ähnlichkeiten zwischen der tatsächlich verwendeten
  visuellen Referenz und allen eindeutig verfolgbaren Ausgabeframes.

Noch offen sind die für eine belastbare SOTA-Aussage erforderlichen
Evaluatoren:

- rechtlich sauberer und lokal kalibrierter AV-Sync-Evaluator für Offset und
  Synchronitätskonfidenz;
- lokale SFace-Positiv-/Impostor-Kalibrierung für belastbare Grenzbereiche;
- ASR-Abgleich des erzeugten Dialogs;
- bewegungskompensierte Artefakt- und Flimmererkennung.

Das alte Wav2Lip-/Color-SyncNet-Repository ist auf persönlichen,
Forschungs- und nichtkommerziellen Einsatz beschränkt und wird deshalb nicht als
verdeckte Produktionsabhängigkeit eingebaut. Ein AV-Sync-Evaluator wird erst
aktiviert, wenn Code, Gewichte, Vorverarbeitung und Nutzungsrecht separat
gepinnt und dokumentiert sind. Synchformer bleibt ebenfalls `research-only`,
solange die Rechte der mitgelieferten Checkpoints und ihrer MotionFormer-
Bestandteile nicht widerspruchsfrei belegt sind.

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
