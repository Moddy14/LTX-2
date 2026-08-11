# Durchführungs- und Abnahmeplan bis SOTA 10/10

Stand: 2026-08-11. Dieses Dokument ist die kanonische Reihenfolge für die
noch offenen Arbeiten. Die Messdefinitionen in
`QUALITY_AUDIT_2026-08-03.md`, `LIPDUB_SOTA_PLAN.md` und
`packages/ltx-trainer/configs/av_eval/preregistration.v2.json` bleiben
maßgeblich. Widerspricht ein älterer Statussatz dem hier belegten Stand, gilt
dieser Plan.

SOTA bedeutet hier: vollständig lokale Ausführung auf der DGX, eine eng
benannte Claim-Domäne, reproduzierbare Release-Artefakte und gleichzeitig
bestandene technische, objektive, statistische und menschliche Gates. Ein
Mittelwert darf kein gerissenes Gate verdecken. Solange ein Pflichtgate fehlt,
lautet der ehrliche Status **nicht 10/10**.

## 1. Aktueller Befund

| Bereich | Stand am 11.08.2026 | Urteil | Priorität |
| --- | --- | --- | --- |
| Implementierungsbasis | Vor dieser Planrevision war Commit `41e4166` sauber; zuletzt 570/570 Studio-Tests, 60/60 native Tests, 53 E2E bestanden | gut, aber noch kein Release | P0 |
| DGX-Control-Plane | Der read-only Snapshot ist `overall=ok` und die Queue leer. `dgx-runtime-api.service` ist seit 07:42 jedoch inaktiv; Studio meldet deshalb `orchestrator=missing`, `runtimeOverall=unknown` | aktuelle Betriebsabweichung, Operator-Schritt nötig | P0 |
| Scheduler-Vertrag | Orchestrator hat den haltbaren LTX-Segment-Waiter, Heartbeat und `/dgx/scheduler/segment-boundary/decide`. Studio sendet Heartbeats, entscheidet das Yield aber weiterhin nur über den alten Qwen-Demand-Wächter | sicher fail-closed, aber fachlich unvollständig: andere wartende Jobs sind unsichtbar | P0 |
| Releasebasis | Dienst startet per `npm start`/`tsx` aus `/home/moddy/LTX-2`; Python fällt auf die gemeinsame `~/comfyui-env` zurück | veränderlich, nicht reproduzierbar | P0 |
| Python HTTP-Stack | `requests 2.32.5`, `urllib3 2.6.3`, `charset-normalizer 3.4.5`, zusätzlich `chardet 7.4.3`. Requests akzeptiert in dieser Version nur `chardet < 6`; Import mit Warnungen als Fehler schlägt fehl. `pip check` übersieht den optionalen Konflikt | realer Umgebungsfehler, durch Shared-Env verursacht | P0 |
| Frontend-Bundle | Vite erzeugt 533,43 kB initiales JS, 155,28 kB gzip. Es gibt keinen dynamischen Import. Große app-eigene Module sind insbesondere `Editor.tsx`, `fieldHelp.ts`, `App.tsx`, `RunPanel.tsx` und die Analyse-/Experiment-Panels | nicht blockierend; echte Startkosten optimieren, Warnlimit nicht nur erhöhen | P4 |
| Releaseoberfläche | `PIPELINES` veröffentlicht 12 Modi; IC-LoRA und LipDub besitzen zusätzliche Profile. Der alte Plan zählte nur fünf sichtbare Modi | alte Canary-Matrix unvollständig | P1 |
| Dataset-Governance | CAS-Freeze, Rechteledger, transitive Leakage-Komponenten und eine Draft-Preregistrierung existieren bereits. `profile=product` ist absichtlich hart blockiert, weil Signatur-, ACL-, Blind-Scorer- und Attestierungspfad fehlen | starke Grundlage, Product-GO offen | P2 |
| Tune/Holdout | Es gibt noch keinen rechtsgeprüften Kalibriersatz und keinen versiegelten Holdout. Fünf funktionale Tune-Clips reichen nicht zur biometrischen Schwellenkalibrierung | zentraler 10/10-Blocker | P2 |
| Cross-Shot | Szenengleiche Referenz verbessert im ersten A/B Kontinuität/Identität, fällt aber bei Schärfe auf `5,51` gegenüber `52,72`; der automatische Gegenlauf wurde noch schlechter | Hypothese plausibel, Kandidat nicht freigabefähig | P2/P4 |
| Video-Benchmark | VBench ist lokal nicht installiert. Für eigene I2V-Videos ist VBench++/VBench-I2V einschlägig; VBench 2.0 misst primär intrinsische Faithfulness und ersetzt weder Lip-Sync- noch Identitätsgates | alter Werkzeugname war zu pauschal | P2 |
| Komparatoren | LongCat ist lokal vorhanden. MOVA und Wan2.2-S2V fehlen lokal. MOVA und Wan haben unterschiedliche Eingabeverträge und dürfen nicht in einen gemeinsamen Score gezwungen werden | lokaler Bake-off offen | P3 |

Die 533-kB-Warnung ist somit der kleinste offene Punkt. Der
`requests`-Konflikt ist ein Symptom der fehlenden Releaseumgebung. Die
eigentlichen 10/10-Blocker sind Product-Governance, kalibrierte Daten,
Cross-Shot-Nichtunterlegenheit, Release-Canaries und der verblindete lokale
Bake-off.

## 2. Definition des finalen Gates

Ein neues fail-closed Release-Audit erzeugt `ltx-studio-release-audit.v1` mit
getrennten Achsen `production_overall` und `sota_overall`. Die App kann lokal
produktionsreif sein, ohne einen SOTA-Claim zu verdienen. `sota_overall=go` und
damit **10/10** ist nur zulässig, wenn alle folgenden Belege denselben
`release_digest`, dieselbe Preregistrierung und dieselbe Claim-Domäne binden:

1. Control-Plane und LTX-Consumer-Vertrag sind gesund; kein aktiver Bypass.
2. Studio, Server, Renderer, Evaluatoren und Refiner laufen aus unveränderlichen
   Artefakten; Run-Provenienz bindet Release- und Modell-Digests.
3. Jede veröffentlichte Modus-/Profilkombination besteht Cold und Warm. Nicht
   abgenommene Kombinationen sind aus der Releaseoberfläche entfernt, nicht nur
   durch einen Hinweis versteckt.
4. 50-Job-Soak und 20 reale Pause/Resume-Zyklen bestehen ohne verlorenen Job,
   beschädigten Checkpoint, fremden Service-Stopp oder Provenienzdrift.
5. Produktkalibrierung, Holdout, Cross-Shot, Identität, AV-Offset, P/B/M, WER,
   VBench-I2V und MOS bestehen gleichzeitig, einschließlich Worst-Stratum- und
   Konfidenzgrenzen.
6. Alle Daten- und Modellrechte sind zum Attestierungszeitpunkt gültig; der
   Holdout wurde nur über den unabhängigen Auswertungspfad geöffnet.
7. Jeder als SOTA beworbene `claim_id` bindet einen anwendbaren, rechtsklaren
   `sota_anchor`: einen lokal ausgeführten externen Spitzenkomparator mit
   identischem Inputvertrag oder einen vorab als benchmark-kompatibel
   begründeten externen Referenzarm. Der Kandidat schlägt ihn nach der
   eingefrorenen Regel. Fehlt ein solcher Anker, lautet der Claim
   `local-only`/`abstained` und `sota_overall` bleibt `hold`.
8. F0 bindet eine nichtleere Menge `target_sota_claim_ids`. `sota_overall=go`
   verlangt mindestens einen Target-Claim und `sota_qualified` für jeden
   einzelnen. Eine leere Menge oder das Entfernen eines Targets nach F0 kann
   niemals vakuos 10/10 ergeben.

Das Audit nennt bei jedem fehlenden oder unlesbaren Beleg `hold` oder
`critical`, niemals still `go`. Der Release-Digest ist der Fremdschlüssel aller
Canary-, Soak-, Mess- und MOS-Artefakte.

Die Phasen sind ein Abhängigkeitsgraph, kein einmaliger Wasserfall: Jede Änderung
an Code, Locks, Surface, Modell oder Evaluator erzeugt über R1 einen neuen
Digest und invalidiert alle davon betroffenen R3-/D1-/Q0-/Q1-/F0-/Q2-Belege.
Der erste R1-Digest ist ein Engineering-Kandidat; der Holdout läuft
ausschließlich auf dem nach Q0 und Q1 neu gebauten, in F0 vollständig
eingefrorenen Finalkandidaten.

Treffen mehrere Zeilen zu, gilt die Vereinigungsmenge aller Invalidierungen.

| Änderung | zwingend neu zu erzeugende Belege |
| --- | --- |
| Control-Plane-/Scheduler- oder Handshake-Code | R0, R1, alle betroffenen R3-Canaries/Zyklen/Soak |
| App-Code, Lock, Buildtool, Surface, Modell oder Gewicht | R1 und alle nachgelagerten Belege des neuen Digests |
| Evaluator, Fingerprint, Threshold oder statistisches Delta | D1, Q0, Q1, F0 und Q2; bei manifestgebundenem Evaluator zusätzlich R1/R3 |
| Comparator, Prompt, Seed-Policy oder Inputnormalisierung | Q1, F0 und Q2 |
| VBench-Gate oder Delta | D0a, D1, Q0, Q1, F0 und Q2 |
| `anchor-landscape` oder gewählter SOTA-Anker | Q1, F0 und Q2; ändert sich Comparator-Code/-Gewicht, zusätzlich die R1-Modellzeile |
| statische Rights-Policy-Version, Lizenztext-/Evidence-Hash oder SBOM | R1 und alle nachgelagerten digestgebundenen Belege |
| nur zeitvariables Rights-Attest bei unveränderten Evidence-Hashes | D0, F0, Q2 und P4 gemäß eingefrorener Policy; kein neuer Inhaltsdigest |
| Datenquelle, Split oder Stratum | D0 und alle datenabhängigen Belege |
| Holdout-Offenlegung oder Änderung nach F0 | neuer disjunkter Holdout und neuer F0; kein Nachbessern am verbrauchten Satz |

## 3. Ausführungsreihenfolge

### R0 — Control-Plane und Scheduler-Vertrag schließen

1. Der Betreiber führt den aktuellen Orchestrator-Restart-Preflight aus und
   entscheidet über den Start von `dgx-runtime-api.service`. Studio oder dieser
   Plan starten den fremden Dienst nicht selbst.
2. Nach dem Betreiberstart müssen `/health`, `/dgx/status`, Studio
   `/api/health` und die Consumer-Policy gleichzeitig grün sein. Ein grüner
   Modul-Snapshot bei inaktiver API reicht nicht.
3. In `server/admission.ts` über den gehärteten Transport aus
   `server/runtimeApi.ts` einen typisierten Client für
   `POST /dgx/scheduler/segment-boundary/decide` ergänzen. In `server/jobs.ts`
   ersetzen die kanonischen Entscheidungen sowohl `watchQwenDemand` als auch
   `waitForQwenIdleGrace`; lokaler Qwen-Demand darf höchstens als geschütztes
   Sicherheitssignal bestehen bleiben, nie als zweite Scheduling-Wahrheit.
4. Der Python-Runner schreibt an **jeder** tatsächlichen Euler-Grenze atomar ein
   `boundary-ready` mit Job-ID, Run-Fingerprint und persistierbarer
   `boundary_id = generation:loop_index:next_step_index` und wartet auf Node.
   Node holt erst dann die frische Schedulerentscheidung und antwortet atomar
   mit genau diesen Bindungen. Die Antwort wird exactly-once konsumiert. Eine
   alte, vorab gepollte oder zu einer anderen Grenze/Generation gehörende
   Entscheidung ist ungültig; sie darf weder Weiterlauf noch Resume erlauben.
   Kommt binnen `10 s` keine gültige Antwort, schreibt der Runner an dieser
   sicheren Grenze atomar den Checkpoint und endet mit Exit `75`; er rechnet nie
   blind weiter. Der p95 für Checkpoint plus Ressourcenfreiheit bleibt unter
   dem R3-SLO von `60 s`. Nach Node-Restart reconciled Studio den persistierten
   Grenz-/Checkpointzustand, statt eine alte Antwort anzunehmen.
5. Die vollständige Zustandsmaschine implementieren:

   | aktueller Zustand | Action | Caller-Reaktion |
   | --- | --- | --- |
   | `running` | `continue_current` | unbestätigten Yield-Request entfernen und nächsten Slice rechnen |
   | `running` | `yield_to_waiting_job` | `running -> pausing`, atomaren Checkpoint anfordern, eigenen Prozess beenden, Speicherfreiheit belegen, erst dann `paused` melden |
   | `paused` | `wait_for_successor` | ohne Worker und ohne aktiven Owner-Heartbeat pausiert bleiben; nach `retry_after_seconds` erneut pollen |
   | `paused` | `resume_current` | frische Admission, `paused -> resuming`, Checkpoint laden, danach `running` |

   API-/Schemafehler sind zustandsabhängig fail-closed: Ein laufender Slice
   fordert sicheren Yield an; ein pausierter Lauf bleibt mit Backoff pausiert.
   Nie blind resümieren und nie einen fremden Dienst starten oder stoppen.
6. Contracttests mit echten Response-Shapes für alle vier Actions,
   Transportverlust in beiden Zuständen, Statuswechsel und Reconciliation nach
   Runtime-API-, Studio- und Runner-Restart ergänzen. Der aktive Heartbeat bleibt
   getrennt von fachlichem Fortschritt und endet nach bestätigtem Prozessende.
   Zusätzliche Tests lassen zwischen zwei Boundary-IDs einen Waiter eintreffen
   beziehungsweise verschwinden und verbieten die Wiederverwendung der ersten
   Entscheidung.

**Exit R0:** Live-API aktiv; Studio meldet Orchestrator `available`; ein
instrumentierter LTX-Lauf yieldet für einen vom Betreiber genehmigten,
allowlisteten Wegwerf-Nicht-Qwen-Waiter und setzt denselben Orchestrator-Record
über `paused -> resuming -> running` fort. Beide Records enden terminal und
werden über normale APIs bereinigt; keine Qwen-, Queue- oder State-Datei wird
künstlich manipuliert.

### R1 — Unveränderliche Releasebasis und eigener Python-Stack

Die Releasebasis wird content-addressed statt arbeitsbaumgebunden. Ein kompletter
OCI-Umbau des nativen Renderers ist nicht der erste Weg: Er würde CUDA-,
Orchestrator- und Modellmount-Verträge gleichzeitig verändern. Die bereits
isolierten Refiner bleiben digest-gepinnte Container; Studio und nativer
Renderer erhalten eine unveränderliche Releasewurzel.

1. Vor dem Build eine schema-validierte
   `candidate-release-surface.v1.json` aus Request-Schema und Capability-Matrix
   einfrieren. Sie beschreibt nur zulässige Kombinationen und deren Zielstatus;
   technische Canaries oder Qualitätsfreigaben verändern diese Datei nicht.
   Vor jedem R3-Lauf müssen Code- und Gewichtslizenzen inventarisiert sein;
   unklare oder nichtkommerzielle Pfade stehen bereits hier auf `blocked`.
2. Einen eigenen Runtime-Projektvertrag unter `apps/ltx-studio/runtime/`
   einführen (`pyproject.toml`, eigenes `uv.lock`). Er enthält nur den nativen
   LTX-Produktionsstack und lokale Workspace-Pakete. Build mit
   `uv sync --locked --no-dev --no-editable --compile-bytecode`; keine
   editierbaren Pfade und keine Pakete aus `comfyui-env`.
3. Im Releasegate mindestens prüfen:
   - `uv lock --check` und exakter Environment-Sync;
   - `uv pip check --python <release-python>`; falls `pip` selbst benötigt wird,
     ist auch dessen Version im Lock gebunden;
   - `python -W error -c 'import requests'`;
   - Abwesenheit nicht deklarierter Pakete, insbesondere eines inkompatiblen
     `chardet`;
   - Import und kleiner CPU-Smoke von `torch`, `ltx_core` und `ltx_pipelines`.
4. Frontend mit `npm ci` und Vite bauen; Server/Shared-Code mit einem separaten
   Emit-`tsconfig` zu JavaScript kompilieren. Produktion darf weder `tsx` noch
   Source-Dateien aus dem Arbeitsbaum laden.
5. Ein kanonisches `release-manifest.json` ohne Self-Hash erzeugen. Stabile
   Pfadreihenfolge, kanonische JSON-Serialisierung, normalisierte Dateimodi und
   `SOURCE_DATE_EPOCH` verhindern Zeit-/Pfaddrift; absolute Buildpfade und
   nichtdeterministische Source-Map-Metadaten sind ausgeschlossen. Der extern
   berechnete SHA-256 ist der `release_digest`; Signatur und Attestierung liegen
   separat und binden diesen Digest. Gebunden werden mindestens Git-Commit und
   Clean-Status, `package-lock.json`, Runtime-`uv.lock`, Node/Python/uv-Versionen,
   alle Server-/Frontend-Artefakte, Python-Paketinventar, alle Modell-, Adapter-,
   Tokenizer- und LoRA-Digests, Refiner-Image-Digests, Evaluator-Manifest,
   statisches SBOM, unveränderliche Lizenztext-/Evidence-Hashes,
   Rights-Policy-Version sowie die eingefrorene Candidate-Surface.
6. Den Build zweimal aus sauberen, getrennten Wurzeln erzeugen. Nur identische
   Manifeste und Digests dürfen weiter; Abweichungen werden bis auf Datei- und
   Metadatenebene erklärt und behoben.
7. Nach `/opt/ltx-studio/releases/<release_digest>/` installieren, ohne
   Laufzeit-Schreibpfade in dieser Wurzel. Daten, Uploads, Jobs und Outputs
   bleiben außerhalb. Unit und Environment nennen einen erwarteten Digest; der
   Prozess verweigert den Start bei Manifestdrift.
8. `server/releaseIdentity.ts`, `/api/health` und
   `ltx-studio-run-provenance.v2` binden Release-ID und Manifest-Hash. Ein
   schmutziger Baum darf weiter Entwicklungsläufe erzeugen, aber niemals ein
   Release-Attest.
9. Zweiphasiges Deployment: Build/Verify ohne Serviceänderung, read-only
   Job-Preflight mit leerer aktiver Jobmenge, kontrollierter Betreiberwechsel
   über atomaren `current`-Symlink/Unit-Switch, Health/Smoke, anschließend
   Canary. Veränderliche Daten werden vorher gehasht und gesichert. Jede
   Migration ist schema-versioniert und nachweislich rückwärtskompatibel; sonst
   gilt vor dem Wechsel ein ausdrückliches No-Rollback-Gate. Vorherigen Digest
   behalten und Restore plus Rollback-Canary testen. Nie während eines aktiven
   GPU-Jobs umschalten.

**Exit R1:** Ein Cold-Canary startet aus dem installierten Releasepfad, der
`requests`-Import ist warnungsfrei, `/api/health` und die Output-Provenienz
nennen denselben Digest, und eine absichtliche Artefaktänderung blockiert Start
beziehungsweise Freigabe.

### R2 — Bundle-Hinweis durch reale Startkosten schließen

1. Einen reproduzierbaren Bundlebericht mit Input-/Chunk-Zuordnung sowie Raw-,
   gzip- und Brotli-Größe versionieren. Der heutige Ausgangspunkt ist
   533,43/155,28 kB (raw/gzip).
2. Selten benötigte Experiment-, objektive Analyse- und Vergleichsansichten
   über `React.lazy`/dynamische Imports laden. Editor, Moduswahl und Run-Status
   bleiben im initialen Pfad. Shared Zod-Schemas werden nur dort in den Client
   gezogen, wo Laufzeitvalidierung tatsächlich stattfindet.
3. Kein kosmetischer Fix: `chunkSizeWarningLimit` wird nicht erhöht und ein
   manueller Vendor-Chunk ohne geringere Initiallast gilt nicht als Erfolg.
4. E2E deckt Lazy-Load-Erfolg, Ladefehler und einen Deploywechsel mit alten
   Chunks ab. Die Performance-Messung pinnt Chromium-, Node- und Hostprofil,
   misst tatsächlich übertragene Bytes und fährt je Basis/Kandidat mindestens
   40 kalte, cachefreie Browserkontexte auf Loopback. Bericht: N, Median, p95
   und Streuung für erste bedienbare Moduswahl.

**Exit R2:** Initiales JS höchstens 450 kB raw und 140 kB gzip, keine
Vite-Chunkwarnung, alle E2E grün und kein schlechterer p95-Wert für erste
bedienbare Moduswahl gegenüber dem vorab gespeicherten Basislauf.

### R3 — Releaseoberfläche, Canaries, Soak und Pause/Resume

1. Die Candidate-Surface aus R1 wird aus den tatsächlich zulässigen
   Kombinationen generiert, nicht als kartesisches Produkt. Jeder Eintrag bindet
   `claim_id`, Capability-Anforderungen und `applicable_gates`; ein
   `not_applicable` braucht einen schema-validierten Grund. So bekommt etwa
   Audio-only keine Video-/Mundgates.
2. Für jeden als Releasekandidaten markierten Eintrag einen kleinen, aber
   semantisch echten Cold- und Warm-Canary aus R1 fahren. Jeder Bericht bindet
   Input, Seed, Modelle, Release-Digest, DGX-Job, Speicher, Thermik, Laufzeit,
   Output-Hash und technisches Qualitätsminimum. Ein technischer Canary ist
   keine Qualitätsfreigabe. Alte Canaries aus schmutzigen Bäumen sind
   historische Diagnose, keine Releasebelege.
3. Pause/Resume-Sidecar ergänzen: Schedulerentscheidung, Request-/Checkpoint-ID,
   Manifest- und State-Hash, Pause-Latenz, Prozessende, MemFree vor/nach
   zentralem Reclaim, Resume-Latenz, Heartbeats und finaler Outputvergleich.
4. Vorab eine feste 20-Zeilen-Zyklusmatrix hashen, die jede kooperative
   Modusfamilie sowie frühe, mittlere und späte Boundary-IDs abdeckt. Diese 20
   realen Zyklen fahren. Gates: Pause und nachgewiesene
   Ressourcenfreiheit p95 unter 60 s; Resume p95 unter 120 s; keine neue
   Job-ID; kein beschädigter Checkpoint; identischer finaler Output-Hash zur
   ununterbrochenen Kontrolle bei identischem Seed. Zunächst wird bitweise
   Deterministik mit gepinntem Decoder empirisch geprüft. Ist sie technisch
   nicht haltbar, muss vor dem Zyklustest eine paarige Äquivalenzregel mit
   beidseitigen Delta-Grenzen, 95-%-Intervall und Audio-, Video- und
   Latent-Oracles je Seed festgeschrieben werden; bloße Nichtunterlegenheit
   reicht nicht.
5. Vorab eine feste `soak-matrix.v1.json` mit genau 50 Zeilen, Modus-/Profil-
   Verteilung, Seeds, Fault-Injection-Zeitpunkt, erwartetem Zustandsverlauf und
   Recovery-SLO hashen. Success-Zeilen müssen `completed`, spielbar,
   provenanceverifiziert und outputgebunden enden; Fault-Zeilen exakt im
   registrierten terminalen oder wiederhergestellten Zustand. Nulltoleranz:
   verlorene, verwaiste oder duplizierte Jobs, ungebundene Outputs und fremde
   Serviceaktionen jeweils `0`. Nach Studio-Restart ist persistierter State in
   höchstens `30 s` reconciled; während API-Ausfall startet kein Bypass und
   nach Rückkehr stimmt der State binnen zwei Pollperioden; Cancel beendet den
   eigenen Prozess und persistiert terminal binnen `60 s`. Thermal- und
   Yield-Recovery verwenden die SLOs aus Schritt 4. Kein fremder Dienst wird
   vom Studio gestartet oder gestoppt.

**Exit R3:** Die digestgebundene Qualification-Matrix ist vollständig grün;
kein Releasekandidat beruht nur auf manueller Erinnerung oder einem alten
Canary. Die spätere Promotion zu `released` ist ein signiertes Audit-Attest;
eine Änderung der Candidate-Surface erzeugt dagegen zwingend einen neuen
Release-Digest und neue betroffene Canaries.

### D0a — Design-Pilot und feste statistische Vorgaben

Dieser Pilot verwendet ausschließlich eigene beziehungsweise ausdrücklich für
Entwicklung freigegebene Daten und öffnet weder Kalibriersatz noch Holdout. Er
ist als eigenes Split-Rollenkürzel registriert und auf Identitäts-, Sprecher-,
Session-, Quell- und transitiver Leakage-Komponentenebene disjunkt zu beiden.

1. Mit Funktions-Tune und zusätzlicher Dev-Pilotstichprobe
   Wiederholungsannotation, Test-Retest-Streuung, Clustereffekt und erwartete
   Basisraten für alle primären und Guardrail-Metriken schätzen.
2. Einen numerischen, versionierten Delta-Katalog einfrieren. Er enthält für
   Q0 sowohl ein positives, fachlich relevantes
   `delta_superiority_identity` aus Reliability-/MOS-Ankern als auch
   beidseitig begründete Nichtunterlegenheitsdeltas für Schärfe, Lip-Sync,
   Mundnatur, Hautstabilität und Dialogtreue.
3. Einen `vbench-gates.v1`-Katalog einfrieren: offizieller Commit und Config,
   je Claim nur unterstützte Dimensionen, Messrichtung, Baseline und
   ankerunabhängige absolute Mindestwerte beziehungsweise fachlich begründete
   NI-/Superiority-Deltas sowie Holm-korrigierte 95-%-Grenzen. Der spätere
   Gegner darf diese Grenzen nicht verändern. Nicht unterstützte Inputs führen
   zur Abstention; Dimensionen werden nie zu einem verdeckenden Gesamtscore
   gemittelt.
4. Simulations-/Präzisionsanalyse auf der unabhängigen Einheit
   Identität/Sprecher/transitive Leakage-Komponente ausführen. Sie bindet
   family-wise Alpha `0,05` mit Holm-Korrektur, mindestens `90 %` Power und
   maximale CI-Breiten für FAR, TAR, Worst-Strata, MOS, VBench-Endpunkte und
   Q0. Ergebnis sind feste N für Kalibrierung, Holdout und Q0 sowie eine vorab quotierte
   Strata-Matrix. Nur ein schon hier registriertes, verblindetes sequenzielles
   Design dürfte N später ändern.

**Exit D0a:** Delta- und VBench-Gate-Katalog, Powerreport, feste N und
Quotierung sind gehasht; kein nachfolgender Pilot darf sie anhand günstiger
Ergebnisse ändern.

### D0 — Produkt-Governance und statistisch ausreichende Datengrundlage

Die vorhandene Governance wird fertiggestellt, nicht neu erfunden.

1. Folgende Bausteine für den Product-HOLD in
   `ltx_trainer.av_eval.governance` fertigstellen: detached Signaturverifikation und
   Trusted-Key-Policy, getrennte OS-ACL für den versiegelten Testbestand,
   append-only Zugriffslog, unabhängiger Blind-Scorer, aktuelle
   Widerrufs-/Ablaufprüfung, maschinenvalidierte Tune-/Holdout-Berichte und
   zwei getrennte Signaturschemas. F0 darf eine eng gebundene, einmalige
   `evaluation_authorization` nur für Q2 ausstellen; erst P4 darf nach bestandenem
   Q2 eine `release_authorization` für Produktion ausstellen. Ein
   Evaluationsrecht ist keine Produktfreigabe.
2. Vier Datensätze strikt trennen:
   - **Funktions-Tune:** mindestens die fünf bereits spezifizierten Clips für
     schnelle Pipelineiteration;
   - **Design-Pilot:** ausschließlich D0a; identitäts-, sprecher-, session-,
     quellen- und leakage-komponenten-disjunkt zu Kalibrierung und Holdout;
   - **Kalibriersatz:** identitäts-, sprecher-, session- und
     quellen-disjunkt zum Holdout; nicht nur fünf Clips, sondern per
     vorregistrierter Power-/Präzisionsanalyse dimensioniert, mit
     `max(D0a-Power-Ergebnis, 30 erwachsene Identitäten)` und mindestens drei Clips
     je Identität;
   - **versiegelter Holdout:** mindestens 30 exklusive Identitäten und drei
     Clips je Identität, tatsächlich aber die vor dem Freeze berechnete feste
     Stichprobe. Die 30er-Grenze sichert nur Mindestabdeckung und ist kein
     Power-Nachweis für FAR `1 %`.
3. Alle Strata der in D0a vorab quotierten Matrix erfüllen,
   nicht als implizites Vollfaktoriell: de/en, 24/25/30 fps,
   65–220 WPM, Geschlecht, Altersband, Fitzpatrick 1–6, Standard/schwieriges
   Licht, statische/leichte Kopfbewegung und registrierte OOD-Fälle.
4. Rechteledger verlangt je Quelle explizit Training, Featureextraktion,
   Gesichts-/Stimmenbiometrie, abgeleitete Gewichte, kommerzielle Nutzung und
   die vorgesehene Weitergabe. Widerruf entfernt eine Quelle fail-closed aus
   jeder neuen Attestierung.
5. Für jeden Candidate-Surface-Eintrag Code-, Gewicht-, Datensatz-,
   Biometrie- und kommerzielle Rechte prüfen. Das zeitvariable, signierte
   Rights-Attest liegt außerhalb des Inhaltsmanifests und referenziert
   `release_digest`, Evidence-Hashes, Policy-Version, `valid_at`, `expires_at`
   und `revocation_state`. Das gilt auch für bestehende Refiner und
   Identitätsevaluatoren; unklare oder nichtkommerzielle Rechte erzwingen
   `blocked`.
6. Modellrezept, initiale Gewichte, Trainings-/Evaluationsrunner, Suchraum,
   Promptsatz, Ratingprotokoll, vorläufige Baseline-/Comparator-Matrix und alle
   Revisionen zu einem `ready-to-freeze`-Paket hashen. Es ist noch kein Freeze:
   Q0 und Q1 dürfen die endgültigen Arme auf Kalibrierdaten auswählen.

**Exit D0:** Das `ready-to-freeze`-Paket und eine frische Rechteattestierung
sind vollständig; ACL und Auditlog beweisen, dass Entwicklungsprozesse keinen
Holdoutzugriff besitzen. Der Status bleibt bis F0 `draft`.

### D1 — Evaluatoren und Schwellen kalibrieren

1. Den eigenen dualen AV-Evaluator auf Train/Tune entwickeln und seine
   Schwellen ausschließlich auf dem getrennten Kalibriersatz festlegen; der
   Holdout bleibt geschlossen. Künstliche Audio-/Video-Offsets decken
   Vorzeichen, 0 ms, Subframe-, Einframe- und Mehrframefehler ab.
2. Zwei verschiedene Offsetgates nicht vermischen:
   - Messfehler des Evaluators: Median höchstens 20 ms, p95 und obere
     Bootstrap-95-Grenze höchstens 40 ms, mindestens 95 % innerhalb eines
     Frames;
   - Qualität der erzeugten Videos: vorregistrierter AV-Offset p95 höchstens
     80 ms.
3. P/B/M-Inhaltsgates auf annotierten Lautgrenzen kalibrieren: bilabiale
   Closure, falsche Schließungen, Öffnung, Rundung und Transitions-F1.
4. SFace auf echten Same-/Impostor-Paaren mit identitätsweisem Bootstrap
   kalibrieren. Zielpunkt: TAR mindestens 95 % bei FAR höchstens 1 %; die
   Konfidenzgrenzen, nicht nur die Punktschätzung, müssen bestehen. In jedem
   kritischen Pose-/Licht-/Hautton-Stratum gelten FAR höchstens `3 %` und FRR
   höchstens `10 %`, jeweils einschließlich der ungünstigen 95-%-Grenze.
5. Referenzschärfe relativ zu Gesichtsgröße und Auflösung kalibrieren. Der
   heutige Rohwert `35` bleibt bis dahin nur Guardrail; bekannte Werte um `85`
   sind ein Pilotziel, kein universelles Releasegate.
6. Den bewegungskompensierten Artefaktpfad auf annotierten Positiv- und
   Negativfällen kalibrieren: Fremdmund, Hautwobble, Flimmern, schiefer Mund,
   Nasensprung und Warp-Residual im Hautring. Das p95-Warp-Residual ist
   höchstens `0,04` insgesamt und `0,06` je Bewegungs-/Licht-Stratum;
   mindestens `99 %` der Frames bleiben unter der anwendbaren Grenze. Für die
   Ereigniserkennung gelten einschließlich ungünstiger 95-%-Grenze FAR
   höchstens `1 %` und FRR höchstens `5 %`. Eingabefingerprints einfrieren.
7. ASR/WER gegen menschlich geprüfte Transkripte kalibrieren. Gesamt- und
   Strata-WER sind höchstens `5 %`/`10 %`, ihre oberen 95-%-Grenzen höchstens
   `6 %`/`12 %`. Namen, Zahlen und Negationen erreichen mindestens `99 %`
   kritische Tokengenauigkeit und dürfen nicht durch den Gesamt-WER verdeckt
   werden.
8. VBench am gepinnten offiziellen Commit separat installieren. Für die
   tatsächlichen I2V-Ausgaben VBench++/VBench-I2V und dessen unterstützte
   Custom-Input-Dimensionen verwenden: Subject/Background Consistency,
   Motion Smoothness, Dynamic Degree, Aesthetic und Imaging Quality.
   VBench 2.0 kann ergänzend intrinsische Faithfulness prüfen, ist aber kein
   Ersatz für AV-, Identitäts- oder Cross-Shot-Messung. Positiv-/Negativfälle
   müssen pro Claim exakt den D0a-Katalog mit Richtung, absoluten/NI-Grenzen und
   korrigierten Intervallen bestehen.
9. Den in D0a eingefrorenen Delta-Katalog und Powerreport gegen die beobachtete
   Kalibrierverteilung verifizieren, ohne N oder Grenzen zu ändern. Eine
   Verletzung führt zurück zu D0a und verlangt neue, noch ungeöffnete
   Kalibrier-/Holdout-Bestände.
10. Jeder Evaluator muss auf unbrauchbaren, OOD- oder unlesbaren Fällen
   abstainieren. Kalibrierung, Modelle und Thresholds werden danach
   eingefroren.

**Exit D1:** Alle Positiv-/Negativkontrollen, Worst-Strata, Calibration-ECE,
Brier-Score und OOD-Abstention bestehen die in der Preregistrierung gebundenen
Grenzen.

### Q0 — Scharfer Cross-Shot-Entwicklungsnachweis

Dieser Schritt wählt die Produktregel; er ist noch keine Holdout-Abnahme.

1. Eine neue ruhige, helle und nahe szenengleiche Quelle erstellen oder ein
   hochauflösendes Original nachweisbar in dieselbe Szene überführen. Vor D1
   gilt `>=85` lokale Gesichtsschärfe nur als bewusst konservatives Pilotziel;
   nach D1 gilt die kalibrierte Grenze.
2. Vor dem Render ein Protokoll für drei Arme einfrieren: ohne Referenz,
   manuell gewählte scharfe Szenenreferenz, automatisch gewählte
   Szenenreferenz. Identische Dialoge, Seeds, Dauer und Renderrevision; nur die
   Referenzstrategie darf variieren.
3. Die Cross-Shot-Stichprobe ist `max(D0a-Q0-Power-Ergebnis, 30 Identitäten)` mit
   mindestens zwei unterschiedlichen Dialogshots je Identität und derselben
   gebundenen Referenz. Messen: Face-Track-Abdeckung, kalibrierte
   Same-Identity-Entscheidung und Cross-Shot-Minimum, Gesichts-/Mundschärfe,
   Haut-/Nasen-/Mundstabilität, Öffnung/Rundung/P/B/M, AV-Offset, WER,
   VBench-I2V-Dimensionen und verblindete MOS.
4. Vor dem ersten Render bindet das D0a-Design die numerischen Deltas. Der
   primäre Überlegenheitsendpunkt ist das gepaarte Cross-Shot-Minimum der
   kalibrierten Same-Identity-Wahrscheinlichkeit. Der Kandidat gewinnt nur,
   wenn dessen Holm-korrigierte 95-%-Untergrenze über dem positiven
   `delta_superiority_identity` liegt und gleichzeitig
   die Untergrenzen für Schärfe, Lip-Sync, Mundnatur, Hautstabilität und
   Dialogtreue über ihren jeweiligen negativen Deltas liegen. Ein
   Identitätsgewinn bei erneut massiv weicherem Gesicht ist ein Fail.
5. Automatische Auswahl bleibt standardmäßig aus, bis sie auf dem
   Kalibriersatz gegenüber manueller Auswahl nicht unterlegen ist. Die
   bestehende manuelle Wahl bleibt mit vollständiger Herkunftsbindung
   verfügbar.

**Exit Q0:** Der vorregistrierte Pilot über das berechnete N liefert nach den
festen Grenzen einen klaren Sieger oder eine ehrliche Abstention. Erst danach
wird die Siegerstrategie in die Holdout-Baseline-Matrix aufgenommen.

### Q1 — Lokaler Comparator-Pilot auf Kalibrierdaten

1. Mit dokumentiertem Cutoff-Datum eine reproduzierbare Landschaftssuche in
   Primärpapieren, offiziellen Repositories und anwendbaren Leaderboards
   durchführen. `anchor-landscape.v1` protokolliert Suchraum, Ein-/Ausschlüsse,
   Lizenzen, Inputverträge, verfügbare Gewichte und begründet je Claim den
   aktuell stärksten lokal beziehungsweise benchmark-kompatibel prüfbaren
   Anker. Der spätere SOTA-Satz nennt dieses Cutoff-Datum.
2. Vor dem Freeze eine task-spezifische Comparator-Matrix registrieren:

   | Claim | identische zulässige Inputs | zulässige Arme |
   | --- | --- | --- |
   | native Dialoggenerierung | Prompt/Dialog, optional dasselbe Startbild; kein Zielaudio | LTX-native; MOVA nur bei exakt kompatiblem Vertrag |
   | Driving Audio/Portrait | dasselbe Portrait und derselbe Audiotrack | LTX IA2V/A2V, Wan2.2-S2V und LongCat, soweit der jeweilige Arm exakt diese Inputs akzeptiert |
   | Referenzvideo-Redubbing | dasselbe Referenzvideo und derselbe Zieltext | LTX LipDub und nur Komparatoren mit demselben Text-/Video-Vertrag |

   Jede Zeile bindet Timeline-/Auflösungsnormalisierung, Seed oder dokumentierte
   Seed-Policy, Failure/Abstention nach Intention-to-treat und die anwendbaren
   Gates. Zusätzlich nennt jeder geplante SOTA-Claim genau einen
   `sota_anchor` und die Regel, nach der er geschlagen werden muss. Ergebnisse
   werden nie claimübergreifend gemittelt. Nach der Landschaftssuche bindet die
   Matrix Anchor-/Baseline-Digest an die unveränderten D0a-Gates; ein
   Ankerwechsel darf keine Grenze optimieren.
3. Komparatoren erst nach Lizenz- und Ressourcenprüfung commit- und
   gewichtsdigest-gepinnt lokal installieren. Wan2.2-S2V verlangt laut
   offiziellem Single-GPU-Pfad mindestens 80 GB und braucht einen eigenen
   Orchestrator-Consumer; MOVA bleibt außerhalb jeder Zeile mit inkompatiblem
   Eingabevertrag.
4. Vor jedem Qualitätslauf objektive Inclusion-/Exclusion-Kriterien hashen:
   Rechte, identischer Inputvertrag, reproduzierbarer Start, Ressourcenfit und
   vorab definierte technische Mindestfunktion. Ein Qualitätsresultat darf
   einen anwendbaren starken Gegner nie entfernen. Technisches Versagen zählt
   nach ITT oder begrenzt den Claim auf `local-only`; es erzeugt keinen
   bequemeren SOTA-Vergleich.
5. Da die Preregistrierung noch `draft` ist, vor dem Freeze entscheiden, ob
   MOVA als eigener Arm aufgenommen oder ausdrücklich außerhalb des Claims
   gehalten wird. Nach dem Freeze keine nachträgliche Favoritenaufnahme.
6. Einen Pilot auf ausschließlich Kalibrierdaten fahren. Fehler führen zu
   neuer Release-/Evaluatorrevision und über die Invalidierungsmatrix zurück zu
   den betroffenen Gates, niemals zur Inspektion des Holdouts.

**Exit Q1:** Je Claim steht die endgültige Arm-/Abstention-Entscheidung fest;
Inputs, Normalisierung, Failure-Regeln und Comparator-Digests sind vollständig
und auf Kalibrierdaten ausführbar.

### F0 — Stabiler Finalkandidat und signierter Freeze

1. Q0-Sieger/Abstention und Q1-Comparator-Matrix in das
   `ready-to-freeze`-Paket übernehmen. Kein Holdoutwert ist bekannt.
2. Jede Änderung aus Q0/Q1 nach der Invalidierungsmatrix zurückführen. Erst wenn
   keine Code-, Modell-, Evaluator-, Threshold-, Delta-, Comparator-, Prompt-
   oder Surface-Änderung mehr offen ist, den finalen R1-Digest bauen und alle
   betroffenen R0-/R3-Belege auf genau diesem Digest wiederholen. Der finale
   Doppelbuild läuft erneut in zwei **neuen** getrennten, sauberen Wurzeln; ein
   früherer Engineering-Bericht darf nicht übernommen werden.
3. Claim-Domäne, feste Stichproben, Split-/Leakage-Commitments, Arme,
   Inputnormalisierung, Prompts, Seeds/Seed-Policy, Evaluatoren, Thresholds,
   Deltas, ITT-/Abbruchregeln, MOS-Protokoll, Multiplicity und alle Digests in
   die Preregistrierung schreiben. Außerdem eine nichtleere Menge
   `target_sota_claim_ids` festschreiben; jeder Target-Claim besitzt bereits
   einen anwendbaren `sota_anchor`. Der unabhängige Account wechselt das Paket
   dann einmalig von `draft` auf signiert `frozen`.
4. Eine Post-Freeze-Änderung erzeugt eine neue Preregistrierung und einen neuen
   disjunkten Holdout; sie darf nicht als Revision desselben Tests erscheinen.
   Das Entfernen eines Target-Claims zählt als solche Änderung.
5. Für den finalen Digest, die endgültige Surface, Modelle, Evaluatoren und
   Comparatoren ein frisches Rights-Attest ausstellen, dessen Gültigkeitsfenster
   Q2 und P4 abdeckt. Danach signiert der unabhängige Autorisierer genau eine
   zeitlich begrenzte `evaluation_authorization`, gebunden an Release-Digest,
   Prereg-Digest, Holdout-Digest, Runner-Digest, Nonce, `not_before`, `start_by`,
   `complete_by` und die vorregistrierte Recovery-Regel. Das Fenster wird
   konservativ aus Q2-Worst-Case, MOS und Review dimensioniert. Sie erlaubt
   ausschließlich die einmalige Q2-Auswertung und keine Produktfreigabe.

**Exit F0:** Signierter Freeze, finaler Release-Digest, frisches Rights-Attest,
einmalige Evaluation-Autorisierung und alle technischen Qualification-Atteste
stimmen überein; das Holdout-ACL ist noch ungeöffnet und Produktion nicht
autorisiert.

### Q2 — Einmaliger Holdout und blinde MOS

1. Vor Entschlüsselung die `evaluation_authorization` und das finale
   Rights-Attest frisch gegen Digest, Ablauf und Widerruf prüfen. Der
   unabhängige Writer setzt dann atomar einen signierten append-only
   Consumption-Record mit Writer-Identität, Transaction-ID und Nonce. Der
   Zustand wechselt vor Entschlüsselung auf `started` und spätestens beim
   ersten entschlüsselten Byte beziehungsweise Output irreversibel auf
   `consumed`; gehashte Validitäts-/Abbruchregeln, Armreihenfolge und ITT-Regel
   sind gebunden. Ein Infrastrukturfehler darf nur innerhalb derselben
   deterministischen Exactly-once-Transaktion fortgesetzt werden, solange kein
   Armresultat offengelegt wurde; jede Fortsetzung verwendet identische
   Transaction-ID und Nonce und prüft `complete_by` erneut. Vor `start_by`
   nicht gestartete Autorisierung öffnet nichts. Nach `started` darf exakt diese
   Transaktion nur bis `complete_by` fortfahren. Ein Deadline-Verstoß nach
   `consumed` hält das Ergebnis fail-closed und verbraucht den Holdout; weder
   stiller Retry noch neues Token ist zulässig, außer eine schon in F0
   registrierte Recovery-Regel deckt genau den Fall innerhalb derselben
   Deadline. Nach jeder Ergebnisoffenlegung gilt der Holdout ebenfalls als
   verbraucht; neue Revision oder geändertes Gate verlangen einen neuen
   disjunkten Holdout.
2. Danach den Holdout über den unabhängigen Runner ausführen. Zehntausend
   Bootstrap-Replikate gruppieren nach Stimme/Sprecher und transitiver
   Leakage-Komponente. Gesamt-, Worst-Stratum- und multiplicity-korrigierte
   Grenzen müssen bestehen.
3. MOS verblindet, zufällige Armreihenfolge, identische Lautheit/Zeitachse,
   Rater-QC und identitätsweises Bootstrap. Gates laut Preregistrierung:
   Lip-Sync sowie Minimum aus Identität/Mundnatur jeweils mindestens 9/10;
   Kandidatenmargen mindestens +0,50 beziehungsweise +0,30, jeweils mit
   95-%-Konfidenz und Holm-Korrektur.

**Exit Q2:** Pro Claim-Domäne existiert ein statistisch belegter lokaler
Gewinner oder eine vorregistrierte Abstention. `sota_qualified` ist nur ein
Claim mit anwendbarem, bestandenem `sota_anchor`; `local-only` ist ein ehrlicher
Teilerfolg, kein 10/10-Beleg. Kein Ergebnis wird über inkompatible
Eingabeverträge gemittelt.

### P4 — Produktionsworkflow und Release-Audit

Die Workflow-Implementierung in 1–2 muss vor Preregistrierungs-Freeze und
finalem R1-Digest abgeschlossen sein; nach F0 und Q2 läuft nur noch das
unveränderliche Audit in 3–4.

1. Vier-Seed-Draft mit objektiver Vorsortierung erst aktivieren, nachdem seine
   Rangkorrelation zum HQ-Ergebnis auf Kalibrierdaten belegt ist.
2. Persistente Projekte/Storyboards, Shot-Ketten, referenzgebundene Continuity,
   gezielte Retakes und vollständige Export-/Sidecar-Historie umsetzen.
3. `npm run audit:release -- --release <digest>` sammelt nur unveränderliche
   Belege aus R0–Q2 und erzeugt zunächst
   `ltx-studio-release-evidence.v1` mit
   `ready_for_release_authorization=true`. Jede fehlende Datei,
   Digestabweichung, Warnung oder unentschiedene Rechtslage hält bereits hier
   an. Das Evidence-Paket prüft das externe Rights-Attest frisch auf
   `valid_at`, Ablauf und Widerruf.
4. Der getrennte Autorisierer signiert erst danach eine
   `release_authorization`, gebunden an Evidence-, Release-, Prereg-, Q2- und
   Rights-Attest-Digests. Ein unveränderlicher Finalizer verifiziert diese
   Signatur und erzeugt den signierten `ltx-studio-release-audit.v1`-Envelope,
   der den Authorization-Digest bindet. Erst dieser Envelope darf
   `production_overall=go` melden und Candidate-Surface-Einträge zu `released`
   promovieren, ohne den Inhaltsdigest umzudefinieren. `sota_overall=go`
   verlangt zusätzlich eine nichtleere Target-Menge und `sota_qualified` für
   jeden eingefrorenen Target-Claim. Unmittelbar zur Finalisierungszeit prüft
   der Finalizer Rights-Attest, Release-Autorisierung, Trusted Keys und
   Revocation-State erneut. Ablauf, Widerruf oder unlesbarer Status ergibt
   `hold`; dann sind frisches Attest und neue Autorisierung nötig. Das
   unveränderte Evidence-Paket darf nur wiederverwendet werden, wenn die
   eingefrorene Policy dies ausdrücklich erlaubt.

**Exit P4 / 10 von 10:** Das finale Audit meldet sowohl
`production_overall=go` als auch `sota_overall=go`; ein unabhängiger Neuaufbau
aus den Locks reproduziert denselben Release-Digest und besteht einen
Cold-Canary, ohne den Arbeitsbaum oder `comfyui-env` zu verwenden. Ohne
externen Spitzenanker bleibt der Status ausdrücklich unter 10/10.

## 4. Kosten und sichere Staffelung

R0–R2 sind überwiegend Engineering-Arbeit, benötigen für die R0-/R1-Exits aber
echte GPU-Canaries. R3 benötigt weitere Renderläufe. D0 wird durch Rechte,
Aufnahmen, Annotation und unabhängige Rollen bestimmt. Der volle Bake-off ist
unter den bisherigen Laufzeitannahmen grob auf 300–400 DGX-Stunden geschätzt,
möglicherweise darüber, wenn MOVA als eigener Claim hinzukommt; die Schätzung
wird nach Candidate-Matrix und Power-Analyse neu berechnet. Die DGX bleibt
orchestriert; kein Batch reserviert ungefragt die Maschine, und ein einzelner
GPU-Schritt benötigt weiterhin caller-eigenes Thermal-Pacing.

Sichere Staffelung:

1. R0 und R1;
2. R2, P4-Workflow und D0a-Design-Pilot parallel;
3. R3 aus dem ersten Release-Digest;
4. D0-Akquise/Governance und D1-Kalibrierung;
5. Q0-Cross-Shot- und Q1-Comparator-Pilot ausschließlich auf Kalibrierdaten;
6. Feedbackschleifen über die Invalidierungsmatrix schließen und P4-Workflow
   abschließen;
7. F0: finalen R1-/R3-Kandidaten bauen und Preregistrierung einfrieren;
8. Q2-Holdout/MOS genau einmal;
9. unverändertes finales P4-Audit.

## 5. Betreiberentscheidungen vor teurer Ausführung

1. **Datenherkunft und Rechte:** empfohlen sind eigene, ausdrücklich
   eingewilligte Aufnahmen für Entwicklung/Kalibrierung und ein separat
   lizenzierter, biometrisch freigegebener Bestand für den Holdout.
2. **Claim-Breite:** empfohlen bleibt de/en, 2–5 Sekunden, Einzelsprecher,
   frontal bis maximal 20 Grad Yaw, statische bis leichte Kopfbewegung, keine
   Musik und keine Schnitte.
3. **GPU-Budget:** empfohlen R0–R3 sofort nach Betreiberfreigabe, dann
   Kalibrier-Pilot; den einmaligen Holdout erst terminieren, wenn alle
   Software-, Rechts- und Messgates eingefroren sind.
4. **Control-Plane:** der aktuell inaktive Runtime-API-Dienst benötigt eine
   Betreiberentscheidung nach seinem eigenen Restart-Preflight. Das ist kein
   Auftrag an Studio, den Dienst selbst zu starten.

## 6. Was ausdrücklich nicht als Lösung gilt

- `chunkSizeWarningLimit` erhöhen, ohne Initiallast zu senken;
- `chardet` in der gemeinsam genutzten ComfyUI-Umgebung blind downgraden oder
  entfernen;
- einen sauberen Git-Commit als vollständigen Release-Digest bezeichnen;
- fünf Tune-Clips zur FAR-1-%-Kalibrierung verwenden;
- den Schärfewert `35` als universelle SOTA-Schwelle deklarieren;
- VBench oder WER als alleinigen Lip-Sync-Beweis verwenden;
- MOVA, Wan, LongCat und LTX trotz unterschiedlicher Eingaben in einen
  gemeinsamen Gesamtscore zwingen;
- nach dem Freeze Schwellen, Seeds, Prompts, Modelle oder Komparatoren anhand
  des Holdouts ändern.

## 7. Externe Primärquellen

- Vite Produktionsbuild und Code-Splitting: <https://vite.dev/guide/build>
- uv Locking/Sync und nicht-editierbare Deployments:
  <https://docs.astral.sh/uv/concepts/projects/sync/>
- VBench/VBench++/VBench 2.0: <https://github.com/Vchitect/VBench>
- Wan2.2-S2V: <https://github.com/Wan-Video/Wan2.2>
- MOVA: <https://github.com/OpenMOSS/MOVA>

## 8. Codex-Review

Freigabekriterium für diesen Plan ist: keine offenen hohen oder mittleren
Befunde zu Reihenfolge, Messbarkeit, Reproduzierbarkeit, Statistik, Rechte,
Rollback oder DGX-Vertrag.

**Runde 1:** drei hohe und acht mittlere Befunde. Behoben wurden die
vollständige Scheduler-State-Machine, der zyklische Release-Digest, fehlende
ASR-/Artefaktstrecken, Holdout-Verbrauch, Power-/NI-Design,
Comparator-Zuordnung, Datenrollback, deterministischer Doppelbuild,
Lizenzattestierung, capability-basierte Release-Surface und die
Pause/Resume-Äquivalenzregel. Die niedrigen Präzisierungen zu Bundlemessung,
uv-Prüfung und Kostenschätzung wurden ebenfalls übernommen.

**Runde 2:** zwei hohe und fünf mittlere Befunde. Behoben wurden die
Power-/Delta-Schleife durch D0a, die Freeze-Reihenfolge durch F0/Q2, die
Trennung statischer Manifestdaten von zeitvariablen Rights-Attesten, eine
explizite Invalidierungsmatrix, eine 50-Zeilen-Soak-Spezifikation, die positive
fachliche Identitätsmarge sowie der boundary-ID-gebundene Scheduler-Handshake.
Die niedrigen Präzisierungen zu Wegwerf-Waiter, Zyklusverteilung und
Bundle-Stichprobe wurden übernommen.

**Runde 3:** zwei hohe und vier mittlere Befunde. Behoben wurden die Trennung
von einmaliger Evaluation- und späterer Release-Autorisierung, das zwingende
externe `sota_anchor`-Gate, die erneute Rechteattestierung des Finaldigests, die
Leakage-Grenze des Design-Piloten, der crash-/timeoutfeste
Boundary-Exactly-once-Vertrag und ergebnisunabhängige Comparator-Kriterien. Die
niedrigen Präzisierungen zu neuem Doppelbuild und signiertem Consumption-Record
wurden übernommen.

**Runde 4:** keine hohen, drei mittlere Befunde. Behoben wurden der zweistufige
Evidence-/Release-Autorisierungs-Envelope, die nichtleere eingefrorene
`target_sota_claim_ids`-Menge und ein numerisch entscheidbarer,
claim-spezifischer VBench-Gate-Katalog. Die niedrige Präzisierung der
irreversiblen `started -> consumed`-Transaktion wurde übernommen.

**Runde 5:** keine hohen, zwei mittlere Befunde. Behoben wurden die
ankerunabhängige Vorabdefinition und Powerdimensionierung der VBench-Gates
sowie die erneute Rights-/Key-/Revocation-Prüfung exakt zur Finalisierungszeit.
Die Invalidierungsmatrix nennt Anchor- und VBench-Änderungen nun explizit.

**Runde 6:** keine hohen, zwei mittlere Befunde. Behoben wurden die
Union-Semantik und getrennte Behandlung statischer versus zeitvariabler
Rights-Änderungen sowie der vollständige `not_before`-/`start_by`-/`complete_by`
Zeitfenstervertrag der einmaligen Q2-Autorisierung einschließlich Deadline- und
Recovery-Folgen.

**Runde 7 / Schlussurteil:** `0 High`, `0 Medium`, `0 relevante Low` offen;
`git diff --check` sauber. Der Plan ist als SOTA-10/10-Durchführungs- und
Abnahmespezifikation freigegeben. Er behauptet keinen bereits erreichten
Produktstatus, sondern definiert fail-closed, wann `production_overall=go` und
`sota_overall=go` zulässig sind.
