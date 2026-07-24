# LipDub SOTA-Plan

Stand: 2026-07-24

## Ziel

Die native LTX-2.3-LipDub-Pipeline soll Sprache, Mundbewegung und Identität so
stabil verbinden, dass sie gegenüber dem bisherigen nativen A2V-Pfad und dem
optionalen LongCat-Mund-Compositing reproduzierbar überlegen ist.

Der SOTA-Claim ist auf einzelne erwachsene Sprecher in deutschen oder
englischen, 2 bis 5 Sekunden langen CFR-Clips bei 24, 25 oder 30 FPS begrenzt:
Frontalansicht bis höchstens 20 Grad Gierwinkel, sichtbarer Mund, keine Musik,
keine zweite Stimme und kein Schnitt. Außerhalb dieser Claim-Domain wird
Abstention erwartet und keine Überlegenheit behauptet.

`10/10` ist erst erreicht, wenn ein unabhängiges Holdout die technischen Gates
und den vorab registrierten Baselinevergleich besteht, die Ergebnisse blind
bewertet wurden und kein High- oder Medium-Reviewbefund offen ist. Ein
einzelner optisch guter Clip ist kein Abnahmenachweis.

Ein Erfolg nur gegen die beiden lokalen Altpfade heißt ausdrücklich
`lokale Produktionsüberlegenheit`, nicht SOTA. Der Status darf erst zu `SOTA`
wechseln, wenn zusätzlich mindestens ein zum Freeze-Zeitpunkt aktueller,
externer Spitzenkomparator mit geklärten Ausführungsrechten oder ein vollständig
benchmark-kompatibler, extern publizierter Referenzarm vorab festgeschrieben und
mit derselben statistischen Regel geschlagen wurde. Solange kein solcher Arm
legal und technisch verfügbar ist, bleibt `SOTA in Arbeit`.

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
- Checkpointfreier klassischer AV-Rohproxy: Audio-Onsets werden mit residualer
  optischer Bewegung einer über Augen und Nase stabilisierten Mundregion über
  `-500` bis `+500 ms` verglichen. Das Lag-Raster entspricht konservativ dem
  effektiven Abstand der untersuchten Videoframes, bei 24 FPS etwa `42 ms`.
  Persistiert werden vorzeichenbehafteter Rohversatz, Peak-Korrelation,
  Peak-Prominenz, Peak-Breite, Audioaktivität und Mundbewegungsabdeckung.
- Der AV-Rohproxy fällt bei statischer Mundregion, zu wenig Sprachstruktur,
  schlechter Trackabdeckung sowie schwachen, breiten oder konkurrierenden Peaks
  auf `insufficient` zurück. Er erzeugt keine LipSync-Note und wird in der
  Oberfläche ausdrücklich als `Rohproxy, Phonem offen` gekennzeichnet.
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

Mindestens fünf kurze Clips werden ausschließlich als feste Entwicklungs- und
Kalibrierfälle geführt:

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

Musik, Übersetzung, mehrere Sprecher, stärkere Profilansichten und lange Clips
sind außerhalb der aktuellen Claim-Domain. Eine spätere SOTA-Aussage dafür
braucht jeweils ein eigenes vorab registriertes Holdout, eigene Strata und
dieselben objektiven sowie menschlichen Freigaberegeln.

Das unberührte Abnahme-Holdout umfasst mindestens 30 in keiner Entwicklungs-
oder Auswahlstufe vorkommende Identitäten mit je drei Clips, also mindestens
90 Clips.
Deutsch/Englisch, 24/25/30 FPS, 65 bis 220 WPM, Geschlecht, Altersgruppen,
Hauttöne, leichte Kopfbewegung und zulässige schwierige Beleuchtung werden als
vorab festgelegte Strata ausgewogen abgedeckt. Alle Clips einer Identität
bleiben in demselben Split.

Identitäten, Sprecher, Quellvideos, Aufnahme-Sessions, Äußerungen sowie
zeitlich, räumlich oder codecseitig abgeleitete Varianten des Holdouts sind aus
Training, Evaluator- und SFace-Kalibration, Schwellenauswahl,
Prompt-/Konfigurationswahl, Baseline-Auswahl und Fehleranalyse ausgeschlossen.
Modelle, Gewichte, Evaluatoren, Gates, Prompts, Seeds, Baselineversionen und
Auswerteskripte werden vor der **ersten** Holdout-Ausführung gehasht und
eingefroren. Jede nachträgliche Änderung entwertet das Holdout und verlangt ein
neues, zuvor unberührtes Set.

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

## Baselinevergleich

Vor Einsicht in das Abnahme-Holdout werden mindestens vier revisions- und
konfigurationsgebundene Arme festgeschrieben:

1. bisheriger nativer LTX-A2V-Pfad;
2. optionaler LongCat-Mund-Compositing-Pfad;
3. der zu prüfende native LTX-2.3-LipDub-Pfad.
4. mindestens ein zum Freeze-Zeitpunkt aktueller, externer Spitzenkomparator
   mit geklärten Ausführungsrechten oder ein exakt benchmark-kompatibler,
   extern publizierter Referenzarm.

Jeder Holdout-Clip wird mit denselben Eingaben und drei vorher festgelegten
Seeds in allen technisch anwendbaren Armen erzeugt. Rater sehen zufällig
sortierte, anonymisierte und lautheitsnormalisierte Paare. Primärendpunkte sind
LipSync-MOS und das Minimum aus Identitäts- und Mundnatur-MOS; beide müssen die
technischen Product-Gates bestehen. Der Kandidat gilt nur dann als überlegen,
wenn gegen **jeden** anwendbaren Baseline- und externen Vergleichsarm die
untere Grenze des sprecherweise
hierarchisch gebootstrappten, Holm-korrigierten 95-%-Konfidenzintervalls
mindestens `+0,50` MOS-Punkte für LipSync und `+0,30` Punkte für den
Identitäts-/Mundnatur-Endpunkt beträgt. Ausfälle und Abstentions werden nach
vorab festgelegter Intention-to-treat-Regel als nicht bestanden gewertet.

Baseline-Versionen, Primärendpunkte, Margen, Strata, Seedliste, Ausschluss- und
Abstentionsregeln sowie Stichprobengröße werden vor dem Holdout gehasht und
versioniert. Die fünf Kalibrierclips und nachträglich ausgewählte Bestläufe
zählen nicht zum Überlegenheitsnachweis.

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
  visuellen Referenz und allen eindeutig verfolgbaren Ausgabeframes;
- checkpointfreie Rohmessung der zeitlichen Audio-Onset-/Mundbewegungskorrelation.

Noch offen sind die für eine belastbare SOTA-Aussage erforderlichen
Evaluatoren:

- rechtlich sauberer, lokal kalibrierter Phonem-/Visem-AV-Sync-Evaluator für
  Inhaltsübereinstimmung, Offset und Synchronitätskonfidenz;
- lokale SFace-Positiv-/Impostor-Kalibrierung für belastbare Grenzbereiche;
- ASR-Abgleich des erzeugten Dialogs;
- bewegungskompensierte Artefakt- und Flimmererkennung.

Für diese drei noch offenen Nachweise gelten vor dem Holdout zusätzlich:

- **SFace:** Der lokal eingefrorene Same-/Impostor-Schwellwert muss auf
  identitätsdisjunkter Kalibration und Holdout eine False-Accept-Rate von
  höchstens `1 %` und False-Reject-Rate von höchstens `5 %` erreichen; pro
  kritischem Pose-/Licht-/Hautton-Stratum höchstens `3 %`/`10 %`. Die obere
  Grenze des sprecherweise gebootstrappten 95-%-Intervalls muss jeden Grenzwert
  ebenfalls einhalten.
- **ASR:** Gegen den eingefrorenen Zieldialog muss die
  normalisierte Wortfehlerrate höchstens `5 %` insgesamt und `10 %` in jedem
  Sprach-/Tempo-Stratum betragen; die oberen 95-%-Bootstrap-Grenzen höchstens
  `6 %` beziehungsweise `12 %`. Namen, Zahlen und Negationen zählen zusätzlich
  als kritische Tokens und müssen zu mindestens `99 %` exakt erhalten bleiben.
- **Artefakt/Flimmern:** Der bewegungskompensierte, auf `[0,1]` normalisierte
  p95-Warp-Residualwert im Hautring um Mund und Nase muss höchstens `0,04`
  insgesamt und `0,06` je Bewegungs-/Licht-Stratum betragen; mindestens `99 %`
  aller Holdout-Frames müssen unter dem jeweiligen Grenzwert liegen. Gegen
  blind menschlich markierte Fremdmund-, Hautwobble-, Nasensprung- und
  Flimmerereignisse muss der Detektor höchstens `1 %` False Accept und `5 %`
  False Reject erreichen, jeweils einschließlich der ungünstigen Seite des
  sprecherweise gebootstrappten 95-%-Intervalls.

Vorverarbeitung, Tokenisierung, kritische Tokenliste, Bewegungswarp,
Hautringmaske, Strata und Bootstrap-Einheit werden zusammen mit den
Evaluatorversionen eingefroren. Unkalibrierte Rohwerte erfüllen keines dieser
Gates.

Das alte Wav2Lip-/Color-SyncNet-Repository ist auf persönlichen,
Forschungs- und nichtkommerziellen Einsatz beschränkt und wird deshalb nicht als
verdeckte Produktionsabhängigkeit eingebaut. Ein AV-Sync-Evaluator wird erst
aktiviert, wenn Code, Gewichte, Vorverarbeitung und Nutzungsrecht separat
gepinnt und dokumentiert sind. Synchformer bleibt ebenfalls `research-only`,
solange die Rechte der mitgelieferten Checkpoints und ihrer MotionFormer-
Bestandteile nicht widerspruchsfrei belegt sind.

Die geprüften fremden Kandidaten und die Produktionsentscheidung sind in
`docs/AV_SYNC_EVALUATOR_RESEARCH.md` dokumentiert. Der derzeit einzige weiter
verfolgte Produktkandidat ist ein eigener SyncNet-artiger Offset-Klassifikator
mit permissiver Implementierung. Auch dieser Weg bleibt bis zum vollständigen
Rechte-, Daten-, Reproduzierbarkeits- und Kalibrationsnachweis ausdrücklich
ohne Produktfreigabe.

Schwellenwerte werden erst anhand von Positiv- und Negativkontrollen auf dieser
Maschine kalibriert. Unkalibrierte Zahlen dürfen keine `10/10`-Freigabe geben.
Die Kalibration trennt Sprecher und Clips strikt in Tune- und Holdout-Sets.
Künstliche Audio-Verschiebungen von mindestens `±40`, `±80`, `±120` und
`±200 ms` liefern kontrollierte Negativfälle. Frames eines Clips zählen nicht
als unabhängige Stichproben.

## Abnahme

Die SOTA-Freigabe verlangt gleichzeitig:

- offizielles LipDub-LoRA vorhanden und vom Modellinventar erkannt;
- alle Referenzgates grün;
- die aktuelle Claim-Domain ist in UI, Model Card und Ergebnisbericht genannt;
- mindestens 30 unabhängige Holdout-Identitäten und 90 Holdout-Clips bestanden;
- der gepaarte Blindvergleich schlägt nativen A2V und LongCat auf beiden
  Primärendpunkten mit den vorab registrierten Überlegenheitsmargen;
- mindestens ein eingefrorener aktueller externer Spitzenkomparator oder
  benchmark-kompatibler externer Referenzarm wird mit derselben Regel
  geschlagen; ohne diesen Punkt lautet der höchste Status nur
  `lokale Produktionsüberlegenheit`;
- keine sichtbare Fremdmundkante oder unnatürliche Gesichtsverformung;
- keine relevante Identitätsabweichung;
- kein wahrnehmbarer Audio-/Video-Versatz;
- Blindbewertung von LipSync, Identität und Mundnatur jeweils mindestens 9/10;
- sowohl der Offset-/Korrespondenzpfad als auch der Phonem-/Visem-Inhaltspfad
  haben ein dokumentiertes Product-GO und bestehen sämtliche quantitativen,
  Stratum-, OOD-, Kalibrations- und Konfidenzintervall-Gates aus
  `docs/AV_SYNC_EVALUATOR_RESEARCH.md`;
- SFace-Verifikation, ASR-Dialogtreue und bewegungskompensierte
  Artefakt-/Flimmerprüfung bestehen ihre oben definierten Gesamt-, Stratum- und
  Konfidenzintervall-Gates;
- beste Einstellungen und Ausgangsmedien vollständig reproduzierbar;
- Build, Lint, Unit-, Medien- und Desktop-/Mobile-E2E-Tests grün;
- unabhängiges Codex-Review ohne offene High-/Medium-Befunde;
- kein fremder DGX-Dienst wurde manuell beendet oder verdrängt.

Bis diese Punkte belegt sind, bleibt der Status `SOTA in Arbeit`.
