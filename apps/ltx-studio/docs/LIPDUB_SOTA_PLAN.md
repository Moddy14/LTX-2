# LipDub SOTA-Plan

Stand: 2026-08-03

Der systemweite Ist-Audit, die Bewertung der Zuständigkeitsgrenzen und der
phasenweise Releaseplan stehen in
[`QUALITY_AUDIT_2026-08-03.md`](./QUALITY_AUDIT_2026-08-03.md). Dieses Dokument
bleibt die detaillierte LipDub-Claim-, Evaluator- und Experiment-Spezifikation.

> **Seither eingetreten** (Details jeweils im Audit, dortige Nachträge):
> Der unter „Aktueller Blocker" geforderte separat evaluierte LipSync-Refiner
> hat mit LipForcing seine erste faire A/B-Evidenz — knapper Sieg in der
> verblindeten Sichtprüfung bei uneindeutiger Metriklage, deshalb weiterhin
> standardmäßig aus. Alle fünf sichtbaren Modi haben zudem einen
> provenienzverifizierten Canary-Lauf (2026-08-05/06). Die Qualitätsgates
> dieses Dokuments bleiben davon unberührt offen.

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

Neue Läufe verwenden das Profil `official-comfy-hq`, das den veröffentlichten
Lightricks-ComfyUI-Workflow nativ abbildet:

- `ltx-2.3-22b-dev.safetensors`
- `ltx-2.3-22b-distilled-lora-384-1.1.safetensors` mit Stärke `0,5`
- `ltx-2.3-spatial-upscaler-x2-1.1.safetensors`
- einen vollständigen Gemma-Root
- `ltx-2.3-22b-ic-lora-lipdub-0.9.safetensors` mit Stärke `1,0`
- ein Referenzvideo mit Video- und Audiospur
- eine explizite Zielsprache und einen Zieltext in deren üblichem Schriftsystem
- genau einen sichtbaren Sprecher

Das Profil verwendet die veröffentlichten Euler-/CFG-1-Schedules, getrennte
Seeds für Stufe 1 und 2 und eine seitenverhältnistreue Ausgabe mit ungefähr
`1920 x 1088` Pixel Gesamtfläche. Alte gespeicherte Jobs werden ausdrücklich
als `native-distilled` migriert und behalten Distilled-Checkpoint sowie
bisherige Auflösung.

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
- LatentSync 1.6 ist als optionaler, standardmäßig deaktivierter
  Audio-Gesichtsrefiner integriert. Der Offline-Container verwendet den
  gepinnten 512er-Checkpoint, die offizielle InsightFace-`buffalo_l`-
  Gesichtserkennung mit 106 Landmarken und eine eigene 24-GiB-
  Orchestrator-Zuteilung innerhalb desselben GUI-Jobs. Die InsightFace-
  Modellgewichte sind nur für nichtkommerzielle Forschung freigegeben; dieser
  Arm ist deshalb zusätzlich zur Qualitätsfreigabe rechtlich nicht
  produktionsfähig.
- MuseTalk 1.5 ist als dritter, standardmäßig deaktivierter Vergleichsarm
  integriert. Der gepinnte Offline-Container verwendet das offizielle
  256-x-256-Latent-Inpainting, Whisper Tiny, SD-VAE und die semantische
  Untergesichtsmaske. Auf ARM64 ersetzt die bereits verifizierte
  InsightFace-106-Ausrichtung ausschließlich den nicht installierbaren
  DWPose-`mmcv`-Pfad. Die finale Datei erhält atomar exakt die Bildzahl,
  Bildrate, Auflösung und Tonspur der LTX-Basis zurück. Der Arm bleibt bis zu
  einem bestandenen P/B/M-, Identitäts- und Mundnaturvergleich ausdrücklich
  aus.
- LatentSync, MuseTalk und LipForcing verwenden exakt die Sprachkonditionierung
  des gewählten Modus: IA2V die auf Start und Maximallänge begrenzte Audiodatei,
  ID-LoRA seinen Referenzton und LipDub die Tonspur des Referenzvideos. Sie wird
  auf die LTX-Dauer gepolstert, steuert den Mund und wird ohne separaten Endmix
  auch zur autoritativen Ausgabetonspur. Ein Musik-/Endmix wird erst nach dem
  Refiner eingebunden. Nur native Dialoggeneration ohne bereitgestellte
  Sprachspur behält ihren gemeinsam generierten Originalton.
- Identische native LTX-Basen können für Refinervergleiche ohne erneuten
  22B-Render übernommen werden. Die Quelle muss abgeschlossen und verifiziert
  sein; Request, Generationsmodelle, Runtime und Identitätsreferenz müssen
  übereinstimmen. Die kopierte Basis wird als eigener SHA-256-gebundener Input
  in die Zielprovenienz aufgenommen und unmittelbar vor dem Refiner erneut
  vollständig geprüft.
- Der kontrollierte Experimentbereich kann LipForcing als einzigen Request-Diff
  einfrieren. Eine bereits vorhandene, unveränderte und provenienzverifizierte
  Ausgabe wird dabei mit Job-ID, Dateikennung, Größe, Revisionszeit und
  Laufprovenienz als Baseline gebunden. So benötigt der Kandidatenarm keinen
  redundanten 22B-Basisrender und kann dennoch keine ausgetauschte Datei als
  Vergleich akzeptieren.
- Eine turnusmäßige Hintergrund-Neuverifikation des Phonem-/Visem-Evaluators
  behält den letzten verifizierten Zustand stabil. Erst ein tatsächlicher
  Prüfungsfehler schaltet fail-closed. Dadurch scheitert die automatische
  Analyse nach langen Rendern nicht mehr an einem kurzlebigen
  `verification-pending`-Fingerprint.
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

Alle vier Generationsassets des offiziellen HQ-Profils sind lokal vorhanden
und SHA-256-verifiziert. Der Blocker ist Ergebnisqualität, nicht Modellzugang.
Die zwei bisherigen 512-x-512-Legacy-Läufe erreichten bei Referenzstärke `1,0`
beziehungsweise `0,8` jeweils `bilabialClosureF1 = 0`. `0,8` verschlechterte
zusätzlich Identität, Mundformkorrelation und Pausenruhe. Deshalb bleibt
Referenzstärke `1,0` der Ausgangspunkt.

Am 30.07.2026 wurden mit Seed `43`, Stufe-2-Seed `42`, Referenzstärke `1,0`,
LipDub-LoRA `1,0`, Distilled-LoRA `0,5`, identischem deutschen P/B/M-Dialog und
deaktiviertem LongCat drei kontrollierte `official-comfy-hq`-Läufe ausgeführt:

| Lauf | Ausgabe | Bilabial-F1 | Öffnungskorrelation | Identität Median / p10 / Minimum |
| --- | --- | ---: | ---: | --- |
| quellengetreu | 896 x 896, 97 Frames, 24 FPS | 0 | 0,222 | 0,895 / 0,859 / 0,832 |
| 30-FPS-Kontrolle | 896 x 896, 121 Frames, 30 FPS | 0 | 0,217 | 0,891 / 0,846 / 0,798 |
| Schärfekontrolle | 1216 x 1216, 97 Frames, 24 FPS | 0,387 | 0,189 | 0,888 / 0,863 / 0,803 |

Alle drei Audiospuren trafen den exakten Dialog mit `0 %` WER. Erst die
1216er-Variante erreichte nach der aktuellen Evaluator-v7-Auswertung überhaupt
teilweise passend liegende Bilabialschlüsse. Frame-für-Frame sind vollständige
Lippenschlüsse sichtbar, sie liegen jedoch nicht verlässlich
auf den erwarteten P/B/M-Zeitfenstern. Die 30-FPS-Konvertierung verschlechterte
den gemessenen Phonemversatz; sie wird deshalb nicht allgemein erzwungen. Die
größere Ausgabe erhöhte die temporale Artikulationsinformation nicht und
unterschritt weiterhin die Schärfeschwelle des Evaluators. Weitere Seed-,
FPS- oder Auflösungsversuche sind ohne neue Konditionierungsinformation nicht
begründet.

Der native Text-Redubbing-Pfad bleibt für verständliche gemeinsame Audio-/
Videogenerierung nutzbar, ist aber kein wortzeitgenauer Phonem-Lipsync. Der
nächste Qualitätsarm muss deshalb eine echte Audio-/Phonemkonditionierung oder
einen separat evaluierten, bewegungsstabilen LipSync-Refiner einführen. Ohne
belegten Bilabialschluss, belastbaren AV-Versatz und bestandene Identitätsgates
bleibt `10/10` ausdrücklich offen.

### LatentSync-1.6-Befund

Am selben 1216-x-1216-P/B/M-Fall wurden die native Basis und vier
LatentSync-Varianten objektiv sowie frameweise verglichen:

| Arm | Bilabial-F1 | Öffnungskorr. | Sprachbewegung | Pausenleck | Schärfe | Identität Median / p10 / Minimum |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| native LTX-Basis | 0,387 | 0,189 | 58,5 % | 25,6 % | 7,51 | 0,888 / 0,863 / 0,803 |
| alter 5-Punkt-Adapter, 30 / 2,0 | 0 | 0,113 | 67,3 % | 23,9 % | 8,76 | 0,866 / 0,831 / 0,730 |
| InsightFace 106 Punkte, 30 / 2,0 vor Zeitachsenfix | 0 | 0,336 | 70,9 % | 15,2 % | 8,65 | 0,866 / 0,828 / 0,728 |
| InsightFace 106 Punkte, 30 / 2,0 mit Zeitachsenfix | 0,581 | 0,321 | 66,0 % | 16,3 % | 9,36 | 0,868 / 0,831 / 0,738 |
| offizieller Default 20 / 1,5 mit Zeitachsenfix | 0,516 | 0,246 | 66,0 % | 16,3 % | 9,34 | 0,867 / 0,839 / 0,777 |

Die offizielle 106-Punkt-Ausrichtung entfernt die sichtbare horizontale
Stirnkante des alten Adapters. Der 25-fps-Zeitachsenfix hebt den
Bilabialschluss deutlich an und beide aktuellen Konfigurationen verbessern die
Ruhe in Sprachpausen. Sie erfüllen die Abnahme trotzdem nicht:

- der beste Bilabial-F1 bleibt mit `0,581` weit von einer zuverlässigen
  Phonemtreue entfernt;
- der klassische AV-Peak besteht das Nullmodell nicht;
- der Identitätsmedian sinkt gegenüber der nativen Basis;
- alle gemessenen Mundschärfen unterschreiten das Inhaltsgate des
  Phonem-/Visem-Evaluators;
- frameweise sind ein überglatter, stärker rosafarbener Mund und unnatürlich
  gespitzte Zwischenformen sichtbar.

Sowohl `30 / 2,0` als auch der offizielle Default `20 / 1,5` sind damit als
Produktionskandidaten verworfen. LatentSync bleibt optional aus; weitere
Parameterläufe sind ohne ein neues Modell oder neue Konditionierungsinformation
nicht begründet.

### MuseTalk- und LipForcing-Befund

MuseTalk 1.5 erhöhte auf der 1024er ID-LoRA-Basis die Öffnungskorrelation nur
von `0,342` auf `0,367`, senkte Bilabial-F1 von `0,452` auf `0,387` und
verschlechterte den Identitätsmedian von `0,861` auf `0,798`. Der sichtbare
Mund ist sauberer begrenzt als beim alten LongCat-Compositing, verändert aber
Gesicht und Lippenform zu stark. Dieser Arm ist als Produktionskandidat
verworfen und bleibt optional aus.

LipForcing 14B bewahrte auf einer 512er IA2V-Basis den Identitätsmedian
praktisch unverändert (`0,884` auf `0,883`) und hob Bilabial-F1 von `0` auf
`0,348`. Gleichzeitig fiel die Öffnungskorrelation von `0,455` auf `0,217`,
das Pausenleck stieg von `23,8 %` auf `28,6 %`, und die Audiospur enthielt in
beiden Armen denselben Whisper-Fehler (`12,5 %` WER). Dieser Lauf ist wegen
anderer Basis, anderem Dialog und der damals noch nicht einheitlichen
Audiofensterbehandlung kein fairer PBM-Vergleich.

Der Audiovertrag ist nun vereinheitlicht und durch Medientests belegt. Der
nächste einzige begründete GPU-Vergleich ist daher LipForcing mit Wan-VAE auf
derselben verifizierten 1024er ID-LoRA-PBM-Basis, demselben sauberen
`Mama/Papa/Mappe`-Audio und unverändertem Seed wie der native Basisarm. Besteht
er Bilabialschluss, Öffnung, Identität, Schärfe und Pausenruhe nicht
gleichzeitig, bleibt auch LipForcing optional aus.

Dieser Vergleich wurde am 02.08.2026 als Experiment
`43ef6ecb-aca9-4ba0-ac34-de5f90ecc1b7` mit Protokoll-Hash
`40af1453a8d3c3945bc3f9dbfc51bf5406951bcf05764c550e375060e70625bc`
eingefroren. Die unveränderte, provenienzgebundene Basis ist
`traumfrau-id-lora-talkvid-pbm-1024-20260730-v01.mp4`; der einzige Request-Diff
ist `postprocess.lipForcing.enabled`. Der Runner hat die vorhandene LTX-Basis
kryptografisch übernommen und beim Orchestrator ausschließlich den
52-GiB-LipForcing-Pass angefordert. Nach mehr als 18 Stunden ohne zulässiges
Ressourcenfenster wurde der Kandidatenjob am 03.08. sauber als `cancelled`
beendet. Die unveränderte Baseline, das eingefrorene Protokoll und die
Versuchshistorie bleiben erhalten; es existiert noch keine Kandidatenausgabe
und damit kein neues Qualitätsergebnis.

### Audit vom 03.08.2026: 25-fps-Eingabedomäne und Orchestrator-Drift

Der gepinnte offizielle LipForcing-Quellcode wurde vollständig gegen das
lokale Containerimage verglichen. Die lokalen Änderungen betreffen nur
`weights_only`, speichersparendes Meta-Loading und den kryptografisch
gebundenen InsightFace-Pfad; der erfolgreiche 14B-Lauf lud alle 1137
Checkpoint-Einträge mit `0 missing` und `0 unexpected`.

Dabei wurde eine echte Integrationsabweichung gefunden: Training und
Audiomerkmale verwenden fest 25 fps, während LTX Studio 24-fps-Videos direkt
an die Gesichtsausrichtung übergab. Beim 97-Frame-Entwicklungsclip wurden die
4,042 Sekunden dadurch intern als nur 3,88 Sekunden Quellbewegung behandelt
und am Ende mit vier Ping-Pong-Frames ergänzt. Der Adapter normalisiert die
Quellbewegung nun vor Face-Alignment und VAE-Encoding auf 25-fps-CFR (101
Frames), führt LipForcing in seiner trainierten Zeitdomäne aus und stellt
anschließend weiterhin exakt 97 Frames bei 24 fps sowie die gewählte saubere
Tonspur wieder her. Ein CPU-Medientest beweist beide Zeitachsen.

Der veröffentlichte 14B-Student ist ausdrücklich für den Zeitplan
`0,999 -> 0,769 -> 0` destilliert. Obwohl die Paper-Ablation einen früheren
Landepunkt als Sync/Fidelity-Regler untersucht, wird `0,833` nicht als
Produktoption auf denselben Gewichten angeboten. Der freigegebene Zeitplan ist
jetzt explizit gepinnt, damit weder ein Upstream-Default noch eine irreführende
GUI-Option die Checkpoint-Semantik verändern kann.

Das eingefrorene Experiment wurde am 03.08. nach mehr als 18 Stunden ohne
Compute beendet. Ursache war kein LTX-Fehler: Die Übergabe vom 24.07 versprach
eine automatische Qwen-Verdrängung, der aktuelle Produktionsvertrag vom
30.07 deaktiviert diesen Pfad ausdrücklich. Mit 52 GiB LipForcing-Profil plus
12 GiB Headroom und 52,7 GiB verfügbarem RAM konnte kein Submit angenommen
werden. Protokoll, Baseline und Kandidatenspezifikation bleiben unverändert
erhalten; ein neuer Kandidatenversuch ist erst nach einem zulässigen
Orchestrator-Fenster sinnvoll.

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
