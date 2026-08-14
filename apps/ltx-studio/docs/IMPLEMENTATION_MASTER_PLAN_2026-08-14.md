# LTX-2 Studio – Umsetzungs-Masterplan bis Production-GO und SOTA 10/10

Stand: 2026-08-14. Dieser Masterplan übersetzt den fachlichen
`SOTA_EXECUTION_PLAN.md` in eine ausführbare Arbeitsreihenfolge für den heute
vorhandenen Repository-, Runtime-, Release-, Security-, Rechte- und
Evidenzstand. Die statistischen und fachlichen Gate-Definitionen des
SOTA-Plans, des `LIPDUB_SOTA_PLAN.md` und der eingecheckten AV-Evaluator-
Konfigurationen bleiben maßgeblich. Die Präzedenz ist eindeutig: Dieser
Masterplan ist die Wahrheit für aktuellen Iststand und Ausführungs-DAG;
SOTA-Plan und eingefrorene Preregistrierung sind die Wahrheit für fachliche
Gates; `QUALITY_AUDIT_2026-08-03.md` ist die append-only Historie. Dieser Plan
ersetzt keine Messschwelle; er legt fest, wann welche Arbeit begonnen werden
darf und welcher Beleg sie abschließt.

## 1. Ziel und ehrliche Statusbegriffe

Es gibt zwei getrennte Endzustände:

1. **Production-GO:** Der freigegebene lokale Funktionsumfang läuft aus einem
   unveränderlichen Release, ist rechtlich zulässig, betrieblich belastbar und
   besteht alle für ihn anwendbaren technischen und Qualitätsgates.
2. **SOTA 10/10:** Zusätzlich besteht eine nichtleere, vor F0 eingefrorene
   Menge eng benannter `target_sota_claim_ids` den einmaligen Holdout gegen
   jeweils einen anwendbaren, rechtsklaren externen Spitzenanker. Ein
   `local-only`-Claim kann Production-GO erhalten, aber niemals SOTA 10/10
   begründen.

Der Plan ist erst erledigt, wenn der finale signierte Audit-Envelope
gleichzeitig `production_overall=go` und `sota_overall=go` meldet **und** der
schema-validierte 7-Tage-Post-Promotion-Bericht bestanden ist. Die ersten
24 Stunden bleiben eine ausdrücklich provisorische Promotion. Ein grüner
Build, ein erfolgreicher Canary oder ein lokal schöner Film genügt jeweils
nicht.

## 2. Verifizierte Ausgangslage

Alle Angaben wurden am 13./14.08.2026 read-only gegen Worktree, lokale APIs,
installierte Releasewurzeln und aktuelle Dependency-Metadaten geprüft.

| ID | Befund | Einordnung | Folge |
| --- | --- | --- | --- |
| A01 | Der Worktree auf `7c87b9d3…` war vor dieser Planrevision sauber; `git diff --check` und Repository-Integrität waren grün | gute `baseline_before_plan_revision`, nicht der spätere Pushzustand | in M0 unmittelbar vor Commit/Push neu messen |
| A02 | `feat/ltx-lipsync-lease` hat kein Upstream-Tracking und keinen entsprechenden Remote-Branch | hohes Betriebsrisiko | vor Integrationsarbeit remote sichern |
| A03 | Gegen `origin/main` fehlen 6 Upstream-Commits; 142 lokale Commits liegen auf dem gemeinsamen Vorfahren. Upstream enthält LTX 1.2.0, Dub-It, Gemma 4, neue VAE-/Media-Pfade und Transformer `>=5.8,<5.15` | hoher Integrationsblocker | eigener Integrationszweig vor jedem Finaldigest |
| A04 | Der Live-Dienst läuft seit 10.08. aus dem veränderlichen Worktree und entspricht ungefähr `41e4166`; HEAD liegt 78 Commits später. `/api/projects` ist live noch `404` | schlecht, aber ohne aktiven Job sicher planbar | erst nach grünem Release operator-gesteuert umschalten |
| A05 | Kein `/opt/ltx-studio/current`; der jüngste verifizierbare installierte Root bindet `8d2ed98`, 59 Commits hinter HEAD | kein aktuelles Deployment | neuer Doppelbuild und atomare Promotion nötig |
| A06 | Studio 617/617, E2E 59 bestanden plus 1 erwarteter Skip, native Suite 64/64, Lint und Build grün | gut | nach Upstream-/Security-Änderungen vollständig wiederholen |
| A07 | AV-Governance-Suite 175 bestanden, 1 rot: fester Testzeitpunkt 11.08. und 48-h-Key, während der CLI-Subprozess reale Zeit verwendet | Testdefekt; Produktion fail-closed | zeitrobuste Fixture ohne Produktions-Clock-Bypass |
| A08 | CLI-Hilfe nennt 109 D1-Gates, der ausführbare Vertrag und Tests verlangen 127 | niedriger Contract-Drift | Text aus einer kanonischen Konstante ableiten |
| A09 | Bundle von 533 kB auf rund 392/117 kB raw/gzip reduziert; frühere R2-Evidenz ist grün, aber nicht an den Finaldigest gebunden | fachlich geschlossen | nach Finalstabilisierung R2 neu binden |
| A10 | Release-Runtime ist dependency-konsistent, aber der aktuelle Auditfeed meldet Treffer für Requests 2.32.5, Setuptools 81.0.0 und Transformers 4.57.6 | Security-HOLD | vor neuem Release aktualisieren und Auditgate einführen |
| A11 | Shared-ComfyUI-Environment warnt weiter wegen Requests/urllib3/chardet; Release-Runtime ist davon isoliert | bewusst begrenzt | nie als Releasequelle verwenden; keine blinde Shared-Env-Mutation |
| A12 | Candidate-Surface: 160 Einträge, 26 konditionale Kandidaten in 19 Claims, 134 blockiert; kein Eintrag ist released | Rechts-/Qualifikations-HOLD | Surface nach Integration regenerieren und Rights schließen |
| A13 | Rights-Katalog: 7 blockiert, 6 conditional, 1 permitted | zentraler Product-HOLD | Rechtebelege oder technisch gleichwertige permissive Ersatzpfade |
| A14 | R0–F0/Q2-Auswertungsmaschinen sind implementiert; reale unabhängige Daten, Signaturen, Holdout- und MOS-Evidenz fehlen | gute Grundlage, keine Freigabe | D0a bis Q2 real ausführen |
| A15 | Cross-Shot verbesserte Kontinuität, verlor aber massiv Schärfe (`5,51` gegen `52,72`) | Qualitäts-HOLD | neue scharfe szenengleiche Quelle und gepaarter Q0-Pilot |
| A16 | VBench-Source ist gepinnt; Runtime-/Messkonfiguration bleibt draft und kommerzielle Rechte mehrerer Abhängigkeiten sind offen | SOTA-HOLD | lizenzieren oder vor D0a zulässigen Ersatz definieren |
| A17 | LongCat ist lokal, aber der Entwicklungscheckout enthält veränderte/unversionierte Artefakte; Wan fehlt lokal; MOVA ist für den festen Audioinput inkompatibel | Comparator-HOLD | saubere immutable Checkouts, Rechte- und Ressourcenprofile |
| A18 | R0-Live-Canary, 20 Pause/Resume-Zyklen und die 50-Job-R3-Matrix fehlen | Betriebs-HOLD | nach Engineering-Digest, für Finaldigest wiederholen |
| A19 | Es gibt im aktuellen Studio-Code keine globale `Alt`-/`keydown`-Shortcutlogik | gut | durch Regressionstest gegen Alt+Ziffer, Ctrl/Cmd+Plus und Browsernavigation sichern |
| A20 | DGX-Orchestrator und LTX-Consumer sind erreichbar; Queue leer. Fremde Qwen-/ComfyUI-Prozesse sind geschützt | startbereit, nicht exklusiv | jede GPU-Arbeit ausschließlich via Admission |

## 3. Kanonische DAG und unverhandelbare Reihenfolge

Diese Tabelle ist die einzige Reihenfolgewahrheit. Kürzere Ketten und
Parallelisierungshinweise werden aus ihr abgeleitet.

| Paket | benötigt vor Start | blockiert bis Exit | bei Änderung mindestens invalidiert |
| --- | --- | --- | --- |
| M0 Baseline/Sicherung | keine aktive LTX-GPU-Arbeit | M1 | M1 und jede darauf basierende Evidenz |
| M1 statische Upstream-Integration | M0 | M2 | M2, alle Release- und Folgebelege |
| M2 Runtime/Security/Tests | M1 | R1e, G0a, D0s | R1 und alle digest-/runtimegebundenen Folgebelege |
| D0s Data-Security-Preflight | M2 | jedes Byte realer D0a-/D0-/D1-/Q0-/Q1-/Q2-Daten | alle datenabhängigen Belege |
| R1e Enforcer/Authorization-Code | M2 | R0c, R1a | R1 und alle Start-/Qualification-/Promotionbelege |
| Q2-runtime-sandbox | R1e, aktueller Orchestrator-Contract, DGX-Betreiber | F0-Freeze/EvalAuth | F0/Q2 |
| R0c CPU-Contract | R1e | R1a | R0l, R1/R3 |
| G0a statische Surface-/Rights-Auflösung | M2 | R1a | R1 und alles nachgelagerte bei Änderung |
| G0u Rights-Snapshot-Updater | M2, G0a, Rights-/DGX-Betreiber | G0b und jeden Live-/Qualification-Start | G0b, Runtime-/P4-Rechecks |
| R1a Stage/Verify | M2, R1e, R0c, G0a | G0b, R2; noch kein Unit-/`current`-Switch | alle digestgebundenen Belege |
| R2 Startup/Bundle | R1a | R1b | final erneut auf Finaldigest |
| G0b zeitvariables Rights-Attest | R1a, G0u; D0-Datenrechte zusätzlich D0s | R1b und reale Comparator-/Evaluatorläufe | G0b/F0/Q2/P4 gemäß Policy; statische Änderung zurück zu G0a/R1a |
| R1b Qualification-Mode-Aktivierung | R1a, R2, G0b | QAuth-R0lR3; registriert selbst keine Runs | Deployment-/Modebelege |
| QAuth-R0lR3 | R1b, G0b, eingefrorene Engineering-R0l-/R3-Matrix | R0l | R0l/R3 |
| R0l Live-Canary | R1b, QAuth-R0lR3 | R3 | R3; final erneut auf Finaldigest |
| R3 Engineering | R0l, R1b, QAuth-R0lR3 | technischer Engineering-Exit | final erneut auf Finaldigest |
| D0a-Design | D0s; anwendbare Evaluatorrechte aus G0b | QAuth-D0a | D0a-Run bis Q2 |
| QAuth-D0a | R1b, G0b, eingefrorenes D0a-Pilotdesign | D0a-Run | D0a-Run bis Q2 |
| D0a-Run | D0a-Design, QAuth-D0a | D0 | D0–Q2 |
| D0 Datengrundlage/Custody | D0s, D0a-Run | D1-Design | D1–Q2 |
| D1-Design | D0, G0b, eingefrorenes Gate-Set | QAuth-D1 | D1-Run bis Q2 |
| QAuth-D1 | R1b, G0b, D1-Design | D1-Run | D1-Run bis Q2 |
| D1-Run | D1-Design, QAuth-D1 | QAuth-Q0, QAuth-Q1b | Q0–Q2 |
| QAuth-Q0 | R1b, G0b, D1-Run, eingefrorene Q0-Matrix | Q0 | Q0/F0/Q2 |
| Q0 Cross-Shot | QAuth-Q0 | F0-build | F0/Q2 |
| Q1a-Prepare Landscape/Provision | G0b | ExtTicket-Q1a; noch kein Comparator-GPU-Lauf | Q1a–Q2 |
| ExtTicket-Q1a-Profile | Q1a-Prepare, eingefrorene synthetische Profilmatrix | Q1a-Profile | Q1a–Q2 |
| Q1a-Profile/Freeze | ExtTicket-Q1a-Profile | ergebnisunabhängig eingefrorene Comparator-Matrix | Q1b/F0/Q2 |
| QAuth-Q1b | R1b, G0b, D1-Run, Q1a-Freeze | Q1b-Studio-Kandidatenjobs | Q1b/F0/Q2 |
| ExtTicket-Q1b-Quality | D1-Run, Q1a-Freeze, eingefrorene externe Quality-Matrix | Q1b-Comparatorjobs | Q1b/F0/Q2 |
| Q1b Quality-Pilot | D1-Run, Q1a-Freeze, QAuth-Q1b, ExtTicket-Q1b-Quality | Q1b-Seal | Q1b/F0/Q2 |
| Q1b-Seal | Q1b-Pilot, beide terminalen Ticketgenerationen | F0-build | F0/Q2 |
| F0-build/R2-final + Digest-Fixpunkt | Q0, Q1b-Seal, geschlossene Änderungsschleife | G0b-final nur bei exakter Release-Digestgleichheit | alle Finaldigest-Belege; bei Abweichung kompletter Q1b-Loop auf neuem Digest |
| G0b-final | F0-build/R2-final, aktueller grüner G0u-Exit | R1b-final-mode | alle Finaldigest-Belege ab Rights |
| R1b-final-mode | F0-build/R2-final, G0b-final | QAuth-final | Final-Deploymentbelege |
| QAuth-final | R1b-final-mode, G0b-final, eingefrorene Final-R0l-/R3-Matrix | Final-R0l/R3 | Final-R0l/R3/Freeze |
| Final-R0l/R3 | QAuth-final | F0-Freeze/EvalAuth | Freeze/Q2 |
| F0-Freeze/EvalAuth | Final-R0l/R3, Q2-runtime-sandbox, vollständige Prereg-/Runnerbelege | Q2 | neuer F0 plus neuer disjunkter Holdout |
| Q2 Holdout/MOS | F0-Freeze/EvalAuth | P4 | kein Retry; neue Revision braucht neuen Holdout/F0 |
| P4 Audit/Promotion | Q2 | O24 | Authorization/Finalizerbelege |
| O24 Beobachtung | P4 | stabile statt provisorische Promotion | Rollback/HOLD bei gerissenem Oracle |
| O7 Abschlussbeobachtung | O24 | Abschluss dieses Masterplans | Rollback/HOLD bei gerissenem Oracle |

M0–M2 liegen immer zuerst. Danach dürfen R1e, G0a und D0s in den von der
Tabelle erlaubten Grenzen parallel vorangebracht werden; R0c läuft nach R1e.
R1a bindet danach Enforcer, R0c und statische G0a-Evidence, G0b attestiert den resultierenden Digest. Ein Release
wird vor G0b nur gestaged und verifiziert, niemals live aktiviert. Reale
Pilot- oder Biometriedaten werden vor D0s weder importiert noch verarbeitet.
Teure Qualitätsläufe vor stabilen Locks sind Wegwerf-Evidenz. Der Holdout wird
niemals vor F0 geöffnet.

Der Digest-Fixpunkt ist eine revisionsgebundene Rückkante, kein Zyklus
innerhalb einer Revision: Bei Ungleichheit endet die aktuelle Revision auf
`hold`; der neue Digest startet eine strikt höhere Candidate-/Ticket-/Seal-
Generation ab G0b/R1b/Q1b. Nur eine neue Revision mit exakter Gleichheit darf
zu `G0b-final` weiterlaufen.

## 4. Arbeitspakete

### M0 – Baseline sichern und Arbeit sichtbar machen

**Ziel:** Kein Verlust der 142 lokalen Feature-Commits; klare Remote- und
Integrationsbasis.

Aufgaben:

1. Drei nicht-selbstreferenzielle Identitäten erfassen. Zunächst immutable
   `pre_plan_baseline=7c87b9d3…` und – erst nach Review/Commit dieses Plans –
   den dann neu gemessenen, sauberen `reviewed_plan_head` samt Tree. Der zweite
   Digest wird nicht im Voraus hardcodiert. Das anschließend erzeugte
   Baseline-/Contractinventar referenziert nur diese beiden früheren Rollen
   und wird in einem dritten `m0_evidence_commit` eingecheckt; es versucht
   nicht, seinen eigenen zukünftigen Commit zu hashen. Zusätzlich leere
   LTX-Jobmenge belegen.
2. Den unveränderten Vor-Plan-HEAD `7c87b9d3…` als datierten
   Remote-Sicherungsref pushen. Den `reviewed_plan_source_commit` pushen,
   danach das Evidence-Artefakt committen und den Feature-Tracking-Branch auf
   den `m0_evidence_commit` pushen. Push ist Sicherung, kein Deploy; alle drei
   Rollen werden getrennt protokolliert.
3. Ein maschinenlesbares Baseline-Artefakt mit beiden Commit-/Tree-Rollen, Remotes,
   Ahead/Behind, Testzählungen, Dependency-Inventar, Runtime-Startzeit und
   installierten Release-Digests unter `docs/evidence/` erzeugen.
4. Vor dem Merge ein maschinenlesbares Inventar aller lokalen Verträge
   erzeugen: Capability-/Release-Surface, HTTP-Routen, Request-/Sidecar-
   Schemas, CLI-Subcommands, Pipeline-Exports, Scheduler-/Provenienz-/Release-
   und Evaluatorverträge sowie die jeweils beweisenden Tests. Nicht nur die
   zwölf UI-Modi zählen als lokale Funktion.
5. Für die Upstream-Integration vom `m0_evidence_commit` einen separaten
   Branch und ein separates Worktree verwenden; den laufenden Worktree nicht
   halb gemergt hinterlassen.

Exit/Evidenz:

- Datierter Backup-Ref zeigt exakt auf `7c87b9d3…`; ein zweiter Ref bindet den
  `reviewed_plan_source_commit`; der getrackte Feature-Ref zeigt auf dessen
  Folgecommit `m0_evidence_commit`.
- `git ls-remote`, lokale Ref-Digests und Tracking stimmen überein.
- Baseline- und Contractinventar-JSON sind schema-validiert und enthalten
  keine Secrets.

Aufwand: etwa 0,5 Tag. Keine GPU-Arbeit.

### M1 – Upstream 1.2.0 und Dub-It kontrolliert integrieren

**Ziel:** Aktuelle LTX-Basis ohne Verlust der Studio-spezifischen
Scheduler-, Provenienz-, Release- und Evaluatorverträge.

Entscheidung: Wegen 142 lokaler Commits und einer 260-Dateien-Upstream-
Änderung wird ein nachvollziehbarer Merge in einem Integrationsbranch einem
Mass-Rebase vorgezogen. Die alte Baseline bleibt remote erhalten.

Aufgaben:

1. Nach der Remote-Sicherung die Upstream-Refs authentisiert aktualisieren.
   Entspricht `origin/main` weiter dem geprüften Commit `fd4ded7…`, wird dieser
   als Eingang gebunden. Ist er weitergelaufen, wird der zusätzliche Delta
   zuerst separat analysiert und der tatsächlich gewählte Cutoff-Digest im
   Integrationsreport festgeschrieben; kein stilles „latest“.
2. Konflikte nach Verantwortungsbereich auflösen:
   - Core/Gemma: Upstream-Gemma-4- und Transformer-Vertrag übernehmen;
   - Pipelines/VAE/Media: neue 1.2.0-APIs übernehmen;
   - kooperative `stepper`-/`loop`-Hooks, Boundary-Checkpointing und
     Provenienz explizit auf die neuen APIs portieren;
   - `lipdub.py -> dubit.py`: persistente Studio-Modus-ID `lipdub` und alte
     Sidecars lesbar halten, intern auf den neuen `DubItPipeline`-Namen
     abbilden; keine stille Requestmigration;
   - Root-Lock-/Workspace-Änderungen nicht in die isolierte Studio-
     Release-Runtime hineinmischen;
   - License-Dateiumzug in SBOM und Rights-Evidence nachführen.
   Jeder Konflikt erhält im Konfliktledger Pfad, Upstream-/Lokalintention,
   gewählte Disposition, verantwortlichen Vertrag und späteren Beweistest.
3. Capability-Matrix, Workflow-Verträge, Modelldigests und Candidate-Surface
   regenerieren. Jede Änderung wird über die Invalidierungsmatrix behandelt.
4. Das Vorher-/Nachher-Inventar semantisch vergleichen. `git range-diff`,
   Commit- und Konfliktledger unterstützen die Prüfung, ersetzen aber nicht
   die explizite Disposition jedes lokalen API-/Schema-/CLI-/Evidence-
   Vertrags.
5. Die Beweistests für alle inventarisierten Verträge einschließlich der
   zwölf sichtbaren Modi planen und portieren. Native Imports und
   Runtime-Contracttests laufen erst nach der kompatiblen M2-Lockauflösung.
6. Einen statischen Upstream-Integrationsreport mit Merge-/Tree-Digest,
   Konfliktledger, Schema-/Route-/Export-Diff und kompilierten
   TypeScript-/Python-Syntaxgates erstellen.

Exit/Evidenz:

- Mergebasis und Eingangsdigest sind dokumentiert.
- Keine unaufgelösten Konfliktmarker; jede Inventaränderung besitzt eine
  explizite Disposition und einen M2-Beweistest.
- Alte `lipdub`-Requests und Sidecars werden deterministisch migriert oder
  mit klarer Meldung abgelehnt; neue Requests nutzen intern Dub-It.
- M1 ist nur ein statischer, provisorischer Exit. Erst der gemeinsame
  M1+M2-Exit beweist Native-/Studio-Runtimekompatibilität und Funktionserhalt.

Aufwand: 3–7 Engineering-Tage. Das ist der größte kurzfristige Codeblocker.

### M2 – Security-, Test- und Interaktionsbaseline vollständig schließen

**Ziel:** Ein sauberer, auditierbarer Kandidat, bevor Release- oder
Qualitätsevidenz erzeugt wird.

Aufgaben Security:

1. Advisory- und Paketmetadaten am Ausführungstag erneut aus Primärquellen
   erfassen und den Cutoff im Securityreport binden. Danach die Studio-Runtime
   auf die mit Upstream kompatible Linie locken und neu auflösen:
   - Transformers exakt `5.14.1` oder eine nachweislich gleichwertige Version
     im Upstream-Vertrag `>=5.8,<5.15`;
   - Requests mindestens gepatcht, Zielversion zum Planstand `2.34.2`;
   - Setuptools entfernen, wenn es zur Laufzeit nicht benötigt wird, sonst
     mindestens gepatcht, Zielversion `84.0.0`.
2. `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`, lokale revisions- und
   hashgebundene Modellpfade, `trust_remote_code=false` und Safetensors für
   alle anwendbaren AutoModel-Pfade erzwingen.
3. Releasegate um normalisierte `pip-audit`-/OSV-Ausgabe erweitern. Quelle,
   Abrufzeit, Advisory-ID-/Alias-Deduplizierung und Cutoff werden gebunden.
   **Jede** anwendbare Runtime-Advisory unabhängig von Severity muss
   `fixed` oder mit Reachability-Beleg `not-applicable` sein. Eine Ausnahme
   braucht signierte, digestgebundene, befristete Risk-Acceptance mit Owner,
   Ablauf und Kompensationskontrolle; `unknown` ist fail-closed. Nicht auf
   PyPI bekannte lokale LTX- und CUDA-Wheels werden über SBOM, Hash und
   Herkunft statt durch ein falsches „0 vulnerabilities“ belegt.
4. Offline nicht nur per Env-Flag behaupten: Python-Renderer und Evaluatoren,
   die keinen Orchestratorzugriff brauchen, laufen mit `PrivateNetwork=yes`.
   Die Node-Unit benötigt Host-Loopback für Studio und Runtime-API und wird
   stattdessen mit `IPAddressDeny=any`, explizitem
   `IPAddressAllow=127.0.0.0/8 ::1`, begrenzten Address-Families und nur den
   dokumentierten Unix-Sockets geprüft. Release-Negativtests müssen DNS und
   öffentlichen TCP-Egress scheitern lassen, während exakt die benötigten
   Loopback-Endpoints funktionieren.
5. `npm audit`/JS-Advisories durchlaufen dieselbe normalisierte
   `fixed/not-applicable/risk-accepted/unknown`-Entscheidung mit Cutoff,
   Reachability, Owner und Ablauf wie Python. Lockintegrität und Secret-Policy
   ebenfalls prüfen.

Aufgaben Tests und UX:

1. Die Q2-Testfixture relativ zu einer einmal am Teststart erfassten UTC-Zeit
   erzeugen. Der Produktions-CLI erhält keinen frei manipulierbaren
   Rückdatierungsparameter. Separate Tests prüfen abgelaufene Keys explizit.
2. Die Zahl der D1-Gates in CLI-Hilfe und Dokumentation aus der kanonischen
   Gate-Inventur ableiten; aktuell sind es 127, nicht 109.
3. Regressionstest: Das Studio registriert und blockiert keine unmodifizierten
   `Alt+Ziffer`, `Alt+Pfeil`, `Ctrl/Cmd+Plus`, `Ctrl/Cmd+Minus` oder
   Browser-/Terminal-Reservierungen. Falls später Shortcuts kommen, sind sie
   standardmäßig aus, umbelegbar, im App-Fokus begrenzt und ignorieren
   Eingabefelder.
4. Vollständige Gates erst nach Lockauflösung ausführen:
   - 617+ Studio Unit-/Integrationstests;
   - AV-Evaluator-Suite ohne Skip/Fail;
   - native Core/Pipelines-Suite;
   - Desktop/Mobile-E2E;
   - ESLint, TypeScript, Build, `uv lock --check`, `uv pip check`, Security-
     Audit und `git diff --check`.

Exit/Evidenz:

- 0 fehlgeschlagene Pflichtchecks.
- Jede Runtime-Advisory besitzt eine gültige Entscheidung; `unknown` oder eine
  abgelaufene Risk-Acceptance ergibt HOLD.
- Alle Modellloads bleiben im nachgewiesenen Offline-/Allowlist-Vertrag;
  öffentlicher Egress ist im Negativtest blockiert.
- Shortcut-E2E beweist, dass reservierte Tastenkombinationen nicht
  `preventDefault()` erhalten.
- Vorher-/Nachher-Inventar und Konfliktledger sind vollständig durch grüne
  Beweistests geschlossen; erst dies ist der gemeinsame M1+M2-Exit.

Aufwand: 1–3 Tage nach M1. Keine GPU bis zum CPU-/Security-Exit.

### R1e – Start-Enforcer, Autorisierungen und Activation-State vorbauen

**Ziel:** Jeder spätere Release enthält den nicht umgehbaren Enforcer und die
vollständige Zustandsmaschine bereits vor dem versiegelten R1a-Build. R1b und
P4 aktivieren nur signierte Zustände; sie ändern keinen Code.

Aufgaben:

1. Den Enforcer unmittelbar an der `jobs.create`-/Queue-Grenze zentralisieren.
   Direkter Jobstart, Projekt-Run, Retry, Rerun, Experiment, Refiner und jede
   neue Route müssen dieselbe typisierte Startfunktion verwenden. Bypass-
   Routen sind strukturell nicht registrierbar.
2. Eine append-only, generationsgebundene Activation-State-Machine
   implementieren:
   `blocked -> qualification_only -> production_provisional ->
   production_stable`. Jeder Zustand kann fail-closed nach `hold` oder
   `rolled_back` wechseln; eine neue Aktivierung benötigt eine höhere
   Generation und neue Autorisierungen. Alte Nonces/Tokens werden nie
   reaktiviert. Jeder Transition-Record bindet Release-, Surface-,
   Rights-Policy/Evidence-Digest, Attestation-Series samt beobachteter
   Snapshot-Version, Authorization- und gegebenenfalls Audit-Envelope-Digest.
   Ein Releasewechsel
   ist kein impliziter State-Overwrite, sondern
   `supersede_release_generation.v1`: Preflight `0 armed`, `0 started` und
   keine blockierten Wrapper/Prozess-cgroups, alle alten
   `pending/accepted` Tickets im selben Record terminal
   `closed_by_supersede`, alten Head/Digest binden und eine strikt höhere neue
   Generation im Zustand `blocked` eröffnen. Erst danach darf eine neue
   Mode-Autorisierung folgen; State oder Tickets sind nie übertragbar.
3. Zustands- und Run-Autorisierung strikt trennen. Eine einmalige
   `qualification-mode-authorization.v1` darf ausschließlich
   `blocked -> qualification_only` auslösen. Im Zustand `qualification_only`
   verwaltet ein append-only `qualification_authorization_registry` beliebig
   viele **enge, zweckgebundene** `qualification-authorization.v1`-Records,
   ohne den Modus erneut zu aktivieren. Jede Registry-Autorisierung enthält
   Schema-/Policy-Version,
   Release-/Surface-Digests sowie unveränderlichen
   `rights_policy_evidence_digest`, stabile `attestation_series_id`,
   `minimum_snapshot_version`, trusted Signer und Rolle, `issued_at`,
   `not_before`, `start_by`, `complete_by`, eigene Generation und Nonce,
   Purpose-/Phasen-ID,
   Input-/Seed-/Matrix-Digests, maximale Gesamt-Job-/GPU-Sekunden-/Output-
   Budgets, erlaubte Recovery und Widerrufsquelle. Für eine Matrix enthält sie
   eine feste sortierte Menge einzelner `run_tickets` mit je eigener Nonce,
   Entry-ID, Inputdigest, Seed und Teilbudget; ein Einzellauf hat exakt ein
   Ticket. R0l/R3, D0a, D1, Q0, Q1 und die finalen R0l/R3-Läufe erhalten –
   soweit sie Studio-Jobs starten – getrennte Registry-Records. Die unabhängige
   Q2-`evaluation_authorization` darf nie in diese Registry gelangen.
4. Die Mode-Autorisierung wird beim Transition nach `qualification_only`
   einmalig verbraucht. Jede spätere Run-Autorisierung wird durch den
   Qualification-Autorisierer genau einmal registriert; jedes Run-Ticket
   wechselt separat
   append-only `pending -> accepted -> armed -> started -> terminal` und wird beim
   Queue-Accept atomar verbraucht. Ein Ticket ist kein frei kopierbares
   Bearer-Token. Replay, Cross-Digest, Cross-Entry, Cross-Seed sowie Teil- oder
   Gesamtbudgetüberschreitung sind fail-closed. Verpasst ein
   wartender Job `start_by` oder wird Autorisierung/Recht in der Queue
   widerrufen, endet er terminal ohne Start. Ein laufender kooperativer Job
   checkpointet am nächsten sicheren Segment und endet; ein nicht
   kooperativer Lauf wird beendet und alle Outputs bleiben unfreigegeben.
   Ein Snapshot-Refresh wird nur akzeptiert, wenn Series, statische Evidence
   und Policy identisch sind und die Version monoton steigt. Qualification-
   Autorisierungen setzen entweder `complete_by <= next_update` oder binden
   ausdrücklich diese Same-Series-Successor-Regel; ein anderer Evidence-Hash
   ist immer Cross-Digest-Fail. `complete_by` wird bei Queue-Accept,
   unmittelbar vor Start, an jedem Heartbeat beziehungsweise Segment und vor
   Outputfreigabe geprüft. Beim
   Grenzübertritt gilt dieselbe Checkpoint-/Kill-/Unreleased-Policy; Recovery
   ist nur mit demselben Ticket und innerhalb derselben Deadline erlaubt. Ein
   owner-separierter Qualification-Supervisor setzt **vor dem ersten Runner-
   Byte** `accepted -> armed`: Er erzeugt und besitzt die cgroup, persistiert
   Ticket-ID, cgroup-ID und monotone Deadline, armt den Kill-Timer und bestätigt
   erst danach. Ausschließlich Writer und Supervisor dürfen anschließend den
   kontrollierten Launch auslösen: Der Supervisor startet zunächst nur einen
   inert blockierten Wrapper in der cgroup, der noch kein Runner-/Modellbyte
   ausführt. Nach PID-/cgroup-Prüfung schreibt der Writer dauerhaft
   `armed -> started`; erst dessen Ack löst der Supervisor die Exec-Barriere.
   So wird keine Dateisystem-/Prozess-Atomarität behauptet und dennoch läuft
   kein Runner-Byte ohne gültigen `started`-Record. App/Worker dürfen weder
   direkt execen noch einen Prozess in die cgroup migrieren. Der
   Timer benötigt keine Heartbeats. Bei Fristablauf: `TERM`, feste kurze Grace-Period, dann
   cgroup-weites `KILL`; alle Descendants und offenen FDs werden geschlossen,
   Ticket terminalisiert und Outputs bleiben unfreigegeben. App/Worker können
   den Timer weder verlängern noch deaktivieren. Supervisorverlust killt die
   Unit fail-closed, sofern nicht ein vom Supervisor unabhängiger persistenter
   Systemtimer dieselbe Deadline weiter erzwingt. Restart-Reconciliation
   terminalisiert `armed`/blockierte Wrapper ohne gültigen Start,
   terminalisiert `started` ohne freigegebenen Exec und killt jeden Exec ohne
   gültigen Record.
5. Activation-State, Registry-Mutation, Autorisierungsverbrauch und
   Ticketzustände in **einem** kanonischen Journalrecord pro Transaktion
   gemeinsam binden, statt atomare Konsistenz über mehrere Dateien zu
   behaupten. Ein Single-Writer-Lock/CAS, monotone Generation, `prev_hash`,
   temporärer Write, Datei-`fsync`, atomarer Rename und Directory-`fsync`
   sind Pflicht; Indizes sind nur rekonstruierbarer Cache. Beim Restart wird
   die Kette vollständig reconciled. Zusätzlich signiert eine eigene
   Activation-Journal-Writer-UID jeden Record und persistiert nach jedem
   Commit `{generation, head_hash}` in einem owner-separierten append-only
   WORM-/TPM-äquivalenten Anchor. Startup und Restore vergleichen Journal,
   Anchor und die höchste gesicherte Generation. Ein gültiger, aber älterer
   Prefix, fehlender Anchor, divergierende Heads oder beschädigter Tail führt
   zu `hold`, nie zu stillem Truncate/Weiterlauf. App und Engineering dürfen
   weder Head noch Historie zurücksetzen. Fault-Injection testet jeden
   Write-Schritt, Crash zwischen Consume und State-Append, gültigen Prefix-
   Rollback, Snapshot-Restore, Anchor-Ausfall sowie Writer-Key-/ACL-Denials.
6. Das P4-Produktionsschema und die Exactly-once-Activation-Transaktion jetzt
   mitimplementieren: Ein gültiger Release-Authorization-/Envelope-Digest darf
   genau einmal `qualification_only -> production_provisional` auslösen und
   nur Surface-Einträge mit signiertem Status `released` für normale Starts
   öffnen. Rechte werden anhand eines signierten Revocation-Snapshots mit
   `checked_at`, `max_age`/`next_update`, Quelle und monotoner Version bei
   Queue-Accept, unmittelbar vor Start, an jeder sicheren Segmentgrenze und
   vor Outputfreigabe erneut geprüft. Stale, unerreichbar, abgelaufen oder
   widerrufen ist fail-closed; ein Nachfolger muss dieselbe Series, Evidence
   und Policy bei höherer Version tragen. O24 darf ausschließlich mit gültigem
   Observation-Report nach `production_stable` wechseln.
7. Negative Tests für jeden Startpfad, Zustand, Replay, alten Generationstoken,
   Ablauf vor Queue-Start sowie `complete_by` exakt vor/auf/nach Accept, Start,
   Segment und Outputfreigabe, Hänger ohne Heartbeat/Segment, Fault-Injection
   an jeder Accept-/Arm-/Journal-/Exec-Grenze, Supervisor-Crash/Restart,
   `armed` ohne Exec, Exec ohne gültiges `started`, Descendants/FDs,
   Widerruf in Queue/Run, falschen Entry/Digest/Seed,
   Budgetüberschreitung, Same-Series- und Cross-Evidence-Refresh,
   `supersede_release_generation` inklusive Crash/Cross-Release, P4-
   Doppelconsumption und Rollback. Positive Tests
   belegen exakt erlaubte Qualification- und Released-Starts.
8. Den Post-Promotion-Collector vorbauen: eigener trusted Monitoring-Signer,
   append-only Sequenznummern, monotone und Wall-Clock-Zeit plus Boot-ID,
   erwarteter Probeplan, Raw-Log-Digests und `missing=fail`. Summary-
   Finalizer müssen aus den Rohrecords rekonstruieren; nachträglicher Backfill
   oder Neuordnen ist ungültig.
9. Für Promotion/Rollback einen Write-Journal-/Migration-Vertrag vorbauen:
   RPO 0 für bestätigte Projekt-/Job-/Provenienzschreibvorgänge und Ziel-RTO
   30 Minuten. Mindestens ein Release zurück bleibt das Schema vor-/rückwärts-
   kompatibel; andernfalls gilt ausdrücklich `forward-only-recovery` statt
   eines falschen Binärrollbacks. Für den **ersten** Enforcer-Rollout ist der
   bisherige unenforced Legacy-Digest niemals ein Live-Rollbackziel. Zulässig
   sind nur derselbe R1a-Binary im signierten `blocked`/`hold` oder ein
   service-gestoppter Maintenance-Fallback. Der Unit-/`current`-Selector
   verweigert jeden Digest ohne attestierte Enforcer-/Activation-Schema-
   Capability. Binärrollback wird erst freigegeben, wenn der vorherige Release
   denselben Vertrag nachweislich implementiert.
10. Einen unabhängigen `q2-runner.v1` vorbauen: eigene UID und Orchestrator-
    Consumer-ID, gebundener Runner-/Release-Digest, ausschließlich
    `evaluation_authorization`, versiegelte Input-/Outputroots und kein
    Zugriff auf Activation-State, QAuth-Registry oder Produkt-UI/API-Starts.
    Positive Admission- sowie negative `jobs.create`-, Registry- und Root-
    Bypasstests werden schon in R1e implementiert. Die behauptete Direct-GPU-
    Sperre ist erst nach dem separaten operator-owned Q2-runtime-sandbox-Gate
    bewiesen und wird vor F0 auf dem Finaldigest wiederholt.

Exit R1e: Code, Schemas, gezielte Tests und die vollständigen M2-Pflichtsuiten
sind nach der letzten R1e-Codeänderung erneut grün; Start-, Qualification- und
Produktionszustandsmaschine werden im nachfolgenden R1a-Digest versiegelt.
Kein Live-State wird in R1e verändert.

Aufwand: zunächst ein zweitägiger Design-Spike für Journal, Crashmatrix,
Registry, Collector und Bootstrap-Rollback; erst danach P50/P90 neu schätzen.
Vor diesem Spike ist eine belastbare Engineering-Dauer nicht seriös. Keine
GPU-Arbeit.

### Q2-runtime-sandbox – GPU-Zugriff nur nach Orchestrator-Grant

**Ziel:** Eine eigene Q2-UID allein darf keinen direkten `/dev/nvidia*`-
Zugriff besitzen.

Der DGX-Betreiber wählt und dokumentiert einen konkreten privilegierten
Launcher-/cgroup-/transienten-Unit-Mechanismus, beispielsweise
`DevicePolicy=closed` plus zeit- und jobgebundene `DeviceAllow`-Freigabe. Im
Ruhezustand ist jedes GPU-Device für die Q2-UID gesperrt. Ausschließlich ein an
den aktuellen Orchestrator-Contractcommit, Consumer-ID, Job-ID, Admission-
Grant und Deadline gebundener Launch öffnet das benötigte Device und entzieht
es bei Terminalzustand, Crash, Revoke oder Deadline wieder. ACL-/DeviceAllow-
Entzug allein genügt nicht: `KillMode=control-group` oder ein gleichwertiger
cgroup-weiter Kill beendet alle Descendants, schließt offene GPU-Device-FDs
und gibt nachweislich jeden GPU-Kontext frei, **bevor** Terminal-Ack oder ein
neuer Grant zulässig ist. Positive
Admission- sowie negative Direct-Open-, stale-Grant-, Cross-Job-, Crash- und
Restart-/Child-/offene-FD-Tests werden operatorseitig signiert. Kann der aktuelle Orchestrator
diesen Grant nicht liefern oder verlässlich widerrufen, bleibt dies ein
expliziter Orchestrator-Blocker; F0-Freeze darf nicht beginnen.

Exit: `q2-runtime-sandbox.v1` bindet Mechanismus, Unit-/Policy-/Contractdigest,
UID/Consumer-ID und alle Grant-/Revoke-/Bypasstests. Keine App-Konfiguration
gilt als Ersatz für Device-Isolation.

### R0c/R0l – Control-Plane und Segment-Scheduler beweisen

**Ziel:** Die implementierte Vier-Action-State-Machine gegen die reale,
aktuelle Orchestrator-API beweisen. R0c läuft vor R1a; R0l erst aus dem
installierten R1b-Qualification-Release.

R0c-Aufgaben:

1. Vor jeder Arbeit den aktuellen `CALLER-GUIDE.md` und Consumer-Handoff
   erneut lesen; Contractcommit im Beleg binden.
2. CPU-Contracttests für `continue_current`, `yield_to_waiting_job`,
   `wait_for_successor`, `resume_current`, Timeout, Crash, Restart,
   Exactly-once-`boundary_id` und stale Antworten wiederholen.

Exit R0c: schema-validierter CPU-Contract-/Reconciliation-Report bindet Code,
Orchestrator-Vertrag und alle vier Actions. Dieser Exit ist die Vorbedingung
von R1a und benötigt keinen Live-Canary.

R0l-Aufgaben:

3. Nach R1b und QAuth-R0lR3 mit Betreiberfreigabe einen allowlisteten
   Wegwerf-Waiter
   verwenden und `LTX -> paused -> waiter terminal -> resuming -> LTX
   terminal` über die normalen APIs fahren. Keine Qwen-/State-Manipulation.
4. Checkpoint-/Freigabe-SLO und vollständige Reconciliation messen.

Exit R0l: der im SOTA-Plan definierte Live-Beleg, digestgebunden und ohne
fremde Serviceaktion. Engineering-Beleg nach späterem Finaldigest wiederholen.

Aufwand: 1–2 Tage plus ein kurzer GPU-Slot.

### R1a/R2 – Engineering-Release bauen, installieren und offline prüfen

**Ziel:** Einen unveränderlichen Engineering-Digest erzeugen und installieren,
ohne ihn vor Rights-Attest und Runtime-Enforcement live zu schalten.

Aufgaben:

1. Candidate-Surface und statische Rights-/SBOM-Evidence aus G0a einfrieren.
2. Vor dem ersten Build `canonical-build-input.v1` erzeugen. Er bindet Source-
   Commit/Tree und leitet `SOURCE_DATE_EPOCH` deterministisch aus dem
   gebundenen Source-Commit-Timestamp ab; außerdem Toolchain-/Lock-Digests,
   `TZ=UTC`, feste Locale (`C.UTF-8`), `umask=022`, Dateisortierung,
   Path-Map/Root-Normalisierung und alle sonstigen Buildflags. Zwei Clean-
   Builds in neuen getrennten Wurzeln verwenden exakt diesen Record; Manifest
   und Digest müssen bitgleich sein. Q1b-Release, F0-Rebuild und jede
   Fixpunktrevision mit demselben Source/Tree müssen denselben Build-Input-
   Digest nutzen. Andere Epoch/Locale/TZ/Umask/Path-Map ist ein erklärter
   `build_input_mismatch` vor dem Build, kein neuer scheinbarer Candidate.
3. Installieren nach `/opt/ltx-studio/releases/<digest>` und vollständigen
   Runtime-, Manifest-, Dependency- und Offline-Smoke ausführen.
4. R2-Bundlebericht und 40+40 kalte Browserkontexte für genau diesen Digest
   neu erzeugen.
5. Staged-Health, Schema, Migration und Rollback offline beziehungsweise auf
   einer nicht produktiv gerouteten Prüfadresse testen. Kein Unit-/`current`-
   Switch, kein Candidate-Render und kein R3 vor G0b und R1b.
6. Die Collector-Unit disabled und immutable installieren. Der Betreiber
   provisioniert eine unabhängige Monitoring-UID/GID, deren privaten
   Signaturschlüssel außerhalb der App-Secrets, die öffentliche Trust-Key-ID,
   einen nur für den Collector schreibbaren Rawroot und Unit-Härtung. App und
   Finalizer dürfen Rawrecords weder schreiben/ändern noch nachsignieren; der
   Collector darf keine App-/Release-Autorisierungsschlüssel lesen. Seine Unit
   erhält ausschließlich digestgebundene read-only Mounts auf Joint-Seal, beide
   Registry-/Anchor-Roots, Security-Ledger/Anchor und Trust-/Revocation-
   Snapshots sowie authentisiertes read-only IPC zum Interlock-CAS/Health. Jede
   Probe bindet Mount-/Source-/IPC-/Policy-Digests und beobachtete Head-
   Versionen sowie live Trust/Revocation des eigenen Monitoring-Keys; App/API/
   Finalizer können keine Messwerte einspeisen.
7. Eine getrennte Activation-Journal-Writer-UID samt privatem Signer-Key,
   öffentlicher Trust-Key-ID und owner-separiertem WORM-/TPM-äquivalentem
   Head-Anchor provisionieren. App, Engineering, Collector und Finalizer
   erhalten weder Writer-Key noch Reset-/Overwrite-Rechte. Negative ACL-/Key-
   und gültige Prefix-Restore-Proben müssen vor Live-Aktivierung bestehen.
8. Den Qualification-Supervisor als operator-owned gehärtete Unit mit eigener
   UID, monotonic-clock Policy, festem TERM/KILL-Fenster und alleiniger
   cgroup-Kontrolle installieren. App/Worker dürfen weder Unit/Timer noch
   cgroup-Mitgliedschaft verändern; der Supervisor darf keine fachlichen
   Inputs lesen oder einen Runner direkt execen. R1b-Preflight testet den
   zweiphasigen `accepted -> armed -> started`-Launch an jeder Journal-/Timer-/
   Exec-Grenze, Hänger, verlorenen Heartbeat, Supervisor-Restart und
   vollständige Descendant-/FD-Bereinigung.
9. Eine owner-separierte `q1b-security-interlock`-Unit mit eigener UID/GID,
   Signer-/Key-ID und engem IPC installieren. Nur sie besitzt set-only-CAS auf
   das extern verankerte monotone `{release_generation,latch_version,hold}`-
   Register. Audit-Deny-, Event- und Anchor-Watchdog dürfen ausschließlich
   `hold=true` anfordern; App, Activation-, Seal-, Registry- und Ledger-Writer
   dürfen weder setzen noch löschen. Ein gesetzter Latch ist in derselben
   Releasegeneration irreversibel; nur `supersede_release_generation.v1` darf
   nach unabhängig geschlossenem Incident einen **neuen** unset Register der
   höheren Generation anlegen, niemals den alten clearen. Fehlende/stale Unit-
   Health ist selbst HOLD.
10. Den dauerhaften Claim-Resolver als eigene gehärtete UID/Unit und Key-ID mit
    denselben autoritativen read-only Mounts und authentisiertem Interlock-IPC
    provisionieren. Er liest niemals App-/Status-API-Werte oder vom Marketing-
    Writer gelieferte Inputs. Ein getrennter Marketing-State-Writer mit eigener
    UID/Unit/Key darf nur
    die signierte Resolverentscheidung append-only publizieren, nicht deren
    Quellen oder Prädikate ändern, und verankert die höchste Resolution-
    Sequence/Hashchain extern. Resolver-Key-/Trust-/Freshnessfehler oder Writer-
    Ausfall sind im Statuspfad stets HOLD.
11. Den Q1b-Quiescence-Finalizer zugleich als owner-separierte, gehärtete
    Security-State-Finalizer-Unit provisionieren. Sie besitzt nur dieselben
    autoritativen read-only Mounts/Interlock-IPC, keine Component-Write-Rechte,
    und signiert die monotonen `q1b-security-state.v1`-Snapshots mit ihrer
    bereits getrennten Finalizer-Key-ID. Unlesbare/inkonsistente Teilquellen
    erzeugen keinen Snapshot, sondern HOLD. Eine weitere, vom Finalizer und
    allen Component-Writern getrennte Security-State-Anchor-Writer-UID/Key
    verankert jeden höchsten `{series,version,digest}`-Head extern; Finalizer,
    App und Engineering besitzen keine Reset-/Overwrite-Rechte.

Exit/Evidenz:

- Staged `/api/health` und der synthetische Sidecar nennen denselben
  Release-Digest.
- `canonical-build-input.v1` ist schema-validiert; beide Buildreports binden
  exakt denselben Inputdigest und negative Epoch-/Locale-/Path-Proben scheitern
  als Input-Mismatch.
- Staged `/api/projects` liefert HTTP 200 und das erwartete Projects-Envelope-
  Schema; Release-Autorisierung wird separat geprüft und nicht aus diesem
  Endpoint abgeleitet.
- absichtliche Manifestdrift verhindert Start/Freigabe.
- der unenforced Legacy-Digest bleibt nur read-only archiviert und kann unter
  keinem Unit-/`current`-Pfad einen Job annehmen; Bootstrap-Fallback ist
  derselbe R1a-Binary im `blocked`/`hold` oder service-stopped Maintenance.
- Collector-Unit-Digest, UID/GID, Trust-Key-ID und ACL-Deny-Tests sind gebunden.
- Security-Interlock-Unit-/Key-/IPC-/Anchor-Digests und set-only ACLs sind
  gebunden; Clear in derselben Generation, Event-/Anchor-Ack-Ausfall bei
  ausgefallenem Activation-Writer, Fence-Holder-Crash, Latch-Ack-Verlust und
  Prefix-/Restore-Proben enden fail-closed mit persistentem HOLD.
- Collector-/Claim-Resolver-Unit-, UID/Key-, read-only Mount-/Source-/IPC-/
  Trust-Policy-Digests und Deny-ACLs sind gebunden; Read-Denial, Partial-Read,
  stale Cache, Root-Swap, App-Spoof, IPC-MITM/Replay und Resolver-Ausfall enden
  fail-closed statt mit einer synthetischen grünen Probe.
- Collector-/Resolver-Key-Revoke, alte GO-Replay/Out-of-order, Resolver-Crash
  zwischen Signatur und Publish sowie Marketing-Writer-Race ergeben HOLD; der
  Resolution-Anchor verhindert Prefix-Rollback auf eine alte GO-Sequence.
- Security-State-Envelope-/Hashchain-/Anchor-Writer-Key und höchster Tuple-Head
  sind gebunden. Fabrizierte Component-Felder, Aggregatorsignatur ohne
  Component-Proofs, alter noch frischer grüner Snapshot, Prefix-/Snapshot-
  Restore nach Event/Latch, Anchor-Ausfall und Key-Policy-Substitution führen
  bei Start/Restart fail-closed zu HOLD.
- Journal-Writer-UID/Key-ID, Anchor-Backend und höchster
  `{generation,head_hash}` sind gebunden; Prefix-Restore führt nachweislich zu
  `hold`.
- Supervisor-Unit-/Policy-Digest, UID und negative Timer-/cgroup-Mutations-
  Tests sind gebunden; kein Qualification-Start ist ohne aktiven Supervisor
  zulässig.
- Bundle bleibt ohne Chunkwarnung und ohne Startzeitregression.
- Live-Unit und `/opt/ltx-studio/current` bleiben unverändert.

Aufwand: 2–4 Tage plus operator-gesteuerter Wartungsslot.

### G0a/G0b – Release-Surface auflösen und Digest attestieren

**Ziel:** Aus 26 conditional Kandidaten eine rechtlich freigabefähige,
bewusst schmale Surface machen.

G0a läuft vor R1a und entscheidet ausschließlich statische Inhalte:

1. Jeden Candidate-Eintrag auf Code-, Gewicht-, Dataset-, Biometrie-,
   Output-, Notice- und kommerzielle Rechte prüfen; Evidenzhashes und
   Ablauf/Widerruf binden.
2. Für jeden Blocker entweder schriftliche Rechte beschaffen, einen
   permissiven technisch gleichwertigen Ersatz implementieren oder den Pfad
   aus der Release-Surface entfernen. Kein UI-Hinweis ersetzt `blocked`.
3. Abliterated Gemma, InsightFace `buffalo_l`, MuseTalk-Gewichte/Face-Parser,
   ID-LoRA/TalkVid und VBench-AMT/MUSIQ/pyiqa explizit entscheiden.
4. Als initialen SOTA-Zielkorridor den einzigen aktuell extern vergleichbaren
   Claim vorbereiten: `audio-driven-video.image-audio-to-video`, de/en,
   2–5 Sekunden, ein Sprecher, frontal bis 20° Yaw, statische bis leichte
   Kopfbewegung, keine Musik und keine Schnitte. Die endgültige nichtleere
   Target-Menge wird erst in F0 eingefroren.
5. Alle übrigen zulässigen Claims als Production- oder `local-only`-Claims
   führen, bis ein fairer externer Anker existiert.

Exit G0a: Surface, SBOM, Lizenztexte, Evidence-Hashes und Policy-Version sind
statisch vollständig; kein Candidate hat `pending` oder unlesbare Evidence.
R1a bindet exakt diese Inhalte.

**G0u – Rights-Snapshot-Updater:** Ein operator-/rights-owned
`rights-snapshot-updater.v1` läuft außerhalb der App-UID und ihrer
Egress-Sandbox. Eigene UID, enge Ziel-Allowlist und TLS-/Signer-Trust erlauben
nur den Abruf der registrierten Rights-Quellen. Vor lokaler Publikation prüft
er Signer, Series, Evidence, Policy, monotone Version, `checked_at` und
`max_age`/`next_update`; danach monotonic-CAS, temporärer Write, Datei-`fsync`,
atomarer Rename und Directory-`fsync` in einen für die App nur lesbaren Root.
Letzte akzeptierte Version, Fetchfehler und Staleness werden append-only
journalisiert. Nach jedem Accept verankert eine vom Updater owner-separierte
Anchor-Writer-UID `{series, version, snapshot_hash, fetchlog_head}` in einem
WORM-/TPM-/Transparency-äquivalenten Head. Startup, Restore **und jeder
Consumer-Recheck** vergleichen Snapshotroot, Fetchlog und Anchor. Ein
gültiger älterer Prefix, fehlender/divergierender Anchor oder Snapshot/Log-
Restore führt zu `hold`, auch wenn `max_age` und Mindestversion formal noch
passen. App/Renderer behalten öffentlichen Egress gesperrt und können
weder Snapshot noch Updater-Key schreiben. Tests decken stale/missing,
Cross-Series/Evidence, Downgrade, Signerfehler, Netzfehler und atomaren Crash-
Recovery sowie Prefix-/Snapshot-Restore und Crash unmittelbar vor/nach Anchor
ab. Owner, Refresh-SLO und Recovery-/HOLD-Runbook sind vor G0b
signiert; ein manueller Dateikopierpfad gilt nicht als Produktionstransport.

G0b prüft danach den gebauten Digest **und** einen durch G0u publizierten
frischen Snapshot und stellt
das frische externe, zeitvariable Rights-Attest aus. Ändert G0b statische
Evidence, geht der Plan zurück zu G0a/R1a; nur Gültigkeit, Signatur und
Revocation-State bei identischen Evidence-Hashes ändern den Inhaltsdigest
nicht. G0b stellt **keine** Qualification-Autorisierung aus. Rights-Signer und
Qualification-Autorisierer müssen verschiedene Key-IDs und Systemidentitäten
haben; die Runtime-Evidence weist diese Trennung positiv nach. Jedes G0b-
Attest trennt einen unveränderlichen `rights_policy_evidence_digest` und eine
stabile `attestation_series_id` vom signierten Revocation-Snapshot mit
`checked_at`, `max_age`/`next_update`, Quelle und monotoner Version. Ein
frischer, monoton neuer Snapshot derselben Series bei identischer statischer
Evidence/Policy verändert den Inhaltsdigest nicht und darf als Successor
verwendet werden. Neue Series, andere Evidence oder andere Policy ist keine
Verlängerung, sondern folgt der statischen Invalidierungsregel.

Exit G0u/G0b: Updater-Unit-/Policy-/Allowlist-/Trust-Digest, Updater-/Anchor-
Writer-UIDs, read-only App-Root, letzte Version, Fetchlog-/Anchor-Head,
Refresh-SLO und negative Import-/Restoretests sind gebunden;
G0b-Attest und lokal publizierter Snapshot stimmen in Series/Evidence/Policy
überein und bleiben innerhalb `max_age`.

Aufwand: technisch 2–4 Tage; externe Rechteklärung potenziell 1–4+ Wochen.

### R1b – Qualification-Runtime serverseitig sperren und aktivieren

**Ziel:** Den Engineering-Release ausschließlich für autorisierte
Qualification-Läufe aktivieren; keine deklarative Surface darf allein einen
Jobstart erlauben und keine Candidate-Aktivierung ist Production-GO.

Aufgaben:

1. Den in R1e gebauten und in R1a versiegelten Enforcer zunächst im Zustand
   `blocked` starten. Nach dem separaten G0b-Rights-Attest signiert der
   **Qualification-Autorisierer** mit anderer Key-ID/Systemidentität
   ausschließlich die `qualification-mode-authorization.v1`.
2. Mode-Autorisierung, Consumption und Transition in einem journalisierten
   Record atomar binden und `blocked -> qualification_only` schreiben. R1b
   registriert **keine** Run-Autorisierung und ändert keine
   Binärdatei, kein Schema und keinen Lock; jede notwendige Codeänderung geht
   zurück zu R1e/R1a/R2/G0b.
3. Deployment-Preflight: 0 aktive Jobs, Datenbackup/-hash,
   Schemakompatibilität, atomarer Unit-/`current`-Switch und getesteter
   Bootstrap-Fallback. Ein unenforced Legacy-Digest darf weder als `current`
   noch als Unit-Ziel startbar sein. Nur mit Betreiberfreigabe; nie `tsx` oder
   Worktree-Source.
4. Nach Switch Health, Projects-Envelope, Release-Digest, Activation-Record
   und die negative normale Startstrecke prüfen. Replay-, Cross-Digest-,
   Ablauf- und Widerrufsproben gegen den gebauten Enforcer wiederholen. Erst
   nach einem separaten QAuth-Knoten ist der jeweils attestierte
   Qualification-Lauf erlaubt.

Exit/Evidenz:

- Qualification-Health bindet Release- und Rights-Attest-Digest.
- Activation-Journal steht genau einmal auf `qualification_only`; die
  Run-Registry ist noch leer und alle normalen Jobstartpfade bleiben gesperrt.
- Rights- und Qualification-Signer besitzen verschiedene Key-IDs und
  Systemidentitäten; Crash-Injection/Reconciliation beweist den gemeinsamen
  Consume-/Transition-Record ohne Double-Spend oder verlorenen Zustand.
- Ohne Registry-Record kann kein Candidate-Entry starten; negative Route-,
  Ablauf- und Widerrufstests sind grün.
- Prozess, `current`, Manifest und Sidecar binden denselben Digest; der
  Bootstrap-Fallback ist getestet und ein Legacy-Digest kann in keinem Pfad
  Jobs annehmen.

Aufwand: 2–4 Engineering-Tage plus operator-gesteuerter Wartungsslot.

### QAuth – Zweckgebundene Qualification-Runs registrieren

**Ziel:** `qualification_only` ist ein Modus, kein pauschaler Laufpass.

Für QAuth-R0lR3, QAuth-D0a, QAuth-D1, QAuth-Q0, QAuth-Q1b und QAuth-final gilt
derselbe Ablauf: Die jeweilige Input-/Seed-/Entry-/Budget-/Deadline-Matrix ist
vor Signatur vollständig eingefroren. Der Qualification-Autorisierer signiert
mit seiner vom Rights-Signer getrennten Identität genau einen phasengebundenen
Registry-Record; der Activation-Journal-Writer registriert ihn genau einmal
unter höherer Registry-Generation und verankert den neuen Head extern. Die
Mode-Generation ändert sich dabei nicht. Erst der erfolgreiche Registry-Exit
öffnet die konkret gebundenen One-time-Tickets. Cross-Phase-, Cross-Digest-,
Replay-, Deadline- und Prefix-Rollback-Tests bleiben fail-closed.

Exit QAuth: Registry-, Anchor- und Signerdigest stimmen; Ticketmenge und
Budget entsprechen exakt der eingefrorenen Matrix, jedes Ticket ist `pending`
und jeder andere Qualification- oder normale Start bleibt gesperrt. Q2 nutzt
diesen Mechanismus ausdrücklich nicht.

### R3 – Surface-Canaries, Soak und Pause/Resume

**Ziel:** Jede tatsächlich veröffentlichbare Kombination betrieblich
qualifizieren.

Aufgaben:

1. Pro Candidate-Eintrag definierte Cold-/Warm-Canaries mit Output,
   Spielbarkeit und vollständiger Provenienz.
2. 20 fest verteilte Pause/Resume-Zyklen über frühe, mittlere und späte
   Grenzen sowie jede kooperative Modusfamilie.
3. Vorregistrierte 50-Zeilen-Soak-Matrix mit Success- und Fault-Injection-
   Oracle; 0 verlorene, orphaned oder duplizierte Jobs, 0 ungebundene Outputs,
   0 fremde Serviceaktionen.
4. OOM-, Restart-, Reaper-, Fence-, Restore-, Stale-Request- und
   Rollbackszenarien abdecken. Wartegrund und Recovery-Aktion müssen in API
   und UI sichtbar sein.

Exit: vollständiger `technical-score`/R3-Report für den Engineering-Digest.
Nach jeder Code-/Lock-/Modelländerung invalidieren; auf dem Finaldigest
wiederholen.

Aufwand: 3–7 Tage und mehrere DGX-Slots.

### D0s – Data-Security-Preflight vor dem ersten realen Datenbyte

**Ziel:** Reale Pilot-, Kalibrier-, Comparator- und Holdoutdaten dürfen die
Engineering-Identität und unversiegelte Pfade nie berühren.

Aufgaben:

1. Den vorhandenen Legacy-Bestand unter `.ltx-studio` read-only inventarisieren
   und hashen. Zum Reviewzeitpunkt sind es ungefähr 4,0 GB/1.063 Dateien mit
   gemischtem `moddy`-/`root`-Ownership; Umfang wird bei Ausführung neu
   gemessen. Für jede Datei Herkunft, Rechte, Identität/Leakage-Komponente,
   Sidecarbindung, Owner und Retention klassifizieren. Unklassifizierte Daten
   werden `legacy-development-only` und dürfen nie D0a/D0/D1/Q0/Q1/Q2 oder
   Comparatoren speisen. Eine Migration in neue Rollen ist nur mit positiver
   Rechte-/Leakageentscheidung und neuem Auditrecord zulässig.
2. Root-Owner-Anomalien, verwaiste Sidecars sowie Lösch-/Retentionpfade über
   die offiziellen APIs beziehungsweise ein geprüftes Migrationsrunbook
   schließen; keine rohe Löschung oder Eigentumsumschreibung während der
   Inventur.
3. Getrennte UID/GID und owner-only Roots für Function-Tune,
   D0a-Design-Pilot, D1/Q0/Q1-Kalibrierung und Q2-Holdout provisionieren.
   Holdout-Custodian, Schlüsselinhaber und Writer sind nicht der
   Engineering-Account.
4. Unabhängige Signaturschlüssel, Trust-Policy, append-only Auditlog,
   verschlüsselte Ablage, Backup/Restore und ACLs einrichten. Positive und
   negative Zugriffsprüfungen belegen insbesondere, dass Engineering weder
   Holdoutlisten noch entschlüsselte Inhalte lesen kann.
5. Aufnahme-/Importvertrag mit Einwilligung, Biometrie, kommerzieller Nutzung,
   Widerruf, Löschung, Retention und einer definierten Folge für bereits
   eingefrorene/verbrauchte Evidenz verabschieden. Widerruf darf nicht als
   stilles Überschreiben eines Auditlogs umgesetzt werden.
6. Die komplette Import-, Split-, Leakage-, Scoring- und Löschstrecke zuerst
   ausschließlich mit synthetischen Nicht-Personendaten testen. Kein reales
   **neues** Aufnahme-, Metadaten- oder Modelloutput-Byte vor bestandenem
   Preflight; Legacy-Daten bleiben bis zur Klassifikation ausgeschlossen.

Exit/Evidenz:

- `operational-readiness-check` besteht auf synthetischen Fixtures;
- UID/GID-/ACL-Deny-Tests, Key-/Audit-/Backup-/Restore-Belege und
  Lösch-/Widerrufsrunbook sind signiert;
- Legacy-Inventar hat 100 % Disposition; unklassifizierte und
  `legacy-development-only` Dateien sind technisch aus allen Evidenzroots
  ausgeschlossen;
- der unabhängige Holdout-Custodian ist benannt und technisch vom
  Engineering-Account getrennt.

Aufwand: 2–5 Tage plus Betreiber-/Rights-Provisionierung. Keine realen Daten.

### D0a/D0 – Pilotdesign, Daten, Rollen und Power

**Ziel:** Genügend rechtlich zulässige, leakage-freie Daten und vorab feste
statistische Grenzen.

Vorbedingung: D0s ist vollständig grün. Erst jetzt dürfen reale Daten
aufgenommen, importiert oder bewertet werden. Jeder Studio-gestützte Pilot-
oder Scoringlauf im D0a-Pilot benötigt zusätzlich QAuth-D0a. D0 selbst ist
danach reine Data-Custody-/Akquise-/Freeze-Arbeit und darf keine Studio- oder
GPU-Jobs starten; alle eigentlichen Scoringläufe beginnen erst in D1.

Aufgaben:

1. Die in D0s getrennten Rollen mit realen Split-IDs registrieren. Trennung
   nach Identität, Sprecher, Session, Quelle und transitiver
   Leakage-Komponente.
2. Eigene Einwilligungs-/Biometrie-freigegebene Aufnahmen bevorzugen;
   Aufnahme-, Widerrufs-, Lösch- und kommerzielle Nutzungsrechte im Ledger.
3. D0a-Rohpilot für Wiederholbarkeit, Test-Retest, Basisraten, Design-Effekt,
   MOS-Anker und fachliche Deltas durchführen.
4. VBench-Gates ankerunabhängig festlegen. Nichtkommerzielle Implementierung
   vor D0a lizenzieren oder ersetzen; Gateänderung danach invalidiert alle
   datenabhängigen Phasen.
5. Nach der M1-Surface-Regeneration ein kanonisches Gate-Set mit Digest,
   anwendbaren Claim-/Dimension-IDs und dynamisch berechnetem Count einfrieren.
   Der heutige Stand hat 37 feste plus 90 VBench-D1-Gates; diese Zahlen sind
   Beobachtung, kein zukünftiges Literal.
6. Die Powerfamilie maschinell aus demselben Gate-Set ableiten und absolute
   sowie anchor-relative Hypothesen getrennt zählen. Heute ergeben
   90 VBench-Gates mit je zwei Vergleichen plus 13 weitere Familien 193
   Hypothesen; auch dieser Count wird nach M1 neu berechnet.
7. Simulation/Power für FAR/TAR, Worst-Strata, ASR, Gate-Set, Cross-Shot,
   VBench und MOS; N nach unabhängiger Leakage-Komponente dimensionieren.

Exit: `pilot-freeze-check`, `readiness-check` und
`operational-readiness-check` stehen auf `ready-to-freeze`; keine echten
Holdoutwerte sind zugänglich.

Aufwand: 1–3 Wochen plus Akquise/Annotation.

### D1 – Alle Evaluatoren real kalibrieren

**Ziel:** Das nach M1/D0a digestgebundene Gate-Set mit realen
Positiv-/Negativdaten und eingefrorenen Fingerprints entscheidbar machen.

Jeder Studio-gestützte Lauf ist an eine QAuth-D1-Registry-Autorisierung
gebunden; sie kann weder Q0/Q1 noch Q2 autorisieren.

Umfang:

- AV-Offset und Abstention;
- P/B/M- und Phonem-/Visem-Inhalt;
- ASR-WER insgesamt und pro Stratum sowie 99-%-Gates für Namen, Zahlen und
  Negationen;
- Mund-/Hautartefakte, Flimmern und bewegungskompensierte Warp-Residuals;
- SFace-Identität, Schärfe und Worst-Strata;
- sechs getrennte VBench-I2V-Dimensionen für jeden anwendbaren Claim;
- Kalibrierfehler, FAR/FRR, Bootstrap-/Holm-Grenzen und vollständige
  Evaluator-/Runtime-Fingerprints.

Exit: `complete-d1` liefert exakt die IDs und den Count des eingefrorenen
Gate-Set-Digests. Jedes anwendbare In-Domain-Pflichtgate ist grün. Abstention
ist nur für schema-validiert unbrauchbare beziehungsweise OOD-Eingaben
zulässig und benötigt eine eigene Fehl-Abstention-Kalibrierung; sie darf kein
gerissenes Pflichtgate verdecken. Kein fehlender Messwert, kein fremder
Claim-Score und kein Gesamtscore über gerissene Dimensionen.

Aufwand: 1–2 Wochen nach D0.

### Q0 – Cross-Shot-Qualität beweisen

**Ziel:** Kontinuitätsgewinn ohne erneuten Schärfe-/Mund-/Identitätsverlust.

Alle Studio-Renderjobs verwenden ausschließlich QAuth-Q0-Tickets.

Aufgaben:

1. `casting-a.mp4` nicht weiterverwenden; neue helle, nahe, scharfe und
   szenengleiche Quelle akquirieren.
2. CPU-Guardrail vor dem Render; Ziel klar oberhalb 35, nicht knapp am
   unkalibrierten Minimum.
3. Gepaarter Faktoriellauf mit festen Seeds und mindestens
   `max(D0a-Power, 30 Identitäten)`.
4. Manuelle, automatische und referenzlose Strategie gegen Identität,
   Cross-Shot-Minimum, Schärfe, AV, P/B/M, ASR, Haut-/Warp-Artefakte und MOS
   bewerten.
5. Automatische Auswahl bleibt aus, bis sie gegenüber manueller Auswahl
   äquivalent oder überlegen ist.

Exit: fachlich relevante Überlegenheit mit gleichzeitiger
Nichtunterlegenheit aller Schutzgates oder ehrliche Abstention.

Aufwand: 3–7 Tage plus GPU-Zeit.

### Q1a/Q1b – Externe Anker fair und lokal vergleichen

**Ziel:** Ein tatsächlich anwendbarer SOTA-Anker, nicht nur ein lokaler
Baselinevergleich.

Q1 ist bewusst zweigeteilt. Q1a erzeugt Voraussetzungen und darf keine
Qualitätsauswahl treffen; erst Q1b sieht Kalibrierdaten und Qualitätswerte.

Jeder externe GPU-Lauf verwendet `external-comparator-run-ticket.v1` in einer
von Studio-QAuth getrennten append-only Registry. Der Vertrag bindet Phase
(`q1a_profile` oder `q1b_quality`), Release-, Comparator-Code-, Gewichts-,
Runner-, `claim_id`, Comparator-/Quality-Matrix-, Inclusion-/Failure-/ITT-
Regel-, Gate-Set-/Evaluator-Revisions-, Input-, Seed-/Profil-, Ressourcen- und
Normalisierungsdigests sowie den **erwarteten** Output-Root/-Contract,
`rights_policy_evidence_digest`, `attestation_series_id`,
`minimum_snapshot_version`, `not_before`, `start_by`, `complete_by`, Job-/GPU-
Sekunden-/Outputbudget, Nonce und vorregistrierte Recovery. Ein vom
Qualitätsteam getrennter Comparator-Run-Autorisierer signiert die vollständig
sortierte Ticketliste; ein owner-separierter Single Writer konsumiert beim
Admission-Accept atomar **nur** Nonce/Budget und `pending -> accepted`.
Danach folgen getrennte append-only Transaktionen: `accepted -> armed`, inert
Wrapper, durable `armed -> started`, Exec-Barrieren-Ack und zuletzt
`started -> terminal`. Jeder Record bindet `prev_hash`/Head; Überspringen,
Zusammenfassen oder nachträgliches Umschreiben ist unzulässig. Es gelten
dieselbe signierte Hashkette/Head-Verankerung, Rights-Freshness und der
deadlineunabhängige Prozess-cgroup-Supervisor wie Studio-QAuth; cgroup,
persistierte Deadline und Timer müssen vor dem ersten Comparator-Runner-Byte
`armed` sein, dieselben Arm/Journal/Exec-Fault-Tests gelten. Jeder Attempt
und jeder technische Fehler bleibt terminal in ITT; erst der Terminalrecord
bindet tatsächlichen Outputdigest, Provenienz oder Failurecode eindeutig.
Ersatzlauf oder Retry ist
nur als vorab registrierte Recovery desselben Tickets innerhalb Deadline und
Budget zulässig. Q1a-Collector/Signer sieht ausschließlich Ressourcentelemetrie,
keine Qualitätswerte. Replay, Cross-Claim/-Arm/-Weights/-Input/-Seed/-Matrix-/
Failure-/Gate-/Evaluatorrevision, Cross-Phase, stale Rights, Budget, Crash,
Replay an **jeder** Transition und unerlaubter Retry sind negative Exit-Tests.

Q1a-Prepare-Aufgaben:

1. Cutoff-datierte Landschaft erneut gegen offizielle Quellen prüfen.
2. LongCat in einen sauberen, commit-gepinnten Read-only-Checkout überführen;
   Outputs/Telemetrie außerhalb der Sourcewurzel. Den heutigen schmutzigen
   Entwicklungscheckout nicht als finalen Anker verwenden.
3. Wan2.2-S2V commit- und gewichtsdigest-gepinnt installieren, Rights prüfen
   und als eigenen Orchestrator-Consumer registrieren.
4. Die synthetische Profilmatrix mit exakt drei geplanten Läufen pro
   anwendbarem Arm, Inputs, Seeds, Ressourcen-/Thermalgrenzen und technischen
   Inclusion-Regeln einfrieren.
5. Externe Registry, Single-Writer-/Authorizer-/Collector-Trust und den
   owner-separierten cgroup-Supervisor als gehärtete Units provisionieren;
   App, Comparator und Qualitätsauswerter können Registry, Timer, Telemetrie-
   Blindung und Terminalrecords nicht verändern. Negative ACL-/Timer-/Crash-
   Tests vor dem ersten Ticket.

Exit Q1a-Prepare: Landschaft, saubere Installationen und synthetische
Profilmatrix, Registry-/Supervisor-Units und Trust sind eingefroren; noch kein
Comparator-GPU-Lauf.

ExtTicket-Q1a-/Q1a-Profile-Aufgaben:

1. Exakt drei Tickets pro anwendbarem Arm aus der eingefrorenen Matrix als
   ExtTicket-Q1a-Profile signieren. Erst danach die kalten, offline,
   admission-gesteuerten
   Ressourcenprofile fahren. Es werden nur Startfähigkeit, VRAM,
   Zeit, Temperatur, Outputvertrag und Reproduzierbarkeit erfasst; keine
   Qualitätsmetrik wird berechnet oder zur Auswahl zugänglich gemacht.
2. Inclusion/Exclusion ausschließlich anhand vorab gehashter Rechte-, Input-,
   Reproduzierbarkeits-, Ressourcen- und technischer Mindestfunktionsregeln.
   MOVA bleibt wegen inkompatiblem Inputvertrag sichtbar ausgeschlossen. Ein
   technisch anwendbarer Gegner darf wegen Qualität niemals entfernt werden.

Exit ExtTicket-Q1a/Q1a-Profile: genau drei terminale ITT-Profile pro
anwendbarem Arm und eine ergebnisunabhängig eingefrorene Comparator-/Input-/
Normalisierungs-/Failure-Matrix. Erst dieser Exit plus D1-Run erlaubt
QAuth-Q1b und externe Quality-Run-Tickets.

Q1b-Aufgaben:

1. Vor Ergebniseinsicht Studio-QAuth-Q1b und die vollständige
   ExtTicket-Q1b-Quality-Liste signieren. Studio-seitige Kandidatenjobs
   ausschließlich mit QAuth-Q1b, externe Comparatoren ausschließlich mit
   diesen admission-, input- und digestgebundenen Tickets starten. Beide
   Ticketlisten besitzen eigene unverwechselbare Generation-/Root-IDs.
2. Identische Portraits, Audios, Timeline, Auflösung, Normalisierung und
   Failure-Regeln aus der Q1a-Matrix verwenden; ITT behält jeden Fehler.
3. Qualitäts-Pilot ausschließlich auf Kalibrierdaten. Ein schwacher Gegner
   bleibt enthalten; keine Q1a-Inclusion-Regel darf nach Ergebniseinsicht
   geändert werden.
4. **Q1b-Seal:** Beide Ticketset-Generationen koordiniert und irreversibel
   `open -> sealing -> sealed` führen. Zuerst Admission für diese Generationen
   sperren, alle Runs/Recoveries terminalisieren und beide Heads/Nullzähler
   fixieren. Ein owner-separierter Seal-Writer erzeugt und verankert danach
   `q1b-joint-seal.v1` über Generation-/Ticketset-/Head-/Anchor-Digests; beide
   Registries konsumieren dasselbe Seal und werden `sealed`. Dabei entzieht
   der Seal-Writer beiden Registry-Writern dauerhaft die Write-/Admit-ACL für
   diese Generation und übernimmt den Root read-only/immutable beziehungsweise
   WORM-/verity-äquivalent; auch ein kompromittierter alter Writer kann den
   Head nicht erweitern. Ein Crash in
   einem Teilzustand bleibt fail-closed `sealing`; Reconciliation darf nur
   dasselbe Joint-Seal vollenden oder `hold`, nie wieder `open`. Append-/Admit-
   Versuche nach Seal werden per ACL/API abgewiesen, verändern den versiegelten
   Head nicht und landen terminal in einem **separaten** Security-Event-Ledger.
   Neue Q1-Arbeit ist ausschließlich in höherer Generation und neuem Root
   möglich. ACL-/API-Deny-, Partial-Seal-, Crash-/Restore- und Replaytests sind
   Pflicht. `q1b-security-ledger.v1` beginnt mit signiertem Genesis und bindet
   pro Event einen lückenlosen monotonen Source-Cursor/Sequence, Boot-ID,
   Generation/Seal/Head, versuchende Key-/Process-/Hostidentität, Route,
   monotone/Wall-Clock, Rohbeleg sowie getrennte Event-Writer- und Anchor-Key-
   IDs. Abgewiesene Append-/Admitversuche schreibt eine owner-separierte
   Security-Event-Writer-UID; ein wiederum getrennter Anchor-Writer verankert
   jeden akzeptierten Head. Frische signierte Coverage-/Health-Checkpoints
   belegen erwarteten und tatsächlichen Audit-Source-Cursor, Writer-/Anchor-
   Liveness und das gebundene SLO. `missing`, Cursor-/Sequence-Lücke,
   unavailable, stale Health oder Head-/Anchor-Divergenz ist HOLD und darf nie
   als `0 violations` erscheinen. Der Deny-Pfad bleibt unabhängig davon
   blockierend; ohne Event- plus Anchor-Ack fordert er über die separate
   `q1b-security-interlock`-UID per engem IPC set-only-CAS an. Deren Signer-/
   Key-/Unit-/ACL-/Health-/Anchor-Digests und monotone Latch-Version gehören zu
   jedem Checkpoint. Interlock oder Ack unavailable/stale ist ebenfalls HOLD;
   der Enforcer verweigert Starts auch dann, wenn noch kein Latch geschrieben
   werden konnte. Ein gesetzter Latch ist generationslokal unlöschbar. Ein
   `q1b_seal_violation` löst sofort Security-HOLD, Credential-Revoke und das
   Host-Incident-Runbook aus. Nur ein unabhängiger Closure-Signer darf einen
   Incident terminal schließen; die betroffene Seal-Generation bleibt dennoch
   dauerhaft unbrauchbar und verlangt neue Generation/Roots, Q1b-Seal und F0.
   Event-Writer-/Anchor-Ausfall auch bei ausgefallenem Activation-Writer,
   Audit-Source-Gap, Deny unmittelbar vor/während Promotion-Fence, Fence-Holder-
   Crash, Latch-Ack-Verlust, Ledger-Prefix-/Restore-/Anchor-, Key-Revoke-,
   Recovery- und Event-direkt-nach-Check-Tests sind Pflicht.

   Alle daraus gelesenen Prädikate werden ausschließlich als signiertes
   `q1b-security-state.v1`-Composite konsumiert. Der owner-separierte Q1b-
   Quiescence-/Security-State-Finalizer liest dafür direkt aus den autoritativen
   read-only Roots/Interlock-IPC und besitzt keinerlei Component-Write-Recht.
   Das Composite ist ein **proof-carrying Envelope**, kein neues Einzel-Orakel:
   Es trägt die vollständigen beziehungsweise content-addressierten, jeweils
   komponentenseitig signierten Records samt WORM-/TPM-/Transparency-Anchor-
   Proofs. Jeder Consumer verifiziert alle Component-Signaturen und Proofs selbst;
   die Finalizer-Signatur attestiert nur Envelope-Vollständigkeit. Der
   unveränderliche `security_state_contract_digest` pinnt Schema, Source-IDs,
   die sieben Component-Rollen/Key-Policy, deren Anchor-Backends und exakt die
   erlaubten mutablen Felder. Key-/Trust-/Source-/Anchor-Policy-Wechsel ist
   Cross-Contract und nie Live-Successor. Jeder Snapshot bindet außerdem
   `security_state_series_id`, monotone Version/Digest, `prev_hash`, Ledger-
   Source-Cursor/Sequence/Boot-ID, Ledger-/Anchor-Heads, Coverage-/Health-SLO,
   Interlock-Unit-/Policy-/IPC-/ACL-/Health-/Key-/Anchor-Digests, Latch-Version/
   -Wert, beide Violation-Zähler und verifizierte Trust-/Revocation-Proofs.
   Ein vom Finalizer getrennter Security-State-Anchor-Writer verankert nach
   jedem Snapshot den höchsten `{series,version,digest}`-Head extern. Quiescence
   bindet Snapshot und Anchor-Head; Freeze/EvalAuth binden Digest, Series,
   Mindestversion, Anchor-Head und die einzige erlaubte Live-Successor-Regel.
   Jeder Start/Restart sowie Ready/Q2/P4/O24/O7/Resolver vergleicht Envelope,
   Hashchain und externen höchsten Head und akzeptiert nur monoton neuere
   Snapshots derselben Series mit identischem Contract, nicht rückläufigen
   Cursor-/Heads, frischer Health, unset Latch, zwei Nullzählern und gültigen
   Component-Proofs. Cross-Series/-Contract, stale, gap, fehlender/divergierender
   State-Anchor oder Regression ist HOLD. Keine Phase darf behauptete Felder
   oder eine Aggregatorsignatur ohne Component-Proofs akzeptieren.

Exit Q1b-Seal: Die exakt eingefrorenen Studio-QAuth- und externen Quality-
Ticketgenerationen stehen irreversibel `sealed` und besitzen vollständige terminale ITT-Ledger; `0 pending`,
`0 accepted`, `0 armed`, `0 started`, `0 offene Recovery`. Beide Registry-
Heads/Anchor, Collector und tatsächliche Output-/Failure-Provenienz sind
reconciled und im Quality-Report gebunden. Pro Claim steht enthaltener Anker
oder `local-only`; mindestens ein späterer Target-Claim besitzt einen
rechtsklaren, anwendbaren Anker und feste Schlagregel. Erst dieser signierte
`q1b-quiescence-record.v1` erlaubt F0-build. Er bindet
`q1b-joint-seal.v1`, Seal-Status, Schema-/Policy-Version,
Release, beide Ticketsetdigests, Registry-/Anchor-Heads, alle Nullzähler,
Collector-/Quality-Reportdigest, Trust-Policy, `issued_at` und Nonce. Ein
qualitätsunabhängiger Quiescence-Finalizer mit eigener Key-ID signiert; weder
Quality-Auswerter noch Qualification-/Comparator-Registry-Writer dürfen den
Record allein attestieren. Er bindet zusätzlich den aktuellen
`q1b-security-state.v1`-Snapshotdigest/Series/Version/externen Anchor-Head und verlangt dessen unset
Latch, zwei Nullzähler, frische Health sowie gültigen Trust. Gap,
stale/unavailable oder HOLD-Latch verhindern den Exit.

Aufwand: 1–2 Wochen; GPU-Schätzung erst nach drei kalten Profilen belastbar.

### F0 – Finalkandidat bauen und einfrieren

**Ziel:** Letzte Änderung vor dem einmaligen Holdout.

Aufgaben:

1. Alle Q0/Q1a/Q1b-Rückläufer vollständig über die Invalidierungsmatrix
   schließen und `q1b-quiescence-record.v1` gegen beide aktuellen Registry-/
   Anchor-Heads sowie `q1b-joint-seal.v1` revalidieren. Beide Generationen
   müssen irreversibel `sealed` sein. Der aktuelle `q1b-security-state.v1`-
   Snapshot muss über die gebundene Live-Successor-Regel vollständig grün sein;
   jeder Versuch, Cross-Series/-Contract-, Trust-, Availability-/Coverage-
   Fehler oder Latch erzeugt Security-HOLD und eine neue Generation/F0. Ein offener,
   teilweise versiegelter oder mutierter Head blockiert F0.
2. **F0-build/R2-final:** Finalen R1a-Doppelbuild in zwei neuen sauberen
   Wurzeln erstellen und R2 für genau diesen Digest wiederholen. Dies erzeugt
   erst die Release-/Surface-Digests; davor kann keine QAuth-final existieren.
   Der kanonische Inhaltsdigest enthält statischen Code/Locks/Surface, aber
   keine späteren Q1b-/Rights-/Signaturrecords; diese werden extern an ihn
   gebunden. So ist der Gleichheitscheck nicht selbstreferenziell. Q1b-
   Release und F0 müssen zusätzlich denselben `canonical-build-input.v1`-
   Digest besitzen.
3. **Digest-Fixpunkt:** Exakt
   `q1b-quiescence-record.v1.release_digest == f0_release_digest` verlangen.
   Ein unabhängiger Build-Verifier signiert
   `q1b-final-release-equality.v1` über Quiescence-/Joint-Seal-, Source-/Tree-,
   `canonical-build-input.v1` samt Epoch/Toolchain/Locale/TZ/Umask/Path-Map,
   Manifest-, beide Clean-Build- und R2-Digests. Keine freie Packaging-
   Äquivalenz ist zulässig. Bei Abweichung wird der neue F0-Digest zum nächsten
   Candidate und die Ursache nach der Invalidierungsmatrix geschlossen
   (einschließlich D1/Q0, falls Code/Lock/Modell/Evaluator betroffen): danach
   G0b/R1b auf diesem Digest, neue QAuth-Q1b und
   ExtTicket-Q1b-Quality, alle Q1b-Arme/ITT erneut ausführen, neu versiegeln
   und F0 reproduzierbar neu bauen. Die Schleife endet ausschließlich beim
   exakten Digest-Fixpunkt; der abweichende Kandidat darf nicht eingefroren
   werden.
4. **G0b-final:** Zuerst G0u-Unit-/Policy-/Trust-Digest, Fetchlog-/Anchor-Head,
   Snapshot-Hash, Series/Version und `checked_at/max_age` aktuell grün binden;
   stale, Updater-HOLD oder Headabweichung blockiert. Erst dann für diesen
   Finaldigest ein frisches Rights-Attest samt Revocation-Snapshot ausstellen.
5. **R1b-final-mode:** Den Finaldigest im leeren `qualification_only` einer
   neuen Mode-Generation aktivieren. Zuvor erzwingt
   `supersede_release_generation.v1` `0 armed/started` und keine blockierten
   Wrapper/Prozess-cgroups, terminalisiert alle alten
   `pending/accepted` Engineering-Tickets als `closed_by_supersede`, verankert
   den alten Head und öffnet den Finaldigest in einer höheren Generation auf
   `blocked`. Erst dann wird dessen neue Mode-Autorisierung konsumiert; keine
   Engineering-Run-Authorization wird übernommen.
6. **QAuth-final -> Final-R0l/R3:** Erst jetzt die bereits eingefrorene
   Final-R0l-/R3-Matrix signieren, genau einmal registrieren und R0l/R3 für
   diesen Digest wiederholen. Ältere Engineering-Tickets gelten nicht.
7. **F0-Freeze:** Nichtleere `target_sota_claim_ids`, Inputs, Seeds, Strata, N, Deltas,
   Gates, Comparatoren, MOS, ITT und Abbruchregeln signiert einfrieren.
   Unmittelbar vor Signatur `sealed`, Joint-Seal und beide exakten Q1b-
   Registry-/Anchor-Heads erneut prüfen; Freeze bindet
   `q1b-quiescence-record.v1`, `q1b-final-release-equality.v1`, Seal, Heads und
   den vollständigen aktuellen `q1b-security-state.v1`-Snapshotdigest samt
   Contract/Series/Version/externem Anchor-Head sowie die einzige erlaubte
   Live-Successor-Regel.
8. Den finalen `q2-runner.v1`-Digest, Consumer-ID, Release-Digest, versiegelte
   Roots und bestandene Admission-/Bypasstests in F0 binden. Danach genau eine
   `evaluation_authorization` mit
   `not_before`, `start_by`, `complete_by`, Nonce, Recovery-Regel,
   `rights_policy_evidence_digest`, `attestation_series_id`,
   `minimum_snapshot_version` und der ausdrücklich erlaubten monotonen
   Same-Series-Successor-Regel sowie Digest von
   `q1b-quiescence-record.v1`, `q1b-joint-seal.v1` und deren Registry-/Anchor-
   Heads, `q1b-final-release-equality.v1` sowie den aktuellen
   `q1b-security-state.v1`-Snapshotdigest, Contract/Series/Mindestversion,
   externen Anchor-Head und exakt dieselbe Live-Successor-Regel. Direkt vor Autorisierungssignatur werden
   Seal/Heads, `sealed` und das Composite erneut geprüft. Andere
   Evidence/Policy bleibt
   verboten. Jede Registry-
   Mutation nach Freeze macht die Autorisierung unbrauchbar und verlangt vor
   Holdoutöffnung neuen F0 plus disjunkten Holdout; nach Öffnung gilt derselbe
   neue-Holdout-Vertrag ohne Retry.

Exit: `f0-pass-ready-for-q2`, `production_authorized=false`, Holdout noch
ungeöffnet. Jede weitere fachliche Änderung erzeugt neuen F0 und neuen
disjunkten Holdout.

Aufwand: 2–4 Tage plus wiederholte Canaries.

### Q2 – Holdout und Blind-MOS genau einmal

**Ziel:** Unabhängiger, nicht nachträglich optimierbarer Qualitätsnachweis.

Aufgaben:

1. Der unabhängige `q2-runner.v1` läuft unter eigener UID/Consumer-ID, bindet
   exakt den in F0 versiegelten Runner-/Release-Digest und erhält Admission
   ausschließlich über den DGX-Orchestrator. Er kann weder `jobs.create` noch
   Produkt-UI/API, Activation-Journal oder QAuth-Registry verwenden; direkte
   GPU-Nutzung und fremde Roots sind technisch gesperrt.
2. Autorisierung, Rechte, Trusted Keys und Deadline vor Entschlüsselung
   prüfen. Bei Admission, unmittelbar vor Start und nochmals **vor
   Entschlüsselung** müssen `q1b-joint-seal.v1`, beide Q1b-Registry-/Anchor-
   Heads und `sealed` exakt entsprechen. Der aktuelle
   `q1b-security-state.v1`-Snapshot muss die EvalAuth-gebundene Contract/Series/
   Mindestversion, Hashchain/externen höchsten Anchor-Head und Live-Successor-
   Regel samt Component-Proofs erfüllen;
   Abweichung
   öffnet den Holdout nicht und invalidiert F0/EvalAuth. Danach signierter
   Zustand `started -> consumed` mit identischer
   Transaction-ID/Nonce. Rights-/Revocation-Snapshot und Deadline werden bei
   Admission, Start, jedem Resume/Heartbeat/Segment und vor Outputfreigabe
   nach derselben Freshness-Policy erneut geprüft. Ein Verstoß nach
   `consumed` hält das Ergebnis fail-closed und verbraucht den Holdout; er
   erlaubt keinen stillen Retry. Seal/Heads und der aktuelle
   `q1b-security-state.v1`-Envelope/Hashchain/Anchor werden nach exakt derselben gebundenen
   Live-Successor-Regel bei jedem Resume/Heartbeat/Segment und vor
   Outputfreigabe geprüft; Event, Gap, Ausfall, Latch, Cross-Series/-Contract
   oder Trust-Drift löst sofort HOLD und Incident-Runbook aus.
3. Alle Arme aus den versiegelten Inputroots in versiegelte Outputroots auf
   dem Holdout nach ITT ausführen; 10.000
   Bootstrap-Replikate nach Sprecher und Leakage-Komponente.
4. Blind-MOS mit zufälliger Armreihenfolge, identischer Lautheit/Zeitachse,
   Rater-QC und Holm-Korrektur.
5. Kein Retry nach Ergebniszugriff. Infrastruktur-Recovery nur innerhalb der
   vorab registrierten Exactly-once-Regel und Deadline.

Exit: signierter Q2-Report. Jeder Target-Claim ist `sota-qualified`; andernfalls
bleibt `sota_overall=hold`, auch wenn Production-GO möglich wäre.

Aufwand: erst nach berechnetem N, Comparatorprofilen, MOS-Panel-Verfügbarkeit
und Queue-Kapazität als P50/P90 belastbar; vor F0 kein Kalendertermin.

### P4 – Finaler Audit, Promotion und Betrieb

**Ziel:** Ein autorisierter Release statt eines impliziten „müsste laufen“.

Aufgaben:

1. `audit:release` sammelt ausschließlich digestgebundene R0–Q2-Evidenz und
   erzeugt `ready_for_release_authorization`. Vor diesem Status revalidiert es
   exakt die in Freeze und Evaluation-Autorisierung gebundenen
   `q1b-quiescence-record.v1`, `q1b-joint-seal.v1`, die **beiden** versiegelten
   Studio-/Comparator-Generations-, Root-, Registry- und externen Anchor-Heads,
   `q1b-final-release-equality.v1`, `canonical-build-input.v1` und den finalen
   Release-Digest. Zusätzlich muss der aktuelle `q1b-security-state.v1`-
   Snapshot die Freeze-/EvalAuth-gebundene Contract/Series/Mindestversion und
   Live-Successor-Regel vollständig erfüllen. Trust- und Revocation-Policy
   prüft aktuell die getrennten Signer des Joint-Seals, Quiescence- und
   Equality-Records sowie Security-Event-, Ledger-Anchor-, Security-Interlock-,
   Incident-Closure- und Security-State-Anchor-Writer; jede Abweichung ergibt
   `hold`.
2. Getrennter Autorisierer signiert Evidence-, Release-, Prereg-, Q2- und
   Rights-Digests.
3. Finalizer revalidiert Rechte, Ablauf, Widerruf und Trusted Keys zum
   Entscheidungszeitpunkt und erzeugt den signierten Envelope. Er liest die
   vollständige Joint-Seal-/Quiescence-/Equality-/Build-Input-Kette samt beiden
   Registry-/Anchor-Heads und `q1b-security-state.v1` erneut aus den
   autoritativen Roots; insbesondere müssen alle sieben Component-Signerrollen
   **plus** Security-State-Anchor-Writer noch trusted und nicht widerrufen und
   das Composite nach seiner
   Live-Successor-Regel vollständig grün sein. Eine
   ältere Evidence-Zusammenfassung darf diesen Live-Recheck nicht
   ersetzen.
4. Promotion zweiphasig ausführen. Im `prepared`-Schritt zuerst Journal-/
   Anchor-Head und höchste gesicherte Generation abgleichen sowie Collector-/
   Resolver-Unit-Digests, unabhängige UIDs/Key-IDs mit aktuellem Trust/
   Revocation, Trust-Policy, Rawroot-ACLs, Resolution-Writer-/Anchor-Vertrag,
   digestgebundene read-only Source-Mounts/authentisiertes Interlock-IPC und
   negative App-/Finalizer-Write-/Sign-/Input-Spoof-Tests prüfen. Eine rein side-effect-freie
   Policy-/Signature-Dry-run-Matrix muss alle `released`- und gesperrten Fälle
   korrekt entscheiden. Zusätzlich sind 0 aktive/queued Qualification-Jobs,
   0 `accepted/armed/started`-Tickets und eine reconciled QAuth-Registry
   Pflicht. Der Prepared-Preflight wiederholt den vollständigen Audit-Recheck:
   `q1b-quiescence-record.v1`, `q1b-joint-seal.v1`, **beide** irreversibel
   versiegelten Studio-/Comparator-Generationen und deren Root-/Registry-/
   Anchor-Heads, `q1b-final-release-equality.v1`, `canonical-build-input.v1`,
   finaler Release-Digest sowie die aktuellen Trust-/Revocation-Zustände von
   Seal-Writer, Quiescence-Finalizer, Build-Verifier, Security-Event-Writer,
   Security-Ledger-Anchor-Writer, Security-Interlock-Writer, Incident-Closure-
   Signer und Security-State-Anchor-Writer müssen exakt Freeze und EvalAuth
   entsprechen.
   Der aktuelle `q1b-security-state.v1`-Snapshot muss dieselbe Contract/Series/
   Mindestversion, Hashchain/externen höchsten Anchor-Head und Live-Successor-
   Regel mit selbst verifizierten Component-Proofs erfüllen. Jede Abweichung ist `hold`, nicht
   reparierbare Promotionsevidence.
   Erst danach eine eindeutige `promotion_attempt_id` und einen neuen Rawroot
   anlegen, Collector starten und Sequenz 0 schreiben. Jede Probe bindet
   Attempt-ID, Release-/Surface-/Envelope-/Authorization-Digest, Activation-
   Generation/Head und T0. Der Activation-Single-Writer erwirbt unmittelbar vor
   Consumption einen monoton gefenceten `promotion_commit_fence`; QAuth-
   Admission kann darunter nichts neu akzeptieren und jeder Security-Event-
   Pfad serialisiert seinen persistenten HOLD-Latch gegen denselben
   owner-separierten CAS-State. Danach führt der Writer in dieser kritischen
   Sektion einen CAS-Commit-Guard aus und
   bindet alle gelesenen Werte in den Journalrecord: Journal-/Anchor-Generation,
   0 aktive/queued Jobs, QAuth `0 accepted/armed/started`, Joint-Seal, beide
   Q1b-Heads/`sealed`, aktuellen `q1b-security-state.v1`-Snapshotdigest samt
   Contract/Series/Version/externem Anchor-Head, bestandenen Component-Proofs
   und Live-Successor, aktuelle Trust-/
   Revocation-Zustände aller
   sieben Component-Signer plus Security-State-Anchor-Writer, gültige Release-
   Autorisierung/Envelope, frische
   Rights sowie Collector-Sequenz-0/Attemptbindung. Jeder CAS- oder Prädikat-
   Drift terminalisiert den Attempt **vor** Consumption; keine Transition.
   Ein direkt nach dem Commit linearisiertes Violation-Event wechselt vor jedem
   weiteren Produktstart append-only nach `hold`; der Enforcer prüft den CAS-
   State je Start, sodass kein Provisional-Fenster nutzbar ist.
   Nur bei identischen Werten Release-Autorisierung und Envelope genau einmal
   konsumieren und Consumption plus Transition
   `qualification_only -> production_provisional` in **einem** Journalrecord
   atomar committen; alle unbenutzten `pending` QAuth-Tickets werden darin
   terminal `closed_by_promotion`. Alte Generationen/Nonces bleiben
   verbraucht. In Productionzuständen kann kein QAuth-Ticket starten oder
   resümieren. Fault-Injection für Event, Writer-/Anchor-Ausfall, Signer-Key-
   Revoke und QAuth-Accept exakt nach Prepared und vor Commit sowie Race-Tests
   unmittelbar vor/nach Commit beweisen dies.
5. Nach dem Commit einen kleinen normalen Cold-Canary über einen tatsächlich
   `released`-Entry starten und negative Routen erneut beobachten. Scheitert
   dieser asynchrone Post-Commit-Test, wird append-only nach `hold` gewechselt
   und der Bootstrap-/Rollbackvertrag ausgeführt; die bereits konsumierte
   Release-Autorisierung wird weder zurückgedreht noch erneut verwendet. Die
   Recovery-Tabelle ist strikt:
   - Fehler **vor** Consumption/Transition: Attempt signiert terminalisieren;
     nur wenn die unverbrauchte Authorization/Envelope weiterhin frisch und
     gültig sind, darf ein neuer Prepared-Versuch mit neuer Attempt-ID, neuem
     Rawroot und neuer Sequenz 0 beginnen.
   - Jeder Fehler **nach** Commit: `hold`, kein Retry derselben Generation.
     Erst `supersede_release_generation`, frische Rights, neue Mode-
     Autorisierung, neue betroffene QAuth-/R3-Evidence, neue Release-
     Authorization und neuer Audit-Envelope dürfen einen neuen Lifecycle
     eröffnen. Ändert sich Code, Lock, Surface oder Policy, geht es zusätzlich
     über F0-build/F0-Freeze zurück.
   Kein Versuch übernimmt Probes eines alten Attempts. Fault-Injection direkt
   vor und nach Consumption/Transition beweist beide Zweige. Zusätzliche
   Crash-/Snapshot-Restore-/Anchor-Divergenz- und Signer-Key-Revoke-Tests
   zwischen abgeschlossenem Q2 und P4 beweisen, dass keine Teilkette oder
   veraltete Trust-Entscheidung zur Promotion gelangt.
6. Nur bei `production_overall=go` ist diese provisorische Promotion zulässig.
   Bei zusätzlich grünem Qualitätsaudit lautet der Status bis O7 ausschließlich
   `sota_qualified_pending_observation`; eine öffentliche oder abschließende
   SOTA-10/10-Bezeichnung ist noch verboten. Der Enforcer prüft den
   signierten Rights-/Revocation-Snapshot samt `checked_at`, Quelle,
   monotoner Version und `max_age` bei Queue-Accept, unmittelbar vor Start,
   an sicheren Segmentgrenzen und vor Outputfreigabe; stale oder unerreichbar
   ist `hold`, nicht nur bei P4.
7. Der schema-validierte `ltx-studio-post-promotion-observation.v1` wird aus
   den fortlaufend signierten Raw-Records rekonstruiert. Er bindet Monitoring-
   Signer/Role, eindeutige `promotion_attempt_id`, Release-/Surface-/Envelope-/
   Authorization-/Activation-Head-Digests, T0, Trusted-Key-Policy, Boot-ID,
   `q1b-joint-seal.v1`, beide exakten Q1b-Registry-/Anchor-Heads und je Probe
   den neuesten `q1b-security-state.v1`-Snapshotdigest/externen Anchor-Head samt beobachteten
   Ledger-Cursor/Sequence, Ledger-/Anchor-Head,
   frischen Coverage-/Health-Checkpoint, Interlock-Unit-/Health-/Latch-Version,
   Nullzähler sowie Trust-/Revocation aller sieben Component-Rollen plus
   Security-State-Anchor-Writer. Zusätzlich bindet
   sie Collector-Unit-/Key-/Trust-Policy-, read-only Mount-/Source-/IPC-/Policy-
   Digests, aktuellen live trusted/not-revoked Status des **separaten**
   Monitoring-Keys und alle beobachteten Head-Versionen, monotone und Wall-Clock-Zeit,
   lückenlose Sequenznummern, erwartete und tatsächliche Probeanzahl sowie
   Raw-Log-Digest; fehlende oder nachträglich eingefügte Probes sind Fail.
   Checkpoints bei +24 h und +7 Tagen verlangen minütliche Health-Probes,
   mindestens 99,9 % erfolgreiche Probes, kein zusammenhängender Ausfall über
   5 Minuten, 0 Digest-/Manifestdrift, 0 verlorene/orphaned/duplizierte Jobs,
   0 ungebundene Outputs, 0 fremde Serviceaktionen sowie frische Rights-/Key-
   und Revocation-Prüfung nach derselben Freshness-Policy. Jede Minute muss
   zusätzlich Joint-Seal/Heads exakt, Ledger-Cursor lückenlos, Coverage/Health
   frisch, Interlock verfügbar, Latch unset und beide Violation-Zähler null
   sowie Collector-Unit/Key/Policy aktuell trusted/not-revoked sein; Missing,
   Gap, Event, stale/unavailable oder Key-Revoke ist Fail.
8. Der +24-h-Finalizer prüft die Rohkette und konsumiert seinen Checkpoint
   genau einmal für `production_provisional -> production_stable`. Der
   +7-Tage-Finalizer ändert den Produktzustand nicht, eröffnet aber bei
   zusätzlich `sota_overall=go` separat `sota_marketing_authorized` und
   schließt erst dann den Masterplan. O24/O7 akzeptieren exakt eine lückenlose
   committed Attempt-Kette, in der **jede** Probe auch die Seal-/Ledger-/
   Interlock-Invariante erfüllt. Beide Finalizer revalidieren zusätzlich den
   Monitoring-Key und dessen Unit-/Policy-Digests live zum Entscheidungszeitpunkt;
   revoke/untrusted invalidiert die Kette. Jedes gerissene Oracle löst den vorab gebundenen Alarm und den
   Transition nach `hold` beziehungsweise `rolled_back` aus.
9. `sota_marketing_authorized` ist kein zeitloses O7-Bit. Jede Auflösung ist ein
   signiertes, versioniertes `sota-claim-resolution.v1` mit Release/Generation,
   O7-Digest, aktuellem Composite-/externem State-Anchor-Head, allen Source-
   Heads, Resolver-Unit-/Key-/Policy-Digest, live Trust/Revocation des separaten
   Resolver-Keys, `issued_at`, `max_age`, monotoner Sequence, `prev_hash` und
   Entscheidung. Der Marketing-State-Writer führt dafür eine append-only,
   extern verankerte höchste Resolution-Sequence/Head; API/UI akzeptieren nur
   die aktuelle signatur-/trustgeprüfte höchste Entscheidung. Stale,
   unavailable, revoked, Out-of-order oder Replay liefert sofort HOLD und der
   Writer schreibt append-only `auto_hold`; eine alte GO-Entscheidung kann nie
   wieder publiziert werden. Der öffentliche Claim-Resolver liefert GO nur, wenn O7 gültig **und** der aktuelle Zustand
   `production_stable`, Release/Surface exakt aktiv, Journal/Anchor konsistent,
   Joint-Seal und beide Q1b-Heads exakt, `q1b-security-state.v1` live nach der
   gebundenen Successor-Regel grün,
   Same-Series-Rights frisch sowie Trust-/Key-/Revocation-Policy aller sieben
   Component-Rollen plus Security-State-Anchor-Writer gültig sind. Jede spätere Staleness, Rights-/Key-Revocation,
   Seal-/Head-/Ledger-/Cursorabweichung, Gap, Event, Interlock-Ausfall/Latch,
   `hold`/`rolled_back` oder Releasewechsel schreibt append-only
   `sota_marketing_hold` beziehungsweise `sota_marketing_revoked`; Status-API
   und UI fallen sofort fail-closed zurück. Re-Autorisierung erfordert einen
   neuen vollständig gültigen Lifecycle, nie das Wiederanzeigen des alten O7-
   Records. Resolver und Collector lesen dabei direkt aus ihren digestgebundenen
   read-only Roots und authentisiertem Interlock-IPC; App/API/Marketing-Writer
   sind keine Quelle. Tests decken vor P4, nach P4/vor O24, zwischen O24/O7 und
   nach O7 jeweils Collector-/Resolver-Key-Revoke, Resolver-Crash zwischen
   Entscheidung/Publish, Marketing-Writer-Race, Replay/Out-of-order einer alten
   GO-Entscheidung, Read-Denial, Partial-Read, stale Cache, Root-Swap, App-Spoof,
   IPC-MITM/Replay, Resolver-Ausfall, Seal-Event, Source-Gap, Event-/Anchor-/
   Interlock-Ausfall, Latch, Key-Revoke, Snapshot-Stale, Keyrotation, Rollback
   und Release-Supersede ab.
10. Vor Rollback: neue Starts sperren, Queue/Worker drainen, Zielrelease samt
   aktuellen Rechten prüfen und alle seit Promotion bestätigten Writes aus
   dem Journal sichern. Niemals ein altes Backup über neue Daten kopieren.
   Das Ziel muss selbst den attestierten Enforcer-/Activation-Vertrag tragen;
   ein Legacy-Digest ist nie zulässig. Entweder wird innerhalb des bewiesenen
   Schemafensters mit RPO 0/RTO 30 min
   zurückgeschaltet und das Journal replayed, oder der Dienst bleibt im
   `forward-only-recovery`-HOLD. Danach müssen Projekt-Hashketten,
   Job-/Output-Provenienz und Rechte erneut grün sein. Kein Rollback reaktiviert
   alte Autorisierungen oder Tokens.

Exit P4: reproduzierbarer Finaldigest, Cold-Canary aus installiertem Release,
signierter Audit-Envelope und getesteter Rollback; Promotion zunächst
`provisional`, SOTA-Status höchstens `sota_qualified_pending_observation`.
Exit Masterplan: signierter +7-Tage-Beobachtungsreport grün und
`sota_marketing_authorized`.
Keine Worktree-Runtime.

Aufwand: 2–3 Tage plus Beobachtungsfenster.

## 5. Parallelisierung ohne Evidenzverlust

Diese Kurzfassung leitet sich ausschließlich aus der DAG in Abschnitt 3 ab:

- Nach M2 dürfen R1e, G0a-Rechteauflösung und D0s parallel beginnen; G0u
  folgt G0a, R0c folgt R1e, damit sein Code-/Contractdigest die fertige
  Startlogik bindet.
  Nach R1e darf der Betreiber unabhängig den Q2-runtime-sandbox-Vertrag
  implementieren; sein Exit blockiert F0-Freeze, nicht frühe CPU-Arbeit.
- Nach R1e, G0a und R0c darf R1a bauen; nach R1a dürfen R2, G0b-Attest und
  saubere Comparator-/VBench-Provisionierung parallel laufen.
- D0a-Design darf erst nach D0s reale Daten vorsehen; anwendbare
  Evaluatorrechte
  aus G0b müssen vor der betreffenden Messung grün sein. Vor jedem
  Studio-gestützten D0a-/D1-/Q0-/Q1b-Lauf muss der Qualification-
  Autorisierer den passenden zweckgebundenen QAuth-Registry-Record signieren;
  eine Phasen-Autorisierung ist nicht auf eine andere Phase übertragbar.
- R1b und jede Candidate-GPU-Arbeit warten auf R1a, R2, G0b und den zentralen
  serverseitigen Start-Enforcer. R1b aktiviert nur den Modus; QAuth-R0lR3 ist
  ein eigener nachgelagerter Knoten vor R0l/R3.
- Q1a-Prepare darf nach G0b Landschaft und Installation schließen; erst
  ExtTicket-Q1a erlaubt die synthetischen Ressourcenprofile und den
  ergebnisunabhängigen Q1a-Freeze. Q0 und Q1b verwenden
  ausschließlich Kalibrierdaten und warten auf D1-Run sowie jeweils ihre
  eigene erst danach signierte QAuth/Quality-Run-Tickets.
- F0 ist selbst eine feste Sub-DAG: `F0-build/R2-final` -> exakter
  Q1b/F0-Digest-Fixpunkt; erst dann zusammen mit aktuellem G0u-Exit ->
  `G0b-final` -> `R1b-final-mode` -> `QAuth-final` -> `Final-R0l/R3` ->
  `F0-Freeze/EvalAuth`.
  Q2 wartet auf den letzten dieser Knoten;
  P4 wartet auf Q2; der Planabschluss wartet auf O24 und O7.

## 6. Invalidation und Change Control

Die Invalidierungsmatrix des SOTA-Plans gilt unverändert. Zusätzlich:

| Änderung | mindestens neu |
| --- | --- |
| Upstream-Merge, Dub-It-Port oder Transformer-/Torch-Update | M2, R1, R2, R3 und alle digestgebundenen Folgebelege |
| Security-Pin, Dependency-Lock oder Modellladepolicy | M2, R1 und alle digest-/runtimefingerprintgebundenen Folgebelege einschließlich D1–Q2; keine Ausnahme wegen vermeintlich identischem Output |
| Service-Unit/Deploymentpfad | R1-Health, Rollback und Cold-Canary |
| Activation-Journal-/Writer-/Anchor-Code oder Trust-Policy | R1e, R1 und alle Mode-/QAuth-/Promotionbelege; Generationen nie übertragen |
| Qualification-Supervisor oder externe Comparator-Ticket-/Registry-Policy | R1e beziehungsweise Q1a und alle betroffenen Qualification-/Q1-/F0-/Q2-Belege |
| `q1b-security-state.v1`, Security-Ledger-/Interlock-Unit, IPC, Policy, Key, Anchor, Health-SLO oder Collector-/Resolver-Source-Mount | R1e/R1a, Q1b-Seal-Security und alle F0-/Q2-/P4-/O24-/O7-Belege; nach Freeze neuer F0/disjunkter Holdout, nach Promotion HOLD/neuer Lifecycle |
| Monitoring-/Resolver-Unit/Key/Trust/Freshness, `sota-claim-resolution.v1` oder Resolution-Anchor | R1a/P4 und alle O24-/O7-/Marketingbelege; nach Promotion sofort HOLD bis neuer gültiger Lifecycle |
| Q1b-Joint-Seal/Quiescence-Schema oder Versuch neuer Q1-Arbeit nach Seal | neue höhere Q1b-Generation/Roots, kompletter Q1b-Seal und F0; versiegelten Head nie öffnen |
| `q1b_seal_violation`, Security-Ledger-Source-Gap/Unavailable/HOLD-Latch, Anchor-Divergenz oder Prefix-Restore | sofort Security-HOLD, Credential-/Host-Incident; betroffene Generation dauerhaft unbrauchbar, neue Q1b-Generation/Roots und F0; nach Holdoutöffnung kein Retry desselben Holdouts |
| F0-Release-Digest ungleich Q1b-Release-Digest | aktuelle Revision `hold`; Ursache und alle betroffenen D1/Q0-Belege schließen, mindestens G0b/R1b/QAuth-/ExtTicket-Q1b/Q1b-Seal auf neuem Digest, danach F0-Rebuild bis exakter Fixpunkt |
| Rights-Updater-Unit/Policy/Allowlist/Trust/Anchor/Transport | G0u, G0b, alle digestgebundenen Mode-/Runbelege, F0/EvalAuth und Q2; nach Freeze neuer F0 plus disjunkter Holdout, nach Öffnung kein Retry |
| Q2-Runner, Consumer-ID, Evaluation-Root- oder Admission-Policy | R1e, F0 und Q2; nach Holdoutöffnung neuer disjunkter Holdout |
| Shortcut-/reine UI-Änderung vor F0 | Studio/E2E, R1/R2; danach neuer Finaldigest |
| Rechte-Evidence/SBOM statisch | R1 und alles nachgelagerte |
| neues zeitvariables Attest/neue Series bei identischer statischer Evidence, kein Same-Series-Successor | G0b, F0/EvalAuth, Q2/P4 gemäß Policy; kein Inhaltsdigestwechsel, aber neue Autorisierungsbindung |
| nur monoton frischer Snapshot derselben Attestation-Series bei identischer Policy/Evidence und unverändertem Updatervertrag | nur Freshness-/Head-Rechecks gemäß gebundener Successor-Policy; kein Inhaltsdigest-, F0-, EvalAuth- oder Q2-Wechsel |

Eine Kombination mehrerer Änderungen invalidiert die Vereinigungsmenge. Kein
Bericht wird durch Umbenennen auf einen neuen Digest „übertragen“.

## 7. Rollen und benötigte Autorität

| Rolle | Verantwortung | darf nicht ersetzt werden durch |
| --- | --- | --- |
| Engineering | M0–M2, R0–R3-Code, Builds, technische Reports | eigene Produktfreigabe |
| DGX-Betreiber | Servicewechsel, Wartungsfenster, erlaubte GPU-Canaries | App-seitigen Selbst-Reclaim |
| Rights-Verantwortlicher | Lizenz-/Daten-/Biometrieprüfung und Attest | README-Annahme oder Modellkarten-Kurztext |
| Rights-Snapshot-Updater | holt/verifiziert/publiziert monotone Same-Series-Snapshots aus enger Allowlist | App-/Renderer-UID oder manueller Dateikopierer |
| Rights-Snapshot-Anchor-Writer | verankert höchste Series/Version/Snapshot-/Fetchlog-Heads owner-separiert | Updater-, App- oder Rights-Consumer-UID |
| Qualification-Autorisierer | signiert Mode-Aktivierung und getrennte enge Registry-Runs für R0l/R3, D0a/D1/Q0/Q1b und Final-R0l/R3 | Rights-Signer, Engineering-Code oder allgemeines UI-Token |
| Qualification-Supervisor | erzwingt monotone Deadlines cgroup-weit unabhängig von Worker-Heartbeats | App-Worker oder fachlicher Runner |
| Activation-Journal-Writer | signiert Records und verankert jede höchste Generation/Head separat | App-, Engineering-, Rights- oder Qualification-Identität |
| Comparator-Run-Autorisierer | mintet/signiert qualitätsblind die vollständig eingefrorene externe Q1a-/Q1b-Ticketliste | Registry-Writer, Qualitätsauswerter, Comparator-Prozess oder Studio-QAuth |
| Comparator-Registry-Writer | darf signierte Tickets nur registrieren/konsumieren/terminalisieren und Head verankern | Tickets minten/ändern, Autorisierer oder Qualitätsauswerter |
| Q1b-Seal-Writer | koordiniert beide Generationen `open -> sealing -> sealed` und verankert Joint-Seal | beide Registry-Writer, Qualitätsauswerter oder App |
| Q1b-Quiescence-/Security-State-Finalizer | attestiert beide terminalen Ticketsets und signiert monotone Composite-Snapshots aus ausschließlich autoritativen read-only Quellen mit eigener Key-ID | Quality-Auswerter, Registry-/Security-Component-Writer oder App |
| Q1b-Security-State-Anchor-Writer | verankert jeden höchsten Composite-`{series,version,digest}`-Head extern und owner-separiert | Security-State-Finalizer, Component-Writer, App oder Engineering |
| Q1b-Security-Event-Writer | schreibt abgewiesene Post-Seal-Admit-/Appendversuche signiert in das separat verankerte Security-Ledger | Seal-/Registry-Writer, App oder Engineering |
| Q1b-Security-Ledger-Anchor-Writer | verankert jeden Security-Ledger-Head und Coverage-Cursor owner-separiert | Security-Event-, Seal- oder Registry-Writer |
| Q1b-Security-Interlock-Writer | besitzt als eigene UID/Key/Unit nur set-only-CAS auf den monoton verankerten HOLD-Latch; überwacht Event-/Anchor-Acks | Clear/Overwrite, Activation-/Event-/Anchor-/Seal-/Registry-Writer oder App |
| Incident-Closure-Signer | attestiert nach Credential-Revoke und Host-Runbook unabhängig den Incidentabschluss; darf die betroffene Seal-Generation nicht wieder öffnen | Security-Event-, Seal- oder Registry-Writer |
| unabhängiger Build-Verifier | attestiert exakte Q1b-/F0-Release-Digestgleichheit aus beiden Clean-Builds | Packaging-Ausnahme oder derselbe unreviewte Buildprozess allein |
| Data Custodian | Split, ACL, Leakage-Graph, Holdoutversiegelung | Entwickleraccount |
| unabhängiger Evaluator/Writer | F0-Autorisierung, Q2-Consumption/MOS | Tune-/Kalibrierrolle |
| Release-Autorisierer | signiert erst nach Evidence-Paket | Evidence-Collector selbst |
| Monitoring-Signer/Collector | liest autoritative read-only Roots/Interlock-IPC und schreibt fortlaufende O24/O7-Rawrecords mit eigener live geprüfter Systemidentität | nachträglicher Summary-Ersteller, App/API oder Finalizer |
| Marketing-Claim-Resolver | liest dieselben autoritativen Roots/IPC unter eigener live geprüfter UID/Unit/Key und signiert frische sequenzierte Resolutionen | App-/Status-API, Marketing-Writer oder alter O7-Record |
| Marketing-State-Writer | verifiziert/publiziert nur höchste frische Resolverentscheidung append-only und verankert Resolution-Sequence/Head | Resolverinputs liefern, Quellen ändern, alte GO-Replays oder selbst grün entscheiden |
| Q2-Runner | führt nur F0-gebundene Evaluation unter eigener UID/Consumer-ID und Orchestrator-Admission aus | Produkt-API, QAuth-Registry oder Engineering-Account |

## 8. Meilensteine, Aufwand und Kalenderunsicherheit

| Meilenstein | Inhalt | vorläufiger Engineering-Aufwand | nicht enthaltene Warte-/Laufzeit |
| --- | --- | --- | --- |
| MS1 – gesicherte moderne Baseline | M0–M2 | 5–10 Personentage | Review-/CI-Kapazität |
| MS2 – gestaged und qualifizierbar | R1e, R0c, G0a, R1a/R2, G0b, R1b, QAuth-R0lR3, R0l/R3 | bis R1e-Design-Spike `unestimated`; danach P50/P90 | Rights, Operatorfenster, DGX-Queue |
| MS3 – messbereit | D0s, D0a, D0, D1 | 8–20 Personentage | Datenakquise, Einwilligung, Annotation, unabhängige Rollen |
| MS4 – finaler Kandidat | Q0, Q1a/Q1b, Q2-runtime-sandbox, Feedback, final R1a–R3, F0 | 6–15 Personentage plus Sandbox-Blocker | Comparator-Downloads, Orchestrator-/Device-Isolation, GPU-Läufe, erneute Rechte |
| MS5 – unabhängige Entscheidung | Q2, P4, O24, O7 | 3–8 Personentage | Holdout-GPU-Zeit, MOS-Panel, mindestens 7 Tage Beobachtung |

Personentage sind nicht Kalenderzeit. Die frühere Größenordnung von 300–400
DGX-Stunden entspricht bereits 12,5–16,7 Tagen exklusiver Vollauslastung und
enthält weder Admission-/Queue-Wartezeit noch MOS oder Rechteklärung. Nach
D0a-Power, drei kalten Profilen pro Comparator und gemessener Queue-Kapazität
wird ein neuer Ressourcen-/Terminbericht mit getrennten P50-/P90-Werten für
Compute, Queue, Annotation und Review erstellt. Bis dahin gibt es keinen
belastbaren Endtermin. Der R1e-Design-Spike muss zusätzlich vor jeder MS2-
Bandbreite abgeschlossen sein; bekannte Restpakete werden separat geschätzt
und nicht mit einer erfundenen R1e-Dauer zu einer Gesamtsumme addiert.

## 9. Stop-/Go-Regeln

Sofort stoppen und zurückschleifen bei:

- schmutzigem Worktree während eines GPU-Laufs;
- nicht leerer aktiver Jobmenge vor Releasewechsel;
- jeder Advisory mit `unknown`, fehlender Entscheidung oder abgelaufener
  Risk-Acceptance;
- Rights-Status `pending`, abgelaufen oder widerrufen;
- stale/unerreichbarem Rights-/Revocation-Snapshot oder Journal-/Anchor-
  Headabweichung;
- jedem `q1b_seal_violation`, unresolved Seal-Incident, Security-Ledger-
  unavailable/stale/Source-Gap/HOLD-Latch, ungültigem Component-Proof,
  Security-State-Anchor-/Hashchain-/Prefix-Drift;
- stale/untrusted/revoked Collector-/Resolver-Key oder Resolution-Replay/
  Out-of-order/Anchor-Drift;
- Live-Aktivierung oder Candidate-Jobstart vor G0b/R1b;
- Import oder Verarbeitung realer Pilot-/Biometriedaten vor D0s;
- Digest-/Manifest-/Sidecarabweichung;
- Post-Freeze-Änderung;
- überschrittener `start_by`/`complete_by`, Ticket-/GPU-/Outputbudget oder
  Versuch, ein Qualification-Ticket phasen-/releaseübergreifend zu verwenden;
- Zugriff auf Holdoutergebnisse außerhalb der Q2-Transaktion;
- fremdem Service-Stopp oder Orchestrator-State-Manipulation;
- Cross-Shot-Identitätsgewinn bei gerissener Schärfe/Artefakt/AV-Grenze;
- Comparator-Ausschluss aufgrund seines Qualitätsresultats.

## 10. Completion-Matrix

| Anforderung | autoritativer Beleg | fertig, wenn |
| --- | --- | --- |
| Remote-Sicherung | getrennte Remote-Refs plus Baseline-JSON | `pre_plan_baseline`, `reviewed_plan_source_commit` und folgender `m0_evidence_commit` eindeutig erreichbar; Feature-Tracking zeigt auf Evidence-Commit |
| Upstream | Inventar, Konfliktledger, Integrationsreport plus vollständige M2-Tests | 1.2.0/Dub-It portiert, jeder lokale Vertrag disponiert und bewiesen |
| Security | Lock, SBOM, normalisierter Audit, Egress-Negativtest | jede Advisory entschieden, Unknown fail-closed, öffentlicher Egress blockiert |
| Tests | CI-/lokale Reports | alle Pflichtsuiten grün |
| Stage | R1a-Manifest/Health | Doppelbuild identisch, Livepfad unverändert |
| Qualification-Live | G0b-Attest, R1b-Start-Enforcer, QAuth-Registry, Supervisor, Health, `current`, Provenienz | gleicher Digest überall; normale Starts gesperrt, nur zweckgebundene signierte Tickets; hängende Prozess-cgroups deadlinefest beendet; Rights- und Qualification-Signer getrennt |
| Activation-Integrität | signiertes Journal, externer Head-Anchor, Restore-/Crash-Report | höchste Generation stimmt dreifach; Prefix-Rollback/fehlender Anchor führt zu `hold`; App/Engineering ohne Resetrechte |
| Scheduler | R0-Live-Report | echte Vier-Action-Sequenz bestanden |
| Surface | schema-validierte Surface plus Rights-Attest | jeder veröffentlichte Eintrag erlaubt |
| Rights-Freshness | G0u-Unit/Allowlist/Trust, Updater-/Anchor-Writer-UIDs, append-only Fetchlog, lokaler read-only Snapshotroot, höchster Series/Version/Snapshot-/Fetchlog-Tuple-Head | monotone Same-Series-Updates im SLO; Prefix-/Restore-/Crash-Oracles grün; stale/missing/cross-series/Anchordrift fail-closed ohne App-Egress |
| Betrieb | R3-Matrix | Canaries, 20 Zyklen, 50 Jobs grün |
| Data-Security | D0s-Deny-/Key-/Audit-/Restore-Report | unabhängige, versiegelte Rollen vor realem Datenbyte |
| Daten | D0-Readiness und Leakage-Graph | reale Splits rechtsklar und disjunkt |
| Evaluatoren | Gate-Set-Digest plus kompletter D1-Report | exakt das dynamisch eingefrorene Set gedeckt; In-Domain-Pflichtgates grün |
| Cross-Shot | Q0 | scharf und nicht unterlegen |
| Comparator | Q1a-Profil-/Inclusion-Matrix, externe Ticket-Registry plus Q1b-Qualitätsreport | Exactly-once/ITT jedes Profils und Quality-Runs, ergebnisunabhängig eingeschlossen, fairer anwendbarer Anchor für Targets |
| Q1b-Seal-Security | proof-carrying `q1b-security-state.v1`, Component-Proofs, Hashchain, getrennter State-Anchor-Writer, Ledger-/Interlock-/Incident-Records | jeder Consumer verifiziert Components selbst; höchster Composite-Head verankert, Cursor/SLO/Latch/Zähler grün; Fabrication-/Fresh-replay-/Prefix-/Anchor-/Key-Substitution-Oracles fail-closed |
| Freeze | F0 | Q1b-Generationen irreversibel sealed, `canonical-build-input.v1` identisch, `q1b-final-release-equality.v1` exakt grün, signiert, Holdout ungeöffnet |
| Qualität | gebundener `q2-runner.v1`, Q2 plus Blind-MOS | nur Evaluation-Autorisierung/Orchestrator-Admission, alle Bypasstests grün und alle Target-Claims SOTA-qualified |
| Freigabe | finaler P4-Envelope | beide Overall-Achsen `go`, Promotion `provisional` |
| Beobachtung | attemptgebundener signierter `post-promotion-observation.v1` plus Collector-Source-Attest | genau eine committed Kette; jede Minutenprobe bindet Joint-Seal, beide Heads, aktuellen Composite-Digest und autoritative Mount-/IPC-Quellen; +24 h stabil und +7 Tage alle SLO-/Rollbackoracles grün |
| SOTA-Bezeichnung | O7-Finalizer plus verankertes `sota-claim-resolution.v1` | vor O7 höchstens pending; danach nur höchste frische signatur-/trustgeprüfte Resolution bei stable/active, exaktem Seal/Heads, grünem Composite, frischen Rights/Keys; stale/replay/revoked/unavailable stets hold/revoked |

## 11. Reviewstatus

Der Masterplan wurde in 15 adversarialen Runden auf Vollständigkeit,
Reihenfolge/DAG, Security, Rückrollbarkeit, Rechte/Freshness, Statistik/Power,
Holdout-Exactly-once, Comparator-Fairness, DGX-Admission und beweisbare
Exitkriterien geprüft. Frühere Runden wurden jeweils fail-closed nicht
freigegeben und ihre High-/Medium-Befunde in die nächste Fassung eingearbeitet.

**Runde 15: 0 High / 0 Medium / 0 relevante Low — freigegeben.**

Die Freigabe gilt für diese Durchführungs- und Abnahmespezifikation. Sie ist
keine Behauptung eines bereits erreichten SOTA-10/10-Produktstatus: Reale
Rights-/Qualification-Signaturen, Holdout-, O24- und O7-Evidenz müssen die hier
definierten Gates erst noch erfüllen.

## 12. Aktuelle Primärquellen

- LTX-2 Upstream: <https://github.com/Lightricks/LTX-2>
- Requests Releases: <https://github.com/psf/requests/releases>
- Transformers Security Policy:
  <https://github.com/huggingface/transformers/security>
- Transformers CVE-2026-4372:
  <https://github.com/advisories/GHSA-29pf-2h5f-8g72>
- PyPI-Metadaten: <https://pypi.org/>
- VBench: <https://github.com/Vchitect/VBench>
- Wan2.2: <https://github.com/Wan-Video/Wan2.2>
- MOVA: <https://github.com/OpenMOSS/MOVA>
