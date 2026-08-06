# LTX Studio: verifizierter 10/10-Audit und Releaseplan

Stand: 2026-08-03. **Fortgeschrieben bis 2026-08-06** — die Zahlen in den
Abschnitten „Urteil" und „Nachweise dieses Audits" sind der Stand vom 03.08.
und werden bewusst nicht rückwirkend überschrieben. Der aktuelle Stand steht
in den datierten Nachträgen am Dokumentende; der jüngste ist
„P1-Canary-Serie und Betriebsbefunde (2026-08-05/06)".

## Urteil

Die vorgeschlagene Trennung zwischen DGX-Orchestrator, LTX Studio und LongCat
ist richtig und für einen stabilen Produktionsbetrieb essentiell. Die App ist
auf der Engineering-Seite bereits weit fortgeschritten, die sichtbare
Lip-Sync-Qualität ist aber noch nicht als SOTA oder 10/10 belegt.

Der aktuelle, ehrliche Status lautet:

- Bedienung, Wiederherstellung, Löschen, kontrollierte A/B-Experimente,
  Provenienz, Queue-Anbindung und CPU-Analyse sind funktionsfähig und breit
  getestet.
- Die offiziellen LTX-2.3-Modelle für die beworbenen Kernpfade sind vorhanden
  und gegen die revisionsgebundene SHA-256-Provenienz verifiziert.
- Der bisher beste lokale Refiner verbessert einzelne Lip-Sync-Rohwerte, hat
  aber Identität oder Mundnatur sichtbar verschlechtert. Er ist deshalb zu
  Recht standardmäßig aus.
- Für den eingefrorenen, fairen LipForcing-Vergleich existiert noch kein
  Kandidatenvideo. Der wartende Kandidatenjob wurde kontrolliert abgebrochen;
  Baseline, Protokoll-Hash und Wiederholbarkeit bleiben erhalten.
- Ein neuer GPU-Lauf ist im aktuellen kritischen DGX-Zustand nicht zulässig.
  Insbesondere der freie Swap liegt unter dem lokalen Health-Ziel. Kein fremder
  Dienst wurde für diesen Audit beendet oder verdrängt.

Der letzte Live-Snapshot dieses Audits meldete `36,67 GiB` verfügbaren RAM,
`0,36 GiB` freien Swap und `80,4 Grad C` Host-Maximum. Die Studio- und
Orchestrator-Queues waren leer. Der aktuelle Orchestrator-Commit
`053efc5e46b0327dc849b5595d35df1146d0bd0e` verriegelt Qwen-Auto-Eviction
zusätzlich hinter Operatorfreigabe und einem nichtkritischen Health-Gate.

## Nachweise dieses Audits

| Bereich | Ergebnis |
| --- | --- |
| Studio Unit-/Integrationstests | 475/475 bestanden |
| Studio Desktop-/Mobile-E2E | 51 bestanden, 1 absichtlicher Desktop-only-Skip |
| Studio ESLint | bestanden, 0 Warnungen |
| Studio Produktionsbuild | bestanden; nur Vites nicht blockierender Chunk-Hinweis |
| Native LTX Python-Suite | 35/35 bestanden |
| Orchestrator Queue-/Lease-/Qwen-Suite | 169/169 bestanden |
| LongCat Supervisor-/Checkpoint-Suite | 134/134 bestanden |
| Offizielle LTX-Kernassets | für ID-LoRA und LipDub-HQ hashverifiziert |
| Aktive Studio-Jobs | keine |
| Eingefrorenes A/B | Baseline erhalten, LipForcing-Kandidat kontrolliert abgebrochen |

Der eingefrorene Versuch
`43ef6ecb-aca9-4ba0-ac34-de5f90ecc1b7` ist an den Protokoll-Hash
`40af1453a8d3c3945bc3f9dbfc51bf5406951bcf05764c550e375060e70625bc`
gebunden. Damit ist der nächste Kandidatenlauf ein echter Wiederholungsversuch
und kein nachträglich veränderter Vergleich.

Die gemeinsame Python-Umgebung meldet weiterhin einen Versionskonflikt von
`requests` zu `urllib3`/`chardet`. Er hat die Tests nicht gebrochen, ist aber
ein Releasebefund: Produktionsrender müssen aus einer gepinnten,
unveränderlichen Laufzeit statt aus der gemeinsam veränderten Comfy-Umgebung
starten.

## Konkreter Qualitätsfund: LipForcing-Zeitbasis

Der offizielle LipForcing-Pfad normalisiert Trainings- und Inferenzvideo auf
25 fps; auch die Audiofeatures rechnen fest mit 25 Videoframes pro Sekunde.
Der lokale Adapter gab zuvor ein 24-fps-Video unverändert an das Modell weiter
und setzte die Quellzeitbasis erst nach der Inferenz wieder ein.

Beim eingefrorenen Test sind das 97 Frames:

- echte Quelldauer: `97 / 24 = 4,0417 s`
- bisherige Modelldauer: `97 / 25 = 3,8800 s`
- Fehler im Modelleingang: `161,7 ms`

Der Adapter erzeugt nun vor der Inferenz ein exaktes 25-fps-CFR-Video. Für
dieselbe Dauer sind das 101 Frames und damit nur noch rund `1,7 ms`
Quantisierungsabweichung. Der strukturelle Zeitfehler sinkt um etwa `99 %`.
Medientests belegen sowohl die 25-fps-Normalisierung als auch die anschließende
frame- und audiogenaue Rückgabe auf die Originalzeitachse.

Außerdem ist die Inferenzfolge explizit auf die zum veröffentlichten
LipForcing-Checkpoint passende Folge `0.999, 0.769, 0.0` gepinnt. Die
Paper-Ablation `0.833` wird nicht als Regler angeboten, weil ein anderer
Zeitschritt ohne dazu trainierte Gewichte kein sauberer Einvariablenversuch
wäre.

Dieser Fix ist ein harter technischer Fortschritt. Ob er die sichtbare
Lip-Sync-Qualität verbessert, entscheidet erst der noch ausstehende,
eingefrorene A/B-Lauf gegen exakt dieselbe LTX-Basis.

## Bisherige Ausgabe-Evidenz

Die folgenden Werte sind Rohmessungen des lokalen Evaluators. Solange dessen
Phonem-/Visem- und Identitätsschwellen nicht am Holdout kalibriert sind, dienen
sie dem relativen Vergleich und sind keine Product-GO-Freigabe.

| Arm | Bilabial-F1 | Öffnungskorrelation | Bewegung in Sprache | Bewegung in Pausen | Identität Median / p10 | Urteil |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Eingefrorene native ID-LoRA-Basis | 0,452 | 0,342 | 0,482 | 0,333 | 0,861 / 0,828 | aktuelle faire Basis |
| MuseTalk auf derselben Basis | 0,387 | 0,367 | 0,500 | 0,286 | 0,798 / 0,762 | Identität klar schlechter; nicht produktionsfähig |
| Offizieller nativer LipDub, 1216-Profil | 0,387 | 0,189 | 0,585 | 0,256 | 0,888 / 0,863 | gute Identität, Sync nicht ausreichend |
| LatentSync-Timelinefix auf diesem LipDub | 0,581 | 0,321 | 0,660 | 0,163 | 0,868 / 0,831 | Sync-Rohwerte besser, Identität und Mundartefakte schlechter |

Beim LatentSync-Paar stieg zusätzlich die Hautflussdeformation von `0,278` auf
`0,402` und das Warp-Residual von `0,026` auf `0,036`. Das deckt sich mit der
visuellen Ablehnung wegen Fremdmund- und Hautartefakten. Die älteren
LipForcing-Werte stammen aus einer anderen IA2V-Basis und wurden außerdem vor
der 25-fps-Korrektur erzeugt; sie sind kein fairer Nachweis für oder gegen den
jetzt eingefrorenen Kandidaten.

Damit ist die Aussage „maximal 5/10“ für die sichtbare Ausgabe mit den
vorhandenen Daten vereinbar. Die Engineering-Reife der App darf nicht als
höhere Videoqualitätsnote ausgegeben werden.

## Bewertung der vorgeschlagenen Zuständigkeiten

### DGX-Orchestrator

Richtig und essentiell: Er besitzt Queue, Prioritäten, Admission, Leases,
Demand, Reclaim/Restore sowie Speicher- und Temperaturpolitik. Er bewertet
keine Videoqualität.

Präzisierung: Qwen ist laut aktuellem Vertrag geschützt und die automatische
Qwen-Druckverdrängung ist live deaktiviert. LTX darf weder Qwen noch fremde
Prozesse selbst stoppen und darf eine Queue-Annahme nicht mit einer
Qualitätsfreigabe verwechseln.

### LTX Studio

Richtig und essentiell: Es besitzt Produktoberfläche, Eingabe- und
Assetprüfung, Modellprofil, Generierung, kontrollierte Experimente,
Qualitätsanalyse, Best-of-N, Retakes und eigene Jobabbrüche. Es darf eigene
Kindprozesse und eigene zugeteilte Container beenden, aber keine fremden
Dienste verwalten.

### LongCat

Im Kern richtig: LongCat besitzt Avatar-, Emotions-, Lip-Sync-, Segment- und
Checkpointlogik. Es muss jedoch für Ressourcen immer dem Orchestratorvertrag
folgen. Die optionale LTX-Integration bleibt standardmäßig aus, bis sie einen
fairen Qualitätsvergleich besteht.

## Korrekturen am vorgeschlagenen Plan

1. **Nicht jedes Asset trägt Version 1.1.** Das Profil muss pro Pipeline an
   den offiziellen Satz gebunden sein. LipDub-HQ verwendet aktuell Dev-
   Checkpoint, Distilled-LoRA 1.1, LipDub-IC-LoRA 0.9 und Spatial-Upscaler 1.1.
   Ein Distilled-FP8-Checkpoint ist kein universeller Ersatz für diesen Satz.
2. **LatentSync ist nur ein Evaluator- und Refinerkandidat.** Der Code ist
   Apache-2.0, die veröffentlichten 1.6-Gewichte stehen jedoch unter
   OpenRAIL++. Code-Lizenz allein ist keine Produktfreigabe. SyncNet misst
   AV-Korrespondenz/Offset, ersetzt aber keinen kalibrierten
   Phonem-/Visem-Inhaltsprüfer.
3. **VBench ist komplementär.** Es misst unter anderem Konsistenz, Flicker,
   Bewegung und Bildqualität, aber nicht allein die korrekte Mundschließung
   bei P/B/M. Es darf kein alleiniges Lip-Sync-Releasegate sein.
4. **MOVA ist kein direkter Fremdaudio-LipDub-Ersatz.** Die offizielle Pipeline
   generiert Video und Audio gemeinsam aus Prompt und Startbild; sie nimmt im
   dokumentierten Hauptpfad keine fertige Zielsprachspur als Driving Audio.
   MOVA gehört deshalb in den Vergleich nativer Sprachgenerierung.
5. **Wan2.2-S2V passt nur nach Canary.** Offiziell werden 480p/720p und für den
   Single-GPU-Pfad mindestens 80 GiB genannt. Auf der DGX mit gemeinsamem
   Speicher ist daraus noch keine sichere Koexistenz abzuleiten. Es braucht
   eine exklusive Lane und reale Peak-Messung.
6. **Das LTX-Scheibchencheckpointing existiert bereits.** Der native LTX-Pfad
   speichert am Diffusionsschritt atomar Latents, Schedule und RNG-Zustand,
   geht ressourcenfrei auf `paused` und holt vor Resume neue Admission. Offen
   sind die 20 Live-Zyklen und die p95-Messung, nicht die Grundimplementierung.
7. **30 eigene plus 10 YouTube-Fälle sind keine automatische SOTA-Evidenz.**
   Eigene/consentierte Daten müssen in disjunkte Tune- und Holdout-Sets
   getrennt werden. YouTube darf nur mit geklärten Rechten und vorzugsweise
   als blindes externes Ziel dienen, nicht als stilles Trainingsmaterial.
8. **WER beweist Texttreue, nicht Lip-Sync.** AV-Offset, WER, Identität,
   Visemkorrektheit und Mundartefakte bleiben getrennte Gates.

## Verbindlicher 10/10-Plan

### P0: Reproduzierbare Releasebasis

- LTX-Code aus dem großen schmutzigen Arbeitsbaum nach Verantwortung in
  geprüfte Commits teilen; generierte Videos, Telemetrie und lokale Secrets
  gehören nicht in einen Releasecommit.
- Studio und Renderer aus einer unveränderlichen Revision oder einem
  digest-gepinnten Container starten. Laufprovenienz muss diesen Digest binden.
- Die gemeinsame Python-Laufzeit durch einen Lockfile-/Container-Build mit
  exakt gepinnten Versionen ersetzen.
- Orchestrator-, LTX- und LongCat-Änderungen getrennt releasen; die App darf
  fremde Worktrees weder committen noch bereinigen.
- Release erst bei global gesundem DGX-Gate: kein `critical`, Swap am lokalen
  SOTA-Ziel von mindestens 8 GiB frei und alle bekannten Warnungen entschieden.

**Exit:** Clean Release-Digests, reproduzierbarer Cold Start, alle oben
genannten Tests grün und keine offene High-/Medium-Reviewfeststellung.

### P1: Ehrliche, vollständige Modi

- Eine Capability-Matrix bindet jeden sichtbaren Modus an exakte Dateinamen,
  Revisionen, SHA-256, Loader und Laufzeitprofil.
- Pro Modus je ein Cold- und Warm-Canary. Nicht bestandene Modi werden in der
  UI deaktiviert und nennen in normaler Sprache die konkrete Abhilfe.
- Offizieller LTX-HQ-Pfad bleibt Two-Stage. Fast/Distilled und FP8 sind eigene
  Profile mit eigener Qualitätsfreigabe, keine stillen Ersetzungen.
- ComfyUI- und native Pfade dürfen dasselbe Label nur tragen, wenn ihre
  Konditionierung und Assetbindung nachweislich gleich sind.

**Exit:** Jeder sichtbare Modus erzeugt aus einer frischen Releaseumgebung ein
spielbares, analysierbares Video und besteht seine Asset-/Provenienzgates.

### P2: Objektive Qualitätsstrecke

- Goldsatz nach Claim-Domain aufbauen: mindestens 30 holdout-exklusive
  erwachsene Identitäten und mehrere Clips je Identität, mit Deutsch/
  Englisch, P/B/M, Frikativen, Pausen, Tempo, Musik-Endmix, leichter
  Kopfbewegung, Verdeckung und OOD-Abstention.
- Tune, internes Holdout und externes Blindset auf Identitäts- und
  Quellassetebene strikt trennen; Protokoll vor Einsicht in das Holdout hashen.
- SFace gegen echte Same-/Impostor-Paare kalibrieren. Das Ziel
  `TAR >= 95 % bei FAR <= 1 %` ist sinnvoll, aber nur mit ausreichend großen
  Paarzahlen, Identitätsdisjunktheit, Strata und Konfidenzintervallen.
- Einen rechtlich freigegebenen, hashgebundenen AV-Offset/Korrespondenzprüfer
  und einen getrennten Phonem-/Visemprüfer betreiben. Für P/B/M werden
  Mundschlusszeit, Closure-Recall, falsche Schließungen und Timing relativ zum
  Phonem gemessen; Schwellen werden am Tune-Set festgelegt, nicht geraten.
- VBench 2.0 für Bild-/Bewegungskonsistenz ergänzen. Menschlich markierte
  Fremdmund-, Hautwobble-, schiefer-Mund-, Nasensprung- und Flimmerereignisse
  bleiben ein eigener kalibrierter Artefaktpfad.
- Blinde menschliche MOS-Bewertung mit zufälliger Armreihenfolge,
  Lautheitsnormalisierung und identitätsweise gebootstrappten Intervallen.

**Exit:** Evaluatoren unterscheiden kontrollierte Positiv- und Negativfälle,
abstainieren bei unbrauchbaren Inputs und bestehen ein unangetastetes Holdout.

### P3: Aufgabenbezogener Modell-Bake-off

- **Native Sprache:** LTX IA2V/ID-LoRA gegen MOVA.
- **Driving Audio / Portrait:** LTX IA2V/ID-LoRA gegen LongCat 1.5 und
  Wan2.2-S2V.
- **Referenzvideo-Redubbing:** LTX LipDub nativ gegen LipForcing sowie nur
  rechtlich und technisch freigegebene Refiner.
- Alle Arme erhalten dieselben zulässigen Eingaben, feste Seeds und dieselbe
  Ausgabezeitachse. Nicht vergleichbare Eingabeverträge werden nicht in einen
  gemeinsamen Score gemischt.
- LatentSync, MuseTalk, LongCat-Mundcompositing und LipForcing bleiben einzeln
  schaltbar und standardmäßig aus. Ein Refiner wird nur automatisch gewählt,
  wenn Lip-Sync besser wird und Identität, Mundnatur und Hautstabilität ihre
  Nichtunterlegenheitsgates halten.

**Exit:** Pro Aufgabentyp existiert ein statistisch belegter Gewinner oder eine
klare Abstention; kein Modell wird aus Markenvertrauen zum Universalpfad.

### P4: Produktionsworkflow

- Vier feste Seeds günstig als Draft erzeugen, objektiv vorsortieren und nur
  die besten HQ fortsetzen. Zuvor muss auf dem Goldsatz belegt werden, dass das
  Draft-Ranking mit dem HQ-Ranking korreliert; sonst spart es Kosten, wählt
  aber den falschen Kandidaten.
- Clean Vocals konditionieren; Musik und finalen Mix erst nach dem
  Lip-Sync-Pfad remuxen. Dieser Pfad ist im Studio bereits implementiert und
  E2E-getestet.
- Langvideo als kontrollierte 4- bis 8-Sekunden-Shots mit Continuity-Bindung,
  Retakes und abschließendem Master behandeln.
- Retakes gezielt auf fehlerhafte Wort-/Shotfenster anwenden statt jedes Mal
  das gesamte Video neu zu erzeugen.

**Exit:** Ein reproduzierbarer Auftrag liefert Master, Sidecars, Scorecard,
verwendete Einstellungen und gezielte Retake-Historie ohne manuelle
Dateiarbeit.

### P5: Kooperative Ressourcensteuerung

- LTX: 20 reale Zyklen `Render -> Qwen-Demand -> atomarer Checkpoint -> paused
  und ressourcenfrei -> Qwen bereit -> neue Admission -> identischer Resume`.
- Pro Zyklus werden Pause-Latenz, freigegebener Speicher, Checkpoint-Hash,
  Resume-Latenz, Ausgabegleichheit und Fehlerzustand gespeichert. Ziel bleibt
  `paused und ressourcenfrei p95 < 60 s`.
- LongCat: reale Dauer eines Segments und eines einzelnen CUDA-Schritts messen;
  erst danach entscheiden, ob Checkpoints tiefer in den Denoising-Loop müssen.
- Ist ein unteilbarer GPU-Schritt im p95 länger als das SLO, kann Software ihn
  nicht sicher mitten im Kernel unterbrechen. Erst dann ist getrennte
  Qwen-Kapazität architektonisch zwingend.

**Exit:** 20/20 Zyklen ohne verlorenen Job, beschädigten Output, manuellen
Dienststopp oder unautorisierten Restore.

## 10/10-Abnahme

`10/10` darf nur gesetzt werden, wenn alle Punkte gleichzeitig belegt sind:

- Jeder sichtbare Modus besteht Cold- und Warm-Canary aus dem Release-Digest.
- 50-Job-Soak über Modi, Cancel, Neustart, Queue-Wartezeit und Thermalabbruch
  ohne verlorenen Job oder beschädigten Output.
- 20/20 kooperative Qwen-Pause/Resume-Zyklen bestehen.
- AV-Offset p95 höchstens 80 ms, gemessen mit einem gegen künstliche Offsets
  kalibrierten unabhängigen Evaluator; die Messkonfidenz muss genügen.
- Deutsche Dialog-WER höchstens 5 %, kritische Namen/Zahlen/Negationen mit
  eigener strengeren Worttreue. Das ist nur das Textgate.
- P/B/M- und weitere Visemgates bestehen die vorab kalibrierten
  Closure-/Timing-Schwellen; Mundbewegung in Pausen bleibt unter dem
  kalibrierten Grenzwert.
- Identitätsgate erreicht mindestens 95 % True Accept bei höchstens 1 %
  False Accept auf einem ausreichend großen, identitätsdisjunkten Holdout.
- VBench liegt je Aufgabentyp mindestens auf Referenzniveau, ohne dass ein
  Lip-Sync-, Identitäts- oder Artefaktgate dadurch ersetzt wird.
- Verblindete menschliche A/B-Abnahme gegen vorab festgelegte externe Ziele
  erreicht die registrierten Überlegenheits- oder Nichtunterlegenheitsmargen.
- Kein warn- oder critical-Freigabeloch im maßgeblichen Health-/Releasegate;
  keine offene High-/Medium-Feststellung.

Ohne externen Spitzenkomparator lautet der höchste ehrliche Status
`lokale Produktionsüberlegenheit`, nicht SOTA. Ein einzelnes gutes Video oder
ein guter AV-Proxy reicht nicht für 10/10.

## Nächster beweisender Lauf

Sobald der Orchestrator einen gesunden Zustand und frische Admission meldet:

1. Den eingefrorenen LipForcing-Kandidaten erneut starten, ohne die Baseline zu
   rendern und ohne eine weitere Requestvariable zu ändern.
2. Vor Inferenz den 25-fps-CFR-Vertrag und die gebundene Audiospur im
   Provenienzsidecar belegen.
3. Baseline und Kandidat automatisch auf P/B/M, AV-Offset, Pausenbewegung,
   Identität, Hautfluss, Mundwinkel und Bildschärfe vergleichen.
4. Blind visuell prüfen. Bei besserem Sync, aber schlechterer Identität oder
   Mundnatur wird der Kandidat verworfen, nicht schöngerechnet.
5. Ergebnis und Protokoll-Hash als erste faire LipForcing-A/B-Evidenz sichern.

Bis dahin ist der mathematisch und per Medientest belegte 25-fps-Fix ein
Fortschrittsnachweis für den Pipelinevertrag, aber noch kein visueller
Qualitätssieg.

## Erste faire LipForcing-A/B-Evidenz (2026-08-04)

Der eingefrorene Kandidat (Experiment `43ef6ecb…`, Protokoll
`40af1453…`) wurde ohne Baseline-Re-Render über die reguläre
DGX-Admission ausgeführt. Gültig ist der dritte Versuch des Tages
(Job `a8c81734…`, Provenienz-Fingerprint `0713ad39…`, verifiziert nach
vollständiger Ausgabe); die beiden verworfenen Versuche sind als
`attemptJobIds` dokumentiert und deckten je einen echten Fehler auf:

1. Ein Worktree-Edit während des Laufs ließ die Provenienzprüfung
   fail-closed abbrechen (korrektes Systemverhalten; Betriebsregel
   ergänzt: keine Repo-Änderungen während provenienzgebundener Läufe).
2. **P1, behoben:** Der ID-LoRA-Refiner-Pfad übergab die
   Voice-Cloning-Stimmprobe (`idLora.referenceAudio`) als
   Synchronisations- und Mux-Quelle an LipForcing; der Kandidat sprach
   dadurch den Stimmproben-Satz statt des nativen Dialogs. Entdeckt vom
   Dialog-Evaluator (WER 1 gegen das erwartete Transkript), behoben in
   `buildRefinerAudioArgs` (ID-LoRA übergibt kein Audio-Override mehr;
   der Adapter extrahiert die native Sprachspur aus dem Basis-Video).
   Der zugehörige Test hatte das falsche Verhalten festgeschrieben und
   wurde korrigiert.

Vertragsbelege des gültigen Laufs: identische LTX-Basis aus der
persistierten, provenienzverifizierten Baseline übernommen und als
`input:reused-ltx-base` gebunden (Sidecar-Fallback); LipForcing-Eingang
auf exakt 25/1 CFR normalisiert (101 Frames = 4,041667 s, kein
Zeitachsen-Drift), Ausgabe wieder 97 Frames bei 24/1 mit unveränderter
Stereo-Sprachspur (Whisper: identisches Transkript, WER 0, identische
Wortkonfidenzen wie die Baseline).

Automatischer Vergleich (Analyzer v7 beidseitig):

| Metrik | Baseline | Kandidat |
| --- | --- | --- |
| Identität cosineMedian | 0,8606 | 0,8498 |
| Identität cosineP10 | 0,8282 | 0,8146 |
| Temporale Identitätskonsistenz | 0,9912 | 0,9883 |
| Mundwinkel Median (°) | 0,156 | 0,097 |
| Mundwinkel-Velocity P95 (°/s) | 5,19 | 3,86 |
| Mundhaut-Warp-Residual P95 | 0,0304 | 0,0284 |
| Mundhaut-Luminanzdelta P95 | 0,0059 | 0,0045 |
| Nasen-Velocity P95 (1/s) | 1,72 | 0,77 |
| AV-Sync | insufficient | insufficient |
| Phonem/Visem (P/B/M) | insufficient | insufficient |

Ehrliches Fazit: **kein automatischer Sieger.** Die Zielmetrik P/B/M
und der AV-Offset sind bei beiden Armen nicht messbar (Schärfe-Floor
bzw. Korrelations-Nullmodell, fail-closed); der Kandidat ist bei
Mundstabilität und Mundhaut leicht besser, bei der Identität marginal
schlechter (−0,011 cosineMedian). Die Entscheidung liegt damit
protokollgemäß bei der blinden visuellen Prüfung (Schritt 4); erst
danach darf ein Sieger erklärt oder der Kandidat verworfen werden.

**Blinde Sichtprüfung (2026-08-05):** Der Betreiber verglich beide Arme
verblindet (neutrale Kopien `blindtest-x/y.mp4`, Zuordnung zufällig und
vor dem Urteil versiegelt inkl. SHA-256: X = `62665487…` Kandidat,
Y = `9effcacb…` Baseline). Urteil: „Fast kein Unterschied erkennbar.
Aber X ist eine Spur besser." — X war der LipForcing-Kandidat. Damit
gewinnt der Kandidat die blinde Prüfung knapp; der wahrgenommene
Gleichstand bei der Identität relativiert das marginale metrische
Minus. Die Verwerfungsregel (schlechtere Identität/Mundnatur) greift
nicht. Einordnung bleibt ehrlich: ein Prüfer, ein Clip, „eine Spur"
Vorsprung — die erste faire Einzel-Evidenz zugunsten des
LipForcing-Pfads, kein statistischer Beleg im Sinne der 10/10-Abnahme.

**Befund aus der Canary-Nacht (2026-08-04/05, behoben):** Der erste
P1-Canary pausierte kooperativ für gemeldeten Qwen-Bedarf und wachte
8,6 Stunden lang nicht auf, obwohl die Bahn offen war (58,2 GiB frei
bei 54,0 GiB Bedarf, `could_start: TRUE`, `runner_heartbeat: never`).
Ursache auf Studio-Seite: `waitForQwenIdleGrace` wartete ausschließlich
auf das Verschwinden des Demand-Flags — ein wartender Fremd-Consumer,
der seinen Demand rollierend erneuert („waiting for OR using qwen"),
konnte den pausierten Lauf damit unbegrenzt aushungern. Fix: Der
pausierte Runner stellt jetzt periodisch (Standard alle 120 s) eine
read-only Admission-Probe (`/dgx/admission/check`) und beantragt bei
`accepted` den regulären Resume — der formale frische Admission-Antrag
war laut Orchestrator-Kontrakt immer erlaubt
(`tests/qwen-pause-admission-probe.test.ts`, 4 Tests). Die
Orchestrator-Seite hat parallel Idle-Verfall für Realtime-Demand,
`min_driver_free_gib`-Prüfung vor der Zusage und transparente
`unit_demands` in `/dgx/status` nachgerüstet; Details im Handoff
`dgx_orchestrator/docs/handoffs/2026-08-05-antwort-an-ltx2.md`.

## Nachtrag: getrennt gepinnte offizielle Quellen

Die Prüfung der offiziellen Verträge hat eine Versionsdifferenz zwischen den
beiden offiziellen Quellen sichtbar gemacht. Beide sind jetzt getrennt und
revisionsgebunden in der Laufprovenienz verankert
(`shared/upstreamWorkflowContracts.ts`):

1. **ComfyUI-Dokumentationstemplates** (`Comfy-Org/workflow_templates`,
   Commit `7653f1cd`) sind der bindende Vertrag für die nativen
   Two-Stage-Modi T2V, I2V, IA2V und ID-LoRA. Verifizierter Inhalt aller
   vier Templates: Sampler `euler` mit CFG 1 in beiden Stufen, Stufe 1 mit
   der 8-Schritt-Distilled-Reihe und freiem Seed, Stufe 2 mit der
   `0.85er`-Reihe und festem Seed 42, Distilled-LoRA 1.1 mit Stärke 0.5,
   Gemma-LoRA für Prompt-Enhancement; beim ID-LoRA-Template hängt die
   ID-LoRA (Stärke 1) nur vor Stufe 1. T2V/I2V decodieren Audio aus
   Stufe 2.
2. **Lightricks-Beispielworkflows** (`Lightricks/ComfyUI-LTXVideo`,
   Commit `3b9c5cde`) binden weiterhin IC-LoRA, LipDub-HQ und
   Text-to-Audio. Nur dort sind die CFG++-Sampler
   (`euler_ancestral_cfg_pp`, `euler_cfg_pp`) Vertragsteil.

Parameter dürfen nicht zwischen den Quellen gemischt werden; genau diese
Vermischung (CFG++ im nativen T2V) wurde erkannt und zurückgenommen. Die
Provenienzprüfung vergleicht die gebundenen Verträge bei Wiederverwendung
und Resume gegen den Auftrag und schlägt bei Abweichung fehl.

Der native Two-Stage-Vertrag ist zusätzlich durch GPU-freie Vertragstests
abgesichert (`test_ti2vid_official_contract.py`): Denoiser-Wahl,
Sigma-Reihen, Stufe-2-Seed 42 und Audio-aus-Stufe-2.

## Externes Review und behobene Befunde

Ein unabhängiges Codex-Review (gpt-5.6-sol, maximaler Reasoning-Aufwand) über
den gesamten Arbeitsstand lieferte 16 Findings. Alle wurden einzeln gegen den
Code verifiziert; die bestätigten wurden behoben und mit Regressionstests
abgesichert:

- **IC-LoRA-Startblocker:** Der `--checkpoint-path`-Alias war nur im
  Usage-Text registriert, nicht im argparse-Lookup; zusätzlich stürzte
  erzeugtes IC-Audio über `noise_scale=None` in `torch.lerp` ab. Beides
  behoben (`test_ic_lora_cli.py`).
- **Union-Control-Vertrag:** Auflösung nutzt jetzt wie der gepinnte
  Lightricks-Workflow Dev-Checkpoint plus rank-384-Distilled-LoRA mit
  Stärke 0.5 statt der FP8-Substitution ohne LoRA.
- **Kooperative Checkpoints ehrlich gemeldet:** Text-to-Audio und alle
  IC-LoRA-Profile laufen über den CFG++-Loop ohne Restore-Hooks und melden
  sich nicht mehr als kooperativ pausierbar (fail-closed gegenüber dem
  Orchestrator).
- **Adoptierte Experiment-Baselines:** Die UI erkennt eine adoptierte
  Baseline jetzt über die im Experiment gepinnte Provenienz-Evidenz
  (Fingerprint), statt eine nie vorhandene Sidecar-Bindung zu verlangen.
- **Vertragskorrekturen:** FLF2V nutzt das deterministische `eta=0` des
  offiziellen Templates; das Inpaint-Grün liegt jetzt im VAE-Wertebereich;
  Ingredients konditioniert das Referenzbild nicht mehr doppelt; In-/
  Outpainting validiert das 64er-Raster bereits in der UI; der HDR-Modus
  bindet keinen offiziellen Graphen mehr, den der Legacy-Runner nicht
  ausführt.
- **Evaluator:** Das CTC-Alignment erhält Vokallängen (`iː` bleibt `iː`,
  mit Kurzvokal-Fallback für Vokabulare ohne Langvokale); die
  Visemzuordnung bleibt bewusst längenunabhängig.
- **Bedienbarkeit:** Aktive Refiner-Schalter bleiben sichtbar, auch wenn der
  Dialogtext entfernt wird; die ID-LoRA-Stärke ist nicht mehr an ein
  unsichtbares IC-Profil gekoppelt.

**Behobene Medium-Feststellung (2026-08-04):** Die Wiederverwendung einer
identischen LTX-Basis (`findReusableLtxBase`) durchsuchte nur die
In-Memory-Job-Historie; ein manuell entfernter oder bereinigter Quelljob
erzwang einen redundanten Neu-Render. Jetzt fällt die Suche auf die
persistierten Output-Sidecars zurück: Die OutputLibrary liefert nur
Kandidaten mit inhaltsgebundener Revision (`recordMatchesFile`) und
vollständiger Identitäts- plus verifizierter Laufprovenienz; das Matching
nutzt dieselben fail-closed-Kriterien wie der Historienpfad
(`reusableLtxBaseFromSidecars`, verdrahtet über
`jobs.wireReusableBaseSource(outputs)` beim Serverstart). Ein unlesbares
Sidecar-Verzeichnis kostet nur den regulären Render, nie einen Absturz
(`tests/reusable-ltx-base.test.ts`).

Teststand nach den Korrekturen: 501 Studio-Tests, 60 native Tests, ESLint
ohne Warnungen, Produktionsbuild grün. Das globale Vitest-Timeout wurde auf
30 s angehoben, weil die Contract-Tests echte Python-/ffmpeg-Subprozesse
starten und unter Volllast am 5-s-Standard scheiterten.

## P1-Canary-Serie und Betriebsbefunde (2026-08-05/06)

Ziel dieser Serie: das erste Kriterium der 10/10-Abnahme — „jeder sichtbare
Modus besteht Cold- und Warm-Canary" — mit belastbarer Evidenz unterlegen.
Jeder Lauf ging über die reguläre Studio-Queue und die DGX-Admission; kein
Lauf wurde an der Admission vorbei gestartet. Rohdaten (Job-IDs, Zeitstempel,
Provenienz-Fingerprints, Ausgabegrößen) liegen maschinenlesbar in
`docs/evidence/canary-p1-2026-08-05.jsonl`.

### Ergebnisse

| Modus | Auflösung / Frames | Erster Versuch | Gültiger Lauf | Reine Renderzeit |
| --- | --- | --- | --- | --- |
| two-stage | 1280×704, 129f@25 | ✅ `53e1934d…` | ✅ `1a2b3d0e…` | 1 147 s / 956 s |
| image-audio-to-video | 512×512, 97f@24 | ✅ `da75025b…` | ✅ `7a719e79…` | 37 423 s\* / 514 s |
| id-lora | 1024×1024, 97f@25 | ❌ Start-Fence | ✅ `ac74f6a0…` | 586 s |
| ic-lora | 1280×704, 129f@25 | ❌ OOM-Kill | ✅ `00c6b842…` | 1 582 s |
| lipdub | 1216×1216, 97f@24 | ❌ Start-Fence | ✅ `6bf5f946…` | 1 856 s |

\* enthält kooperative Qwen-Pausen; die reine Rechenzeit ist deutlich kleiner
und aus dieser Wanduhrzahl nicht ableitbar.

**Alle fünf sichtbaren Modi haben einen vollständigen, provenienzverifizierten
Lauf** (Verifikation jeweils nach vollständiger Ausgabe, Fingerprints im
Evidenz-JSONL). Die drei gescheiterten Erstversuche lagen ausnahmslos an der
Infrastruktur, **kein einziger an einem LTX-Modus**: zweimal am
DGX-Start-Fence, einmal am Kernel-OOM-Killer.

### Was diese Serie noch nicht belegt

Ehrliche Grenzen, damit das P1-Gate nicht vorzeitig als erfüllt gilt:

1. **Kontrollierte Cold/Warm-Paare gibt es nur für two-stage und
   image-audio-to-video.** Die Bezeichnungen `cold`/`warm` beschreiben die
   Reihenfolge im Runner, nicht einen kontrollierten Cache-Zustand. Nach den
   drei Infrastruktur-Fails liefen die Retries in nicht kontrolliert
   vorgewärmten Zuständen — für id-lora, ic-lora und lipdub fehlt je die
   Gegenprobe.
2. **„Aus dem Release-Digest" ist nicht erfüllt.** P0 (reproduzierbare
   Releasebasis) steht aus; die Läufe liefen gegen einen uncommitteten
   Worktree. Der Codezustand ist über `code[]` (Commit +
   `trackedDiffSha256`) kryptografisch gebunden und damit rekonstruierbar,
   aber ein Release-Digest ist er nicht.
3. Die Serie prüft **Lauffähigkeit und Provenienz**, nicht Qualität. Die
   Qualitätsgates (AV-Offset, WER, Viseme, Identität, VBench) bleiben
   unverändert offen und hängen an P2.

### Betriebsbefunde und ihre Auflösung

Die Serie hat als Nebenprodukt fünf Fehler in der Ressourcensteuerung
sichtbar gemacht. Alle wurden vom DGX-Orchestrator behoben; die LTX-Seite
musste ihren Kontrakt dafür in keinem Fall ändern (Handoffs unter
`~/projects/dgx_orchestrator/docs/handoffs/`, Vertrag: `CALLER-GUIDE.md`).

| Befund | Wirkung auf die Serie | Auflösung |
| --- | --- | --- |
| Qwen-Demand-Flag unterschied Wartende nicht von Arbeitenden | ia2v cold schlief 8,6 h bei offener Bahn | **Studio-seitig:** pausierter Runner stellt alle 120 s eine read-only Admission-Probe und beantragt bei `accepted` den regulären Resume (`tests/qwen-pause-admission-probe.test.ts`) |
| Eviction-Trigger nur beim Erst-Submit erreichbar | id-lora cold verhungerte 2,5 h am Fence | Orchestrator: jeder Replay-Poll stößt den Räumungsversuch an; Idle-Fenster 20 → 5 min |
| Poll galt nicht als Lebenszeichen | lipdub cold nach 5:11 h als „accepted stale" gereapt — bei 5-s-Poll | Orchestrator R91: „wer pollt, lebt", für jeden wartenden Job; R93 gibt dem Reaper einen eigenen 5-Minuten-Puls |
| Queue-Kopf blockierte die Bahn, ohne startfähig zu sein | zwei Canaries verloren ihren Slot hinter einem 16 h nicht startfähigen Fremdjob | Orchestrator R92: der Kopf verliert nach 30 min sein Veto, nicht seinen Platz |
| Reserve für die einpagende Qwen-Lane fiel schlagartig auf 0 | ic-lora cold starb im `global_oom` bei 39 GiB — 19 GiB **unter** der eigenen 58-GiB-Anmeldung | Orchestrator R100: `qwen_paging_reserved_gib` klingt ab statt abzureißen und gilt an beiden Start-Toren |

Zum OOM-Fall gehört ein Befund auf **unserer** Seite: Der Kernel wählte den
Renderprozess als Opfer einer Fremdallokation, und systemd startete daraufhin
die gesamte Studio-Unit neu (`OOMPolicy`-Default `stop`), statt nur den
Render sterben zu lassen. Der Job wurde beim Restore korrekt als
`interrupted` markiert — die Wiederherstellung funktionierte also, aber der
Kollateralschaden war unnötig groß.

### Gate-Stand nach der Serie

| Gate | Ergebnis (2026-08-06) |
| --- | --- |
| Studio Unit-/Integrationstests | 529/529 bestanden |
| Native LTX Python-Suite | 60/60 bestanden |
| Studio ESLint | bestanden, 0 Warnungen |
| Studio Produktionsbuild | bestanden; nur Vites nicht blockierender Chunk-Hinweis |
| Provenienzverifizierte Modi-Läufe | 5 von 5 sichtbaren Modi |
| Aktive Studio-Jobs | keine |

### Offene Befunde auf der Studio-Seite

Gesammelt aus der Serie; keiner davon ist ein Datenverlust- oder
Korrektheitsrisiko, alle betreffen Diagnose und Betriebsverhalten:

1. **Wartegrund unsichtbar:** `publicJob` liefert im Zustand `queued` keine
   Logzeilen aus. Ein an der Admission wartender Job sieht in API und GUI wie
   ein untätiger Job aus, obwohl der Grund („must free 10,16 GiB") intern
   protokolliert ist. Diagnostisch der teuerste der offenen Punkte.
2. **Reaper-Cancel führt zu hartem Fehlschlag:** Wird ein Remote-Job während
   der `starting`-Retry-Schleife abgebrochen, schlägt der Studio-Job fehl,
   obwohl der `queued`-Pfad für denselben Fall einen Resubmit kennt. Der
   Orchestrator liefert dafür künftig `client_action: resubmit`.
3. **Fence-Fehlertext ohne Grund:** „DGX-Queue-Start-Fence wurde nicht
   freigegeben" nennt den letzten Gate-Grund nicht (`insufficient_memory`,
   `not_selected_queue_winner`, Thermik).
4. **Event-Loop-Blockade:** Das Inline-SHA-256 großer, erstmals verifizierter
   Modellassets blockiert den Node-Event-Loop; die API ist in dieser Zeit
   nicht erreichbar. Kandidat für einen Worker-Thread.
5. **Stilles Job-Pruning beim Restore:** Jobs, deren Request
   `migrateGenerationRequest` nicht mehr besteht, werden beim Serverstart
   kommentarlos verworfen (Historie fiel dadurch von 30 auf 8 Einträge).
6. **Preflight kennt die Basis-Wiederverwendung nicht** und veranschlagt
   deshalb für einen Experimentarm mehr Ressourcen als der Lauf braucht.
7. **Neue Orchestrator-Felder ungenutzt:** `retry_guidance`,
   `memory_reclaim_attempt`, `qwen_paging_reserved_gib` und der Kopf-Kontext
   am Start-Fence werden noch nicht ausgewertet oder angezeigt.
8. **Betriebsseitig (Operator):** `OOMPolicy=continue` für
   `ltx-studio-session.service`, damit ein OOM-Opfer nicht die ganze Unit
   mitreißt.

### Nächste Schritte in dieser Reihenfolge

1. P0: Releasebasis in geprüfte Commits aufteilen (Voraussetzung dafür, dass
   Canaries „aus dem Release-Digest" laufen).
2. Die drei fehlenden kontrollierten Warm-Läufe (id-lora, ic-lora, lipdub)
   nachziehen.
3. 50-Job-Soak und 20/20 Qwen-Pause/Resume-Zyklen (P5; Mechanik und
   Weckruf sind bereits einzeln belegt).
4. P2-Messstrecke: Goldsatz, AV-Sync-Kalibrierung, identitätsdisjunkter
   Holdout, registriertes Protokoll — danach erst die lokalen Komparatoren.

## Zielklarstellung: SOTA heißt hier vollständig lokal (2026-08-05)

Auf die Frage nach einem externen Spitzenkomparator hat der Betreiber das
Ziel verbindlich präzisiert: **alles lokal — SOTA als das maximal Mögliche in
allen Kategorien**, bewiesen auf der DGX. Keine Cloud-Komparatoren, keine
Datenabflüsse.

Das ändert nichts an der Messlatte, aber es ändert, woher der externe Anker
kommt: über **lokal lauffähige** Spitzensysteme unter registriertem Protokoll
(Wan2.2-S2V nach eigenem Canary, MOVA; LatentSync und MuseTalk als
halb-externe Arme; VBench lokal). Bis diese Vergleiche unter der
kalibrierten P2-Messstrecke laufen, bleibt der höchste ehrliche Status
unverändert `lokale Produktionsüberlegenheit` — die Formulierung im Abschnitt
„10/10-Abnahme" gilt also weiter, nur ist der Weg zum Anker jetzt benannt.

## Primärquellen

- LTX-2: https://github.com/Lightricks/LTX-2
- ComfyUI LTX-2.3: https://docs.comfy.org/tutorials/video/ltx/ltx-2-3
- ComfyUI-Workflowtemplates: https://github.com/Comfy-Org/workflow_templates
- LatentSync: https://github.com/bytedance/LatentSync
- LatentSync-1.6-Gewichte: https://huggingface.co/ByteDance/LatentSync-1.6
- VBench: https://github.com/Vchitect/VBench
- Wan2.2: https://github.com/Wan-Video/Wan2.2
- MOVA: https://github.com/OpenMOSS/MOVA

### Betriebsverträge (lokal, außerhalb dieses Repos)

Der Ressourcenvertrag zwischen Studio und DGX wird nicht hier gepflegt. Wer
an Admission, Queue, Pause/Resume oder Start-Fence arbeitet, liest zuerst:

- `~/projects/dgx_orchestrator/CALLER-GUIDE.md` — verbindlicher Vertrag
  (§5 Entscheidungen, §6 Wartezeit, §7 Reaper, §7a.1 Start-Fence/Queue-Kopf,
  §9/§11 Reserven und Checkliste)
- `~/projects/dgx_orchestrator/docs/handoffs/` — datierte Änderungsmeldungen;
  für die hier dokumentierten Befunde besonders
  `2026-08-05-was-aufrufer-wissen-muessen.md`,
  `2026-08-06-was-aufrufer-wissen-muessen.md` (R91–R93) und
  `2026-08-06-antwort-an-ltx2-oom-reserve.md` (R100)
