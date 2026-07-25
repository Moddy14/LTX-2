# AV-Sync-Evaluator: Lizenz- und Produktionsentscheidung

Stand: 2026-07-25

## Ziel

LTX Studio braucht neben dem checkpointfreien Audio-Mund-Bewegungsproxy einen
gelernten Evaluator für audio-visuelle Sprachkorrespondenz, zeitlichen Versatz
und Synchronitätskonfidenz. Ein SyncNet-artiger Offset-Klassifikator prüft noch
keine explizite Phonem-/Visem-Inhaltsübereinstimmung; dafür ist ein zusätzlicher
inhaltlich ausgerichteter Evaluatorpfad nötig. Beide Pfade dürfen keine
unklaren Modellrechte oder nichtkommerziellen Trainingsbedingungen in die
Anwendung einschleusen.

## Freigabekriterien

Ein fremder Evaluator ist nur ein Produkt-GO, wenn gleichzeitig belegt sind:

- permissive Code-Lizenz;
- eindeutige Lizenz der konkreten Gewichte;
- nachvollziehbare Trainingsdaten- und Rechtekette;
- gepinnte Code- und Modellrevision;
- SHA-256 jedes ausgelieferten Gewichts;
- reproduzierbare Vorverarbeitung;
- funktionale Eignung für Lippen-Sprache-Offset statt nur allgemeiner
  Audio-/Video-Semantik;
- ausdrückliche Rechte für ML-Training und Feature-Extraktion, biometrische
  Verarbeitung von Gesicht und Stimme, Erzeugung abgeleiteter Gewichte sowie
  deren kommerzielle Nutzung und Weitergabe.

Ein Repository-`LICENSE` beweist nicht automatisch die Rechte externer
Checkpoints oder Trainingsdaten.

## Kandidaten

| Kandidat | Code | Gewichte/Daten | Funktion | Entscheidung |
| --- | --- | --- | --- | --- |
| Montreal Forced Aligner 3.3.9 + German MFA acoustic model v3 | MIT; deutsches Akustikmodell CC BY 4.0 | Explizit deutsches Forced Alignment, u. a. Common Voice DE v16.1 und GlobalPhone; Attribution und exakte Modellrevision müssen archiviert werden | Telefonzeitachse aus dem bereits gebundenen Zieldialog | Bevorzugter CPU-Produktbaustein nach Attribution-/Rechtefreigabe |
| MediaPipe Face Landmarker | Apache-2.0 Code | Offizieller `.task`-Bundle benötigt noch einen separat archivierten Modell-/Lizenznachweis | 478 3D-Landmarks und 52 Blendshapes für sichtbare Artikulation | Bevorzugter CPU-Produktbaustein; Modellbundle bis Lizenznachweis Legal Hold |
| Oxford SyncNet, Revision `907c0b579c2e2d83f0eae1b2ac9e720cde4e5623` | MIT | Offizielle Modellseite nennt Forschungsnutzung unter nicht näher spezifizierter CC-Attribution-Lizenz; kommerzieller Umfang und separater Weight Grant bleiben unklar | Passender Offset-/Konfidenzevaluator | Fremdgewichte Legal Hold; Architekturidee mit eigenen Gewichten möglich |
| Wav2Lip LSE-C/LSE-D, Revision `bac9a81e63ecc153202353372e5724b83d9e6322` | Kein permissiver Produktvertrag | README und LRS2 beschränken auf nichtkommerziellen Forschungsgebrauch | Passender LipSync-Evaluator | NO-GO |
| VocaLiST, Revision `c265b59bcf7cd8559a265aaf454a9333ec24cb0f` | Mixed; eigener Code CC-BY-NC 4.0, übernommene Teile unter Drittlizenzen | Wav2Lip-/LRS2-Abhängigkeiten | Passender Evaluator | NO-GO |
| MTDVocaLiST, Revision `5795416f9277094d3ae6215596a436a0a01f79ad` | Keine ausgewiesene Lizenz | Von VocaLiST/LRS2 abgeleitet | Passender Evaluator | NO-GO |
| AV-HuBERT, Revision `258fb50e155134eec2c4b49c2ae8de267075fd18` | Eigene Non-Commercial-Research-Lizenz | LRS3/VoxCeleb2 | AV-Repräsentation/ASR, kein fertiger Offset-Head | NO-GO |
| Synchformer, Revision `b66668a1521d7567cc760e5544b2b5b53179b687` | Top-Level MIT | Externe Checkpoints ohne separaten Weight Grant; MotionFormer-Bestandteile überwiegend CC-NC 4.0 | Allgemeiner AV-Offset | NO-GO für Auslieferung |
| SparseSync, Revision `a5bee8a047c0ebeec66b18d4ddf4c5f0ef098a4f` | Top-Level MIT | Externe Gewichte ohne getrennte Weight-Lizenz; YouTube-abgeleitete Daten | Allgemeiner AV-Offset | Legal Hold |
| StableSyncNet aus LatentSync, Code `a229c3948406bc2cf6eaf4873e662e70c6a04746`, HF `c42c7e6c8e9c213626389fa7d9a3c444b8536353` | Apache-2.0 Code | 1,61-GB-Pickle mit OpenRAIL++-Tag; VoxCeleb2/HDTF-Provenienz und keine deutsche Validierung | Passender 16-Frame-Sync-Head vorhanden | Optionaler Research-Crosscheck nach Legal/FTO; nie alleiniger Produkt-Gate |
| WAVE-7B, Code `9c87b5cbb4bf2ad8e21c8c9ca4a2f1f7af8e338b`, HF `7d51cdaecfaabb9c529a447249cd4c2a6df8ce5b` | Code und Weight-Tag Apache-2.0 | Trainingsdaten-/Basiskomponenten-Provenienz noch nicht vollständig auditiert | AV-Retrieval/QA, kein zeitlicher Lippenoffset | Code-/Weight-License-GO, Provenienz offen, funktionales NO-GO |

## Interne Spitzenkomparatoren

Zwei Generatoren werden getrennt von der Evaluator-Lizenzentscheidung als
vorab zu pinnende **interne Benchmark-Arme** geführt:

- LongCat-Video-Avatar 1.5: Code-Revision
  `6b3f4b8582a8bc3f20f795735f5383716c4ba794`; der aktuell veröffentlichte
  Hugging-Face-Head ist
  `92016c71d5d318d0f5d84e4db30015a571484ab6`, während der lokale Download noch
  Dateien der Revision `c70e3188051d3804c74fa187340a2aa1e6fac0f1`
  enthält. Vor dem Holdout ist genau eine vollständig geprüfte Revision
  festzuschreiben.
- Wan2.2-S2V-14B: externer Speech-to-Video-Spitzenkomparator; Code
  `42bf4cfaa384bc21833865abc2f9e6c0e67233dc`, Gewichte
  `dab4e9c55bbe4c8c4d03db1c2c98c7f0ac9c454b`.

`internal-benchmark-only` ist ausschließlich die Scope-Obergrenze und **keine
Ausführungsfreigabe**. Beide Arme bleiben `conditional-legal-hold`, bis
Legal/FTO, Trainingsdaten- und Gewichtsprovenienz sowie die Rechte an den
konkreten Benchmark-Eingaben für exakt diese Revisionen akzeptiert und
dokumentiert sind. Erst danach darf ein gesonderter Freigabeakt einen internen
Vergleichslauf erlauben. Eine gute Vergleichsleistung oder eine permissive
Repository-/Weight-Lizenz ist keine Freigabe, fremden Code oder Gewichte in
LTX Studio auszuliefern.

Die Hugging-Face-LFS-Metadaten melden für den untersuchten
LatentSync-Checkpoint `stable_syncnet.pt` SHA-256
`77678d13861a02d6e83d0b169962175b6266be773f1f6f85fda2b0182e225118`.
Der Checkpoint wurde nicht heruntergeladen; der Metadatenhash belegt weder eine
lokale Nachprüfung noch das Nutzungsrecht.

## Primärquellen

- Oxford SyncNet: <https://github.com/joonson/syncnet_python/tree/907c0b579c2e2d83f0eae1b2ac9e720cde4e5623> und
  <https://www.robots.ox.ac.uk/~vgg/software/lipsync/>
- Wav2Lip: <https://github.com/Rudrabha/Wav2Lip/tree/bac9a81e63ecc153202353372e5724b83d9e6322> und
  <https://robots.ox.ac.uk/~vgg/data/lip_reading/lrs2.html>
- VocaLiST: <https://github.com/vskadandale/VocaLiST/tree/c265b59bcf7cd8559a265aaf454a9333ec24cb0f>
- MTDVocaLiST: <https://github.com/xjchenGit/MTDVocaLiST/tree/5795416f9277094d3ae6215596a436a0a01f79ad>
- AV-HuBERT: <https://github.com/facebookresearch/av_hubert/tree/258fb50e155134eec2c4b49c2ae8de267075fd18>
- Synchformer: <https://github.com/v-iashin/Synchformer/tree/b66668a1521d7567cc760e5544b2b5b53179b687> und
  <https://github.com/facebookresearch/Motionformer>
- SparseSync: <https://github.com/v-iashin/SparseSync/tree/a5bee8a047c0ebeec66b18d4ddf4c5f0ef098a4f>
- LatentSync: <https://github.com/bytedance/LatentSync/tree/a229c3948406bc2cf6eaf4873e662e70c6a04746> und
  <https://huggingface.co/ByteDance/LatentSync-1.6/tree/c42c7e6c8e9c213626389fa7d9a3c444b8536353>
- WAVE-7B: <https://huggingface.co/tsinghua-ee/WAVE-7B/tree/7d51cdaecfaabb9c529a447249cd4c2a6df8ce5b>
- Montreal Forced Aligner:
  <https://github.com/MontrealCorpusTools/Montreal-Forced-Aligner> und
  <https://mfa-models.readthedocs.io/en/latest/acoustic/German/German%20MFA%20acoustic%20model%20v3_0_0.html>
- MediaPipe Face Landmarker:
  <https://developers.google.com/mediapipe/solutions/vision/face_landmarker> und
  <https://github.com/google-ai-edge/mediapipe>
- LongCat-Video-Avatar 1.5 Code:
  <https://github.com/meituan-longcat/LongCat-Video/tree/6b3f4b8582a8bc3f20f795735f5383716c4ba794>
- LongCat-Video-Avatar 1.5 Gewichte:
  <https://huggingface.co/meituan-longcat/LongCat-Video-Avatar-1.5/tree/92016c71d5d318d0f5d84e4db30015a571484ab6>
- Wan2.2-S2V-14B Code:
  <https://github.com/Wan-Video/Wan2.2/tree/42bf4cfaa384bc21833865abc2f9e6c0e67233dc>
- Wan2.2-S2V-14B Gewichte:
  <https://huggingface.co/Wan-AI/Wan2.2-S2V-14B/tree/dab4e9c55bbe4c8c4d03db1c2c98c7f0ac9c454b>

## Produktionsweg

Der bevorzugte deutschsprachige Produktpfad ist ein deterministischer,
CPU-begrenzter Zweistufen-Evaluator:

1. Der exakt im Studio gebundene Zieldialog wird mit MFA German v3 gegen die
   gerenderte 16-kHz-Spur ausgerichtet. ASR ersetzt den Zieltext dabei nicht.
2. MediaPipe verfolgt Gesicht, Kopfpose, Mundlandmarks und Blendshapes pro
   echtem Video-PTS. Telefonzeiten werden deterministisch auf sichtbare
   Artikulationsklassen abgebildet.
3. Persistiert werden mindestens `global_av_lag_ms`,
   `bilabial_closure_f1` für `/p,b,m/`, Öffnungs-/Rundungs-Korrespondenz,
   `speech_motion_recall`, `pause_leak_ratio`, Trackabdeckung, Kopfpose,
   Unschärfe, Komponentenrevisionen und SHA-256.
4. Zu wenig verwertbare Telefone, verlorener Gesichtstrack, Verdeckung,
   Mehrsprecher oder außerhalb der Claim-Domain liegende Pose ergeben
   `insufficient_evidence`, niemals einen scheinbar guten Wert.

MFA-Attribution und die konkreten Rechte des MediaPipe-`.task`-Bundles müssen
vor Installation und Product-GO archiviert werden. StableSyncNet darf nach
separater OpenRAIL++-/Trainingsprovenienzfreigabe als isolierter,
orchestrierter Research-Crosscheck hinzukommen; sein Pickle wird nur mit
`weights_only=True` geladen und nie dauerhaft resident gehalten.

Ein eigener gelernter Offset-/Inhaltsevaluator bleibt eine spätere Option. Er
ist erst nach Abschluss aller folgenden Nachweise ein Produkt-GO:

1. SyncNet-artige Architektur permissiv neu implementieren oder erlaubten
   MIT-Code ohne fremde Gewichte übernehmen.
2. Gesicht und Mund mit einer separat permissiv lizenzierten, gepinnten
   Vorverarbeitung extrahieren.
3. Für jede Datenquelle ausdrücklich ML-Training, Feature-Extraktion,
   biometrische Gesichts-/Stimmverarbeitung, abgeleitete
   Modell-/Checkpoint-Erzeugung sowie kommerzielle Bereitstellung und
   Weitergabe vertraglich belegen. Zweck, Territorium, Laufzeit,
   Minderjährigen-Ausschluss, Widerruf, Löschung und Rechtekette dokumentieren.
   Für EU-Personendaten zusätzlich Rechtsgrundlage, Verarbeitungsverzeichnis,
   DPIA, Auftragsverarbeiter und Löschprozess prüfen.
4. Positive und verschobene Paare erst nach einheitlicher Decodierung erzeugen
   und anschließend durch denselben Resample-/Encode-Pfad führen. GOP, AAC,
   PTS und Timebase müssen identisch sein, damit keine Codec- oder
   Container-Shortcuts gelernt werden.
5. Verschiebungen von mindestens `±1` bis `±15` Frames sowie harte Negative aus
   derselben Äußerung und Identität erzeugen.
6. Train-, Tune-, Calibration- und Testsets nach Sprecher, Identität,
   Quellvideo, Aufnahme-Session und Lizenzquelle trennen. Sprache/Phoneme,
   Kopfpose, Mundgröße, Verdeckung, Stille, Musik, mehrere Sprecher,
   Offscreen-Sprache und synthetische LTX-Ausgaben stratifizieren.
7. Einen getrennten inhaltlichen Phonem-/Visem-Pfad implementieren,
   rechteprüfen, kalibrieren und testen; der Offset-Klassifikator allein
   beweist nur gelernte audio-visuelle Korrespondenz. Der zweite Pfad muss alle
   jeweils anwendbaren Schritte und Release-Gates dieses Abschnitts selbst
   bestehen.
8. Menschliche Ground-Truth-Richtlinie, Raterzahl und
   Inter-Rater-Reliabilität festlegen.
9. Offset-MAE, Genauigkeit innerhalb eines Frames, ROC/PR, FAR/FRR,
   Brier-Score, ECE und Reliability-Diagramm berichten. Confidence-Kalibration
   und statistische Bootstrap-Konfidenzintervalle getrennt ausweisen.
10. Abstention-/OOD-Regeln für Stille, verdeckten Mund, fehlenden Active
    Speaker, Musik und Mehrpersonenclips definieren.
11. Model Card, Daten-/Split-Hashes, Rechtebelege, Code- und
    Benchmarkrevision, Trainingsconfig/Seed, Lockfile, Container-Image-Digest,
    SBOM, Dependency-Lizenzen, NOTICE-Dateien, Detektor-/Landmarker-Lizenz und
    -SHA sowie Weight-SHA-256 gemeinsam versionieren. Dem eigenen Checkpoint
    eine ausdrückliche Distributions- und Nutzungslizenz zuweisen; Patent-/FTO-
    Prüfung oder bewusst akzeptiertes Restrisiko dokumentieren.
12. Eine 0-bis-10-Skala nur gegen unabhängige menschliche MOS-Bewertungen
    kalibrieren; Modellkonfidenz darf nicht direkt zur Qualitätsnote werden.

## Vorab registrierte Release-Gates

Vor dem Blick auf das unabhängige Testset gelten für Offset- und
Korrespondenzpfad mindestens:

- Median des absoluten Offsetfehlers höchstens `20 ms`, p95 höchstens `40 ms`;
- mindestens `95 %` Offsetgenauigkeit innerhalb eines Video-Frames und
  mindestens `90 %` in jedem kritischen Stratum;
- am vorab fixierten Pass-Gate False-Accept-Rate höchstens `1 %` und
  False-Reject-Rate höchstens `5 %`; pro kritischem Stratum höchstens `3 %`
  beziehungsweise `10 %`;
- Expected Calibration Error höchstens `0,05` und Brier-Score höchstens `0,10`;
- OOD-/Abstention-Recall mindestens `95 %` bei höchstens `5 %` fälschlicher
  Abstention auf zulässigen In-Distribution-Fällen;
- die relevante Seite jedes bootstrap-basierten 95-%-Konfidenzintervalls muss
  ebenfalls innerhalb des Grenzwerts liegen;
- der Phonem-/Visem-Pfad muss auf einer vor dem Holdout eingefrorenen
  Audio-Phonem-Zeitachse und einer versionierten 15-Klassen-Visemabbildung
  mindestens `0,85` Makro-F1 über alle Nicht-Stille-Frames und mindestens
  `0,75` in jedem kritischen Stratum erreichen;
- sichtbare Visemübergänge müssen mit einer Toleranz von einem Videoframe
  mindestens `0,90` F1 insgesamt und `0,80` je kritischem Stratum erreichen;
  die unteren Grenzen der sprecherweise gebootstrappten 95-%-Intervalle müssen
  für Frame-Makro-F1 mindestens `0,82`/`0,72` und für Übergangs-F1 mindestens
  `0,87`/`0,77` (gesamt/Stratum) betragen;
- zusätzlich muss die unabhängige menschliche LipSync-MOS mindestens `9/10`
  erreichen. MOS ersetzt weder den objektiven Inhaltsnachweis noch dessen
  Stratum- und Konfidenzgrenzen.

Die Grenzwerte werden in Millisekunden und zusätzlich in Frames der jeweiligen
Testbildrate berichtet. Nachträgliches Lockern anhand des Holdouts ist keine
Freigabe; es erfordert eine neue Modell-/Gate-Version und ein neues
unberührtes Testset.

Bis dahin bleibt `classical-audio-mouth-motion.v1` ein hilfreicher
Regressions- und Grobversatzproxy, aber kein SOTA-Abnahmenachweis.
