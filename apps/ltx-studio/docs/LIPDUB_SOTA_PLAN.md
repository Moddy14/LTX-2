# LipDub SOTA-Plan

Stand: 2026-07-25

## Ziel

Die native LTX-2.3-LipDub-Pipeline soll textgesteuertes Redubbing,
Mundbewegung und Identität so stabil verbinden, dass sie gegenüber dem
bisherigen nativen A2V-Pfad und dem optionalen LongCat-Mund-Compositing
reproduzierbar überlegen ist. Der offizielle Pfad erzeugt Video und Audio
gemeinsam aus Referenzclip und Zieltext; er nimmt keine separate Ziel-Audiodatei
für wort- und timinggetreuen Audio-Lipsync entgegen.

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
- eine explizite Zielsprache und einen Zieltext in deren üblichem Schriftsystem
- genau einen sichtbaren Sprecher

Frames und FPS kommen ausschließlich aus dem Referenzvideo. Die Pipeline
snappt Frames nach unten auf `8k+1` und kodiert die Ausgabe mit ganzzahliger
Quell-FPS. Deshalb sind konstante 24, 25 oder 30 FPS und eine bereits passende
Framezahl Qualitätsvoraussetzungen.

## Erledigter Unterbau

- Eigener Studio-Modus `LipDub / Text-Redubbing` mit dem nativen CLI-Vertrag.
- Explizite Zielsprache, Ein-Sprecher-Bestätigung und wortgetreuer Zieltext im
  effektiven CLI-Prompt.
- Promptverbesserung im LipDub-Modus standardmäßig aus.
- Genau ein LipDub-IC-LoRA; keine zusätzlichen Stil-LoRAs oder Bilder.
- Modellinventar mit offiziellen Dateinamen und Readiness-Gates.
- Video-/Audio-, Dauer-, FPS-, Frame-, Format- und Zieldialogtempo-Prüfung.
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
- Objektive Analyse Version 4 bindet den Zustand eines eigenen
  Phonem-/Visem-Evaluators samt Evaluator-Fingerprint an jedes Cache-Sidecar.
  Das ausgelieferte Manifest steht im Legal Hold. Ein strukturell gültiger
  `release-candidate` bleibt als `Runner fehlt` blockiert: Dieser Build liest
  keine Multi-GiB-Gewichte synchron im Node-Hauptthread und akzeptiert keine
  selbstbehauptete Rechts- oder Product-GO-Freigabe. Erst ein separater,
  begrenzter Runner darf Modell, Mapping, Dataset-Freeze, signierte
  Rechtsfreigabe sowie Tune-/Holdout-Berichte prüfen und messen.
- Objektive Analyse Version 6 ergänzt einen strikt lokalen, CPU-begrenzten
  Whisper-small-Pfad. Der offizielle Checkpoint, die Python-/Torch-/NumPy-/
  Whisper-/FFmpeg-Laufzeit sowie alle beteiligten Runner werden gehasht. Der
  exakte Dialogtext ist ebenfalls SHA-256-gebunden; Änderungen invalidieren den
  Cache und Änderungen während eines Laufs lassen die Analyse fehlschlagen.
  Persistiert werden freie Transkription, WER mit S/D/I, erkannte Sprache,
  vollständige geführte Wortfenster mit Wahrscheinlichkeiten und Abstention,
  YuNet-Mundtracking in nutzbaren Wortfenstern, Pausenbewegung sowie ein
  nullmodellgeprüfter grober Wortaktivitäts-/Mundbewegungsproxy. Der Runner lädt
  ausschließlich den verifizierten lokalen Pfad und hat keinen Downloadweg.
  Runner-Code bleibt auch bei fehlendem oder ungültigem Checkpoint Bestandteil
  des Cache-Fingerprints. Decoder- und Wort-Tokenlimits werden vor der
  geführten Ausrichtung geprüft und führen kontrolliert zu `insufficient`.
- Der Trainer enthält einen rechtegebundenen, content-adressierten
  **Entwicklungs**-Dataset-Freeze. Er verbindet Sprecher, Gesichtsidentität, Quellasset,
  Sammlung, Session, Äußerung, Ableitung, Rechtequelle, exakte
  Medien-/Featureduplikate, perzeptuelle Duplikate und Parent-Beziehungen zu
  transitiven Leakage-Komponenten. Menschlich verifizierte Phonemzeitachsen,
  Rechtebelege und die im Code versiegelte Preregistrierung werden vor der
  Splitbildung fail-closed geprüft. Video/Audio werden mit gepinnten
  DGX-Binaries reproduzierbar dekodiert; RGB96-Mundtensoren und perzeptuelle
  Fingerprints haben feste Binärschemata. Alle validierten Bytes landen in
  einem portablen SHA-256-CAS. Die stabile Freeze-ID ist von der aktuellen,
  separat geschriebenen Rechteattestation getrennt; der Trainingsloader
  verlangt eine höchstens fünf Minuten alte Attestation.
  `profile=product` bleibt technisch im Product-HOLD, bis
  Signaturprüfung, getrennte Blind-Scorer-ACLs und Release-Attestierungen
  implementiert und unabhängig geprüft sind.
- LongCat bleibt vorhanden, ist aber standardmäßig aus und kein SOTA-Hauptpfad.
- DGX-Queue, Thermalwächter und Wiederanlauf bleiben Teil jedes GPU-Laufs.
- Vollständige Laufprovenienz bindet Eingaben, Generationsmodelle, Codezustand,
  Runtime und verifizierten Zeitpunkt mit SHA-256 an Job und Output-Sidecar.
- Kontrollierte Entwicklungsversuche werden vor dem ersten Lauf als Baseline
  plus genau eine serverseitig angewendete Kandidatenvariable angelegt und
  eingefroren. Der Protokoll-Hash, beide vollständigen Requests, Request- und
  Settings-Hashes, der tatsächliche rekursive Diff und beide Arme werden
  dauerhaft gespeichert.
- Seed-Änderungen sind ausdrücklich Replikate und keine Ablationen. Ablationen
  halten den Seed fest; unbekannte oder zusätzliche Request-Änderungen werden
  serverseitig abgelehnt.
- Das eingefrorene Protokoll wird unmittelbar vor jedem Armstart erneut
  vollständig gehasht. Jeder Queue-Submit trägt eine stabile lokale Job-ID im
  `requested_by`-Wert. Eindeutig nie gestartete Crash-Orphans bleiben
  ungebunden; ein terminal unterbrochener Arm darf erst erneut gestartet
  werden, nachdem die Runtime-Queue unter dieser ID keinen aktiven Job mehr
  meldet. Alle Versuchs-IDs bleiben als Attempt-Historie erhalten.
- Experimentbindung und Request-Hash-Integrität liegen im revisionsgebundenen
  Output-Sidecar Version 6. Baselinefreigabe und A/B-Vergleich funktionieren
  deshalb auch nach Bereinigung der auf 100 Einträge begrenzten Jobhistorie.
- Ein objektiver Vergleich gilt nur für Baseline plus Kandidat desselben
  eingefrorenen Protokolls, exakt den registrierten Request-Diff, identische
  nicht ablatierte Eingaben, Generationsmodelle, Code- und Runtimezustände sowie
  denselben Evaluator-Fingerprint.
- Die Oberfläche normalisiert einen gebundenen Vergleich unabhängig von der
  Klickreihenfolge immer auf Baseline A und Kandidat B. Eine unzureichende
  Gesamtanalyse bleibt bei neutralen Rohdeltas und darf keine grüne oder rote
  Verbesserungsrichtung erzeugen.
- Das Experimentpanel zeigt die eingefrorenen A/B-Werte, Seed, LongCat-Zustand,
  aktuelle RAM-/Swap-/Orchestrator-Startgates und den tatsächlichen
  Phonem-/Visem-Evaluatorblocker. Verifizierte Outputs können gemeinsam
  analysiert und erst danach protokollgeordnet verglichen werden.
- Ein noch nie gestartetes, eingefrorenes Protokoll kann unveränderlich als
  stillgelegt markiert und mit einem bereits eingefrorenen Ersatz verknüpft
  werden. Sein ursprünglicher Protokoll-Hash bleibt erhalten; nach einem
  gebundenen oder versuchten Lauf ist die Stilllegung gesperrt.
- Der Queue-Start behandelt ausschließlich `qwen_gate_active` und begrenzte
  Runtime-API-Transportfehler als vorübergehend. Nach einer verlorenen
  `accepted -> starting`-Antwort wird der Remote-State gelesen; ein bereits
  gestarteter Job wird nicht ein zweites Mal gepatcht. Fremde Konflikte bleiben
  Fehler.

## Aktueller Blocker

Das offizielle gated LipDub-LoRA fehlt lokal:

`/home/moddy/LTX-2.3-max/Lightricks__LTX-2.3-22b-IC-LoRA-LipDub/ltx-2.3-22b-ic-lora-lipdub-0.9.safetensors`

Der Studio-Modellcheck darf diesen Zustand nicht übergehen. Codex akzeptiert
keine Modelllizenz stellvertretend. Nach Freigabe durch den Benutzer darf der
Download ausschließlich über den DGX-Modell- und Orchestratorweg erfolgen.

Die offizielle Repository-Freigabe verlangt, dass der Benutzer bei Hugging Face
angemeldet ist, die Modellbedingungen für
`Lightricks/LTX-2.3-22b-IC-LoRA-LipDub` selbst akzeptiert und anschließend ein
Lesetoken mit Zugriff auf gated Repositories bereitstellt. Die erwartete Datei
ist 2,47 GB groß. Distilled-Checkpoint 1.1 und Spatial Upscaler 1.1 sind lokal
bereits vorhanden.

Zusätzlich ist vor dem ersten offiziellen LipDub-Lauf die lokale Runtime zu
bereinigen: Die editierbaren Pipelinequellen melden 1.1.7, während installierte
Paketmetadaten 1.0.0 melden. Der aktuelle Torch-Build warnt auf dem GB10 zudem
für Compute Capability 12.1 bei offiziell bis 12.0 ausgewiesenem Support. Diese
Drifts sind kein Qualitätsnachweis und müssen durch einen reproduzierbaren
Preflight beziehungsweise einen kompatiblen Runtime-Build geschlossen werden.

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
MP4-Einstellungs-Sidecar Version 6; ältere Versionen werden bei belegbarer
Job-Provenienz kompatibel gelesen. Der objektive CPU-Evaluatorblock ist
umgesetzt:

- Audio-/Video-Start- und Daueroffset aus den echten Streams;
- Gesichtserkennungs- und Geometrieabdeckung;
- normalisierte Rohwerte für Nasenbewegung, Nasenbeschleunigung,
  Mundwinkel und Mundwinkeldynamik;
- vorwärts/rückwärts-konsistente, bewegungskompensierte Rohwerte für
  photometrische Texturinkonsistenz, Helligkeitsflimmern und lokale
  Flussdeformation nach Schätzung der globalen affinen Kopfbewegung aus einer
  breiteren stabilen Gesichtsregion und Ableitung nur auf vollständig gültigen
  3x3-Flow-Nachbarschaften in der Hautzone um Mund und Nase, inklusive echter
  Paarabdeckung über alle Video-Stichproben und p10-Abdeckung der tatsächlich
  konsistent verwertbaren Hautring-Pixel;
- revisionsgebundene SFace-Ähnlichkeiten zwischen der tatsächlich verwendeten
  visuellen Referenz und allen eindeutig verfolgbaren Ausgabeframes;
- checkpointfreie Rohmessung der zeitlichen Audio-Onset-/Mundbewegungskorrelation.
- lokale Whisper-Worttreue mit WER sowie persistierten, wahrscheinlichkeits-
  und hashgebundenen Wortfenstern;
- wortfenstergeführte Mundbewegungs- und Pausenrohwerte mit Abstention.

Noch offen sind die für eine belastbare SOTA-Aussage erforderlichen
Evaluatoren:

- eigene, rechtlich freigegebene und lokal kalibrierte Gewichte sowie der
  CPU-Inferenzrunner für den bereits implementierten
  Phonem-/Visem-AV-Sync-Vertrag;
- lokale SFace-Positiv-/Impostor-Kalibrierung für belastbare Grenzbereiche;
- Kalibration der bewegungskompensierten Artefakt- und Flimmerrohwerte gegen
  blind markierte Fremdmund-, Hautwobble-, Nasensprung- und Flimmerereignisse.

Der Whisper-Zwischenschritt ist umgesetzt. Der reale lokale Kontrolllauf vom
25.07.2026 erkannte acht von acht Wörtern, ersetzte aber `Ton` durch `Turm`
(`12,5 %` WER). Die geführte Ausrichtung isolierte genau `Ton` mit
Wahrscheinlichkeit `0,026`; sieben von acht Wörtern blieben nutzbar. Der
Wortaktivitätsproxy bestand sein zyklisches Nullmodell nicht und gab deshalb
keinen Offset aus. Der Lauf benötigte 12,5 Sekunden, maximal 2,24 GiB RAM,
keine GPU und keine Netzwerksockets. Erst kalibrierte Verschiebungen von `±40`,
`±80`, `±120` und `±200 ms` dürfen daraus eine Timing-Aussage ableiten. Dieser
Pfad ist ausdrücklich kein Phonem-/Visem-Nachweis und erzeugt keine
`10/10`-Freigabe.

Für diese vier noch offenen Nachweise gelten vor dem Holdout zusätzlich:

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
