# Durchführungsplan bis SOTA 10/10

Stand: 2026-08-06. Dieses Dokument ist der **Zielplan**: Es hält fest, was für
die 10/10-Abnahme noch fehlt, in welcher Reihenfolge es abgearbeitet wird und
woran jede Phase als erledigt gilt.

Maßgeblich für die Kriterien bleibt `QUALITY_AUDIT_2026-08-03.md`
(Abschnitte „Verbindlicher 10/10-Plan" P0–P5 und „10/10-Abnahme"); die
LipDub-Claim- und Messdetails stehen in `LIPDUB_SOTA_PLAN.md`. Dieser Plan
erfindet keine neuen Kriterien, er ordnet die bestehenden nach Machbarkeit
und Abhängigkeit.

Zielbegriff laut Betreiber (2026-08-05): **SOTA heißt vollständig lokal** —
das maximal Mögliche in allen Kategorien, bewiesen auf der DGX, ohne
Cloud-Komparatoren und ohne Datenabfluss.

---

## 1. Bilanz: wo wir stehen

### Erfüllt und belegt

| Punkt | Beleg |
| --- | --- |
| Releasebasis in geprüfte Commits geteilt (P0, erster Teil) | 6 thematische Commits ab `45f60e0`, Worktree sauber |
| Alle fünf sichtbaren Modi laufen provenienzverifiziert (P1, Kern) | `docs/evidence/canary-p1-2026-08-05.jsonl`, Fingerprints je Lauf |
| Fail-closed-Assetbindung je Modus (P1) | `requiredOfficialSpeechAssetIds` + SHA-256-Inventar, Start blockiert bei fehlendem Asset |
| Kooperative Pause/Resume funktioniert real (P5, Mechanik) | ia2v-Canary: Pause bei 47,5 %, Admission-Probe, Resume < 2 min, identische Fortsetzung |
| Versiegelter Phonem-Visem-Evaluator (P2, Teilstück) | gepinntes Manifest, gehärtete Transient-Unit, fail-closed-Statusprovider |
| Erste faire LipForcing-A/B-Evidenz (P3, Teilstück) | Audit-Abschnitt „Erste faire LipForcing-A/B-Evidenz", verblindetes Urteil |
| Automatisierte Testabdeckung | Studio 529, nativ 60, ESLint 0, Build grün |
| Ressourcenvertrag mit dem Orchestrator trägt unter Last | fünf Infrastrukturbefunde gemeldet und behoben (R86, R89–R93, R100) |

### Teilweise erfüllt

| Punkt | Was fehlt konkret |
| --- | --- |
| P0 Releasebasis | Studio und Renderer starten aus dem Arbeitsbaum (`tsx server/index.ts`), nicht aus einer unveränderlichen Revision oder einem digest-gepinnten Container. Die Python-Laufzeit ist die gemeinsame `comfyui-env` mit bekanntem `requests`/`urllib3`-Konflikt statt eines Lockfile-Builds. |
| P1 Canaries | Kontrollierte Cold/Warm-Paare existieren nur für two-stage und image-audio-to-video. Für id-lora, ic-lora und lipdub fehlt je die Gegenprobe, weil die Erstversuche an Infrastruktur scheiterten. Zudem liefen alle Canaries gegen einen damals uncommitteten Baum, also nicht „aus dem Release-Digest". |
| P1 Modus-Gating | Der Server blockiert fail-closed, aber die UI deaktiviert einen nicht abnahmefähigen Modus nicht sichtbar und nennt keine Abhilfe in normaler Sprache. |
| P5 Zyklen | Ein Zyklus ist bewiesen, 20 sind gefordert. Es fehlt die Instrumentierung: Pause-Latenz, freigegebener Speicher, Checkpoint-Hash, Resume-Latenz, Ausgabegleichheit werden pro Zyklus nicht aufgezeichnet. |

### Offen

| Punkt | Umfang |
| --- | --- |
| P2 Goldsatz und Holdout | Nichts davon existiert: mindestens 30 holdout-exklusive erwachsene Identitäten mit je drei Clips (≥ 90 Clips), plus getrenntes Tune-Set (fünf Referenzclips laut `LIPDUB_SOTA_PLAN.md`), mit ausgewogenen Strata (Sprache, FPS, Tempo, Geschlecht, Alter, Hautton, Beleuchtung). |
| P2 Kalibrierung | SFace-Identitätsschwelle ist nicht gegen echte Same-/Impostor-Paare kalibriert (Ziel TAR ≥ 95 % bei FAR ≤ 1 %). AV-Offset-Prüfer ist nicht gegen künstlich eingefügte Offsets kalibriert; die P/B/M-Schwellen sind gesetzt, aber nicht am Tune-Set hergeleitet. |
| P2 VBench | Nicht installiert (`/home/moddy/models/vbench` fehlt). |
| P2 MOS | Kein Protokoll für verblindete menschliche Bewertung mit zufälliger Armreihenfolge, Lautheitsnormalisierung und identitätsweise gebootstrappten Intervallen. |
| P3 Komparatoren | MOVA und Wan2.2-S2V sind lokal nicht vorhanden. LongCat 1.5 ist vorhanden; LatentSync, MuseTalk und LipForcing sind vorhanden und lauffähig. |
| P4 Produktionsworkflow | Vier-Seed-Draft mit objektiver Vorsortierung existiert nicht; die Korrelation Draft-Ranking ↔ HQ-Ranking ist unbelegt. Langvideo als Shot-Kette mit Continuity-Bindung und gezielten Retakes ist nicht durchgängig. |
| Abnahmegates | Kein Gate ist derzeit erfüllbar, weil alle ein kalibriertes Messsystem auf einem unberührten Holdout voraussetzen. |

---

## 2. Durchführungsplan

Die Phasen sind so geschnitten, dass jede für sich einen belastbaren Zustand
hinterlässt. A und B laufen ohne GPU und ohne Datenbeschaffung — sie sind
sofort startbar. Ab C hängt alles am Goldsatz; deshalb steht dessen
Beschaffung so früh wie möglich.

### Phase A — Releasebasis schließen (P0)

1. Python-Laufzeit pinnen: Lockfile- oder Container-Build für die
   Renderumgebung, der den `requests`/`urllib3`-Konflikt auflöst; die
   Laufprovenienz bindet den Digest.
2. Studio und Renderer aus dieser unveränderlichen Revision starten statt aus
   dem Arbeitsbaum.
3. DGX-Releasegate prüfen: kein `critical`, Swap ≥ 8 GiB frei, alle
   Warnungen entschieden.

**Exit:** Ein Cold Start aus dem Release-Digest erzeugt ein Video; die
Provenienz nennt Digest statt Arbeitsbaum-Diff.
**Aufwand:** überschaubar, kein GPU-Bedarf außer einem Nachweislauf.

### Phase B — P1 und P5 vollständig machen

1. Die drei fehlenden kontrollierten Warm-Läufe (id-lora, ic-lora, lipdub)
   nachziehen, danach alle zehn Canaries **aus dem Release-Digest** von
   Phase A wiederholen.
2. UI-Gating: Ein Modus, dessen Assets oder Canary fehlen, wird sichtbar
   deaktiviert und nennt die konkrete Abhilfe.
3. P5-Instrumentierung ergänzen: pro Pause/Resume-Zyklus Pause-Latenz,
   freigegebener Speicher, Checkpoint-Hash, Resume-Latenz und
   Ausgabegleichheit als Sidecar-Datensatz.
4. 20 reale Zyklen fahren, Ziel `paused und ressourcenfrei p95 < 60 s`.
5. 50-Job-Soak über Modi, Cancel, Neustart, Queue-Wartezeit und
   Thermalabbruch.

**Exit:** P1-Exit und P5-Exit des Audits erfüllt; Soak ohne verlorenen Job
oder beschädigten Output.
**Aufwand:** GPU-lastig, aber kurze Läufe; grob 30–50 GPU-Stunden inklusive
Soak.

### Phase C — Datengrundlage schaffen (P2, Voraussetzung für alles Weitere)

1. **Tune-Set:** fünf Referenzclips nach der Spezifikation in
   `LIPDUB_SOTA_PLAN.md` (frontal/ruhig, leichte Kopfbewegung,
   geschlossene ↔ offene Laute, 65–220 WPM, schwierige zulässige
   Beleuchtung).
2. **Holdout:** ≥ 30 Identitäten × 3 Clips, strikt disjunkt zum Tune-Set auf
   Identitäts-, Sprecher-, Quellvideo- und Session-Ebene, Strata ausgewogen.
3. Herkunft, Rechtegrundlage und Einwilligung je Identität dokumentieren.
4. Protokoll, Modelle, Gewichte, Evaluatoren, Gates, Prompts, Seeds und
   Auswerteskripte hashen und einfrieren — **vor** der ersten
   Holdout-Ausführung.

**Exit:** Tune-Set und Holdout liegen versiegelt vor, das Protokoll ist
gehasht, niemand hat ins Holdout gesehen.
**Aufwand:** Das ist der größte Brocken und kein Programmierproblem, sondern
Beschaffung. Ohne diese Phase ist keines der Abnahmegates erfüllbar.

### Phase D — Messsystem kalibrieren (P2)

1. SFace gegen echte Same-/Impostor-Paare aus dem Tune-Set kalibrieren,
   Schwelle mit Konfidenzintervall herleiten (Ziel TAR ≥ 95 % bei
   FAR ≤ 1 %).
2. AV-Offset-Prüfer gegen künstlich eingefügte Offsets kalibrieren
   (bekannte Verschiebung rein, gemessene Verschiebung raus).
3. P/B/M-Schwellen am Tune-Set festlegen: Mundschlusszeit,
   Closure-Recall, falsche Schließungen, Timing relativ zum Phonem.
4. VBench 2.0 lokal installieren und gegen bekannte Fälle prüfen.
5. Artefaktpfad kalibrieren: Fremdmund, Hautwobble, schiefer Mund,
   Nasensprung, Flimmern.
6. Abstention prüfen: Bei unbrauchbarem Input muss jeder Evaluator sich
   enthalten statt zu raten.

**Exit:** P2-Exit des Audits — die Evaluatoren trennen kontrollierte
Positiv- von Negativfällen und abstainieren korrekt.
**Aufwand:** rechenintensiv, aber überwiegend CPU; keine großen Renderläufe.

### Phase E — Bake-off und Abnahme (P3, dann die Gates)

1. Fehlende Komparatoren lokal beschaffen und je einen eigenen Canary
   fahren: MOVA (native Sprache), Wan2.2-S2V (Driving Audio / Portrait).
   LongCat 1.5 ist vorhanden.
2. Bake-off je Aufgabentyp mit identischen Eingaben, festen Seeds und
   gleicher Ausgabezeitachse; nicht vergleichbare Eingabeverträge nicht in
   einen gemeinsamen Score mischen.
3. Refiner-Entscheidung datenbasiert: automatisch nur, wenn Lip-Sync besser
   wird **und** Identität, Mundnatur und Hautstabilität ihre
   Nichtunterlegenheitsgates halten.
4. Holdout **einmal** ausführen, danach ist es verbraucht.
5. Verblindete MOS-Runde mit zufälliger Armreihenfolge und
   Lautheitsnormalisierung.

**Exit:** Pro Aufgabentyp ein statistisch belegter Gewinner oder eine klare
Abstention; alle Abnahmegates des Audits gleichzeitig belegt.
**Aufwand:** der GPU-teuerste Teil, siehe Abschnitt 3.

### Phase F — Produktionsworkflow (P4)

Parallel zu D/E machbar, für die 10/10-Aussage nicht blockierend:
Vier-Seed-Draft mit belegter Rangkorrelation zum HQ-Ergebnis, Langvideo als
Shot-Kette mit Continuity-Bindung, gezielte Retakes statt Vollneurender.

**Exit:** Ein reproduzierbarer Auftrag liefert Master, Sidecars, Scorecard,
Einstellungen und Retake-Historie ohne manuelle Dateiarbeit.

---

## 3. Realismus: was das kostet

Aus den gemessenen Canary-Zeiten (`docs/evidence/`) hochgerechnet, für
Clips der Zieldomäne (2–5 s):

| Posten | Größenordnung |
| --- | --- |
| Ein LipDub-Lauf bei 1216², 97 Frames | ~31 min |
| Ein ID-LoRA-Lauf bei 1024², 97 Frames | ~10 min |
| Holdout, 90 Clips, ein Arm | 15–45 GPU-Stunden |
| Holdout über vier Arme (Baseline + drei Refiner) | 150–200 GPU-Stunden |
| Zusätzlich zwei externe Komparatoren über dasselbe Holdout | 80–120 GPU-Stunden |
| Phase B (Canaries, Zyklen, Soak) | 30–50 GPU-Stunden |

In Summe liegt ein vollständiger Durchgang bei grob **300–400
GPU-Stunden**. Die DGX ist geteilt (Qwen-Lane, LongCat, Realtime-Dienste)
und rechnet einen Job zur Zeit; die Canary-Serie brauchte für zehn Läufe
gut 26 Stunden Wanduhr, davon ein erheblicher Teil Wartezeit. Realistisch
sind das **mehrere Wochen Kalenderzeit**, nicht Tage.

Empfehlung zur Staffelung: nach Phase D erst einen **Pilot** über 8–10
Identitäten fahren, um Messsystem und Pipeline zu härten, und das volle
Holdout erst danach anfassen — es ist einmalig verwendbar.

---

## 4. Was den Plan entwerten würde

- **Blick ins Holdout vor der Abnahme.** Jede Nutzung zur Fehlersuche,
  Schwellenwahl oder Baseline-Auswahl macht ein neues, unberührtes Set
  nötig.
- **Nachträgliche Änderung an Modellen, Evaluatoren, Gates, Prompts, Seeds
  oder Auswerteskripten** nach dem Einfrieren.
- **Vermischen der Claim-Domänen.** Musik, Übersetzung, mehrere Sprecher,
  starke Profilansichten und lange Clips brauchen je ein eigenes,
  vorab registriertes Holdout.
- **Ein Refiner, der automatisch eingeschaltet wird, weil er den Sync
  verbessert**, ohne dass Identität und Mundnatur ihre Gates halten.

## 5. Entscheidungen, die der Betreiber treffen muss

Diese drei Punkte kann die Umsetzung nicht selbst beantworten:

1. **Herkunft der Identitäten für Tune-Set und Holdout.** Eigene Aufnahmen,
   ein lizenzierter Datensatz oder eine Mischung — mit dokumentierter
   Rechtegrundlage. *Empfehlung:* lizenzierter Sprecherdatensatz mit
   klaren Nutzungsrechten für das Holdout, eigene Aufnahmen für das
   Tune-Set, weil dort iteriert wird.
2. **GPU-Budget und Zeitrahmen.** *Empfehlung:* Phasen A und B sofort, dann
   Pilot; das volle Holdout erst terminieren, wenn das Messsystem steht.
3. **Breite des Claims.** *Empfehlung:* eng bleiben — Deutsch/Englisch,
   frontal bis leichte Kopfbewegung, 2–5 s, saubere Sprache. Ein enger,
   belegter Claim ist mehr wert als ein breiter, der an einem Stratum
   scheitert.
