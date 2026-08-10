# Warum der Showcase keinen Lipsync hatte — der Framing-Befund

*2026-08-07/08, Shot 04 des Showcase-Films als Prüffall*

## Der Befund in einem Satz

Der fehlende Lipsync war **kein Refiner-Problem, sondern ein Framing-Problem**:
Im „Closeup" ist das Gesicht rund 90 px hoch und der Mund keine 20 px breit.
Bei dieser Pixelmenge ist Lippensynchronität physikalisch nicht darstellbar,
und kein Refiner der Welt kann sie hineinrechnen.

## Die Messkette

`szene-04-a-closeup-20260807.mp4` — 1280×704, 129 Frames, Seed 1003:

| Messung | Wert | Bedeutung |
| --- | --- | --- |
| YuNet-Gesichtserkennung | **4 von 129 Frames (3 %)** | Der Detektor findet das Gesicht praktisch nie |
| MediaPipe-Gesichtsspur | 66 % | Findet es, aber zu klein für Geometrie |
| Median-Bildschärfe im Gesicht | 12–15 | Unter jedem Auswertungs-Schwellwert |
| Sprechdauer im Clip | 1,7 s von 5,16 s | Der Satz füllt ein Drittel des Shots |

Der Analysepfad meldet folgerichtig `insufficient` auf allen Lipsync-Stufen —
nicht weil die Messung versagt, sondern weil **im Bild nichts zu messen ist**.

## Warum das Referenzbild nicht half

Das gebundene Referenzbild (`1f5e3589…png`) ist ein sehr guter Closeup:
512×512, hell, scharf, Gesicht formatfüllend. Es hat den Bildausschnitt
trotzdem nicht bestimmt. Zwei Gründe wirken zusammen:

1. **Die Bildkonditionierung ist First-Frame-only.** Sie setzt Frame 0 und
   verliert danach die Kontrolle. Das ist exakt der Transient, den Moddy
   gesehen hat: „Vor jedem Turn taucht für 1–2 Sekunden das Ursprungsbild auf."
   Danach übernimmt der Prompt.
2. **Der Prompt beschrieb überwiegend die Umgebung.** Von sechs Prompt-Teilen
   widmeten sich vier der Werkstatt, dem Regen, der schwingenden Lampe und dem
   kalten Mondlicht. `close-up` stand als eines von mehreren Wörtern im
   Kamerateil. Das Modell hat geliefert, was dominierte: eine dunkle Halbtotale.

Dazu kam `strength: 0.7` — die Konditionierung wirkte nur zu 70 %.

## Was die Refiner tatsächlich taugen

Derselbe Shot, identischer Ton, identische Basis, drei Arme:

| Kennzahl | LTX pur | LatentSync | MuseTalk |
| --- | --- | --- | --- |
| Bilabial-Verschluss F1 | 0,286 | **0,286** | 0,143 |
| Mundöffnung-Korrelation | 0,492 | **0,553** | 0,433 |
| Mundbewegung in Sprechpausen | 0,394 | **0,200** | 0,242 |
| Identität (SFace cos) | 0,812 | **0,800** | 0,706 |
| Bildschärfe | 15,0 | **14,6** | 12,3 |

**LatentSync gewinnt klar:** bessere Mundöffnung, halbiertes Zappeln in den
Sprechpausen, und das für 0,012 Identitätsverlust. **MuseTalk fällt durch:**
halbierter Bilabialwert, 0,106 Identitätsverlust, sichtbar unschärfer.
MuseTalk ist als Arm erledigt.

Wichtig für die Einordnung: Beide Arme arbeiteten auf einem Bild, in dem der
Mund 20 px breit ist. Die Zahlen sagen etwas über die *relative* Schonung der
Verfahren, nicht über ihr Potenzial bei brauchbarem Framing.

## Zweitbefund: das Superman-Bild ist ein Gemälde

`/home/moddy/Downloads/Superman.png` (704×1056) zeigt Superman im Stil eines
Renaissance-Porträts: sichtbares Craquelé, Malschicht, Mona-Lisa-Landschaft im
Hintergrund. Das erklärt Moddys zweite Beobachtung — „zum Schluss werden die
Figuren zu Comicfiguren". Das Modell übernimmt den Malstil der Referenz und
driftet über den Clip immer weiter dorthin, weil nichts dagegenhält.

Gegenmaßnahme im Prompt, nicht am Bild: `photorealistic live-action film still`
positiv, `painting, illustration, canvas texture, brush strokes, oil painting,
cartoon` negativ. Zusätzlich ist der Kopf im Original nur 250 px von 1056 hoch
(19 %) — auch hier war das Framing gegen jeden Lipsync.

## Die Konsequenz für jeden Dialogshot

1. **Referenzbild im Zielformat vorbereiten**, nicht quadratisch einwerfen.
   Gesicht auf 45–55 % der Bildhöhe, Rest als weich auslaufender
   Bokeh-Hintergrund aus demselben Bild — dann ist Frame 0 bereits filmisch
   und der Transient fällt nicht mehr auf.
2. **Prompt auf das Gesicht ausrichten.** Umgebung auf einen unscharfen
   Halbsatz eindampfen, Kamera explizit als `extreme close-up, head and
   shoulders fill the frame, shallow depth of field`.
3. **`strength` auf 1,0.**
4. **Licht warm und hell aufs Gesicht.** „cold blue moonlight" und „hard
   shadows" haben die Auswertung zusätzlich blind gemacht.
5. **Erst dann LatentSync** — auf einem großen, hellen Mund hat der Refiner
   überhaupt etwas zu arbeiten.

## Der Gegentest — was das Framing tatsächlich bringt

`test-closeup-a-20260808.mp4`: identischer Satz, identischer Seed 1003,
identische Technik. Geändert wurden nur Referenzbild (jetzt 1280×704 mit
gesichtsfüllendem Ausschnitt), Prompt (Gesicht statt Werkstatt), Licht
(warm statt kaltblau) und `strength` (1,0 statt 0,7).

| Kennzahl | v1 | v2 | v2 + LatentSync |
| --- | --- | --- | --- |
| **AV-Versatz** | **360 ms** | **0 ms** | **0 ms** |
| Gesichtsspur | 0,664 | 1,000 | 1,000 |
| Bildschärfe | 15,0 | 25,8 | 21,6 |
| Sprechbewegung erkannt | 0,312 | 0,644 | 0,600 |
| Mundöffnung-Korrelation | 0,492 | 0,312 | 0,464 |
| Zappeln in Sprechpausen | 0,394 | 0,241 | 0,316 |

**Drei der vier gemeldeten Mängel sind damit erledigt:**

- *Anlauf-Transient weg.* Die ersten sechs Frames laufen durchgehend. Weil das
  Referenzbild jetzt im Zielformat mit Bokeh vorliegt, ist Frame 0 bereits ein
  gültiges Filmbild statt eines eingepassten Fremdkörpers.
- *Identitätsdrift weg.* Frame 0 bis 128 halten Gesichtszüge, Frisur und
  Kleidung; kein Abgleiten ins Comichafte.
- *Lipsync-Grundlage da.* Der Mund misst jetzt rund 150 px statt 20 px, mit
  klar unterscheidbaren Lippenformen von Frame zu Frame. Der AV-Versatz fiel
  von 360 ms auf null.

## Zwei Einschränkungen, die man kennen muss

**YuNet findet das Gesicht nicht mehr** — 0 von 129 Frames, weil es ihm nun zu
groß ist. Damit fällt die automatische Identitätsmessung (SFace setzt darauf
auf) für Closeups aus. Das ist ein Messproblem, kein Bildproblem: MediaPipe
findet 100 %. Identitätsdrift muss bei Closeups am Bild beurteilt werden.

**Der Bilabialwert steht in allen vier Messungen auf exakt 0,2857 = 2/7.** Der
Testsatz „Sag mir bitte, dass du das nicht angefasst hast" enthält zu wenige
Lippenschlusslaute für eine belastbare F1. Die Kennzahl sagt hier nichts über
den Refiner — sie braucht einen bilabialreichen Prüfsatz.

## LatentSync auf gutem Material

Anders als auf dem kaputten v1-Material ist die Bilanz gemischt: **+49 %
Mundöffnung-Korrelation**, dafür **−16 % Schärfe** und mehr Zappeln in den
Pausen. Auf v1 war LatentSync eindeutig besser, auf v2 ist es ein Handel.
Die Entscheidung fällt am fertigen Film, nicht an der Tabelle.

## Nebenbefund: der Reuse-Fix wirkt

LatentSync auf Shot 04 brauchte 16:27 min (Basis wurde noch neu gerendert,
Lauf war vor dem Fix eingereiht). MuseTalk danach: **53 Sekunden**, weil die
Basis übernommen wurde. Faktor 18. Für die acht Dialogshots des Films heißt
das 20 Minuten statt zwei Stunden.

**Offen:** Beim Gegentest griff der Reuse *nicht* — der LatentSync-Lauf meldete
wieder 58 GiB und brauchte 16:20 min, obwohl sich nur der Postprocess vom
Render unterschied. Der Unterschied zum gelungenen MuseTalk-Fall: Dort war die
Basis seit Stunden veröffentlicht, hier erst drei Minuten alt. Verdacht auf ein
Zeitfenster in der Registrierung der Output-Library. Noch nicht diagnostiziert;
für die sieben Dialogshots des Films geht es um rund zwei Stunden.

## Nachtrag 10.08.2026: Szenenreferenz löst die Weltnaht, aber nicht die Schärfe

Der spätere v3-Film widerlegte die zu frühe Aussage oben, der Anlauf-Transient
sei mit einem eingepassten externen Porträt generell erledigt. Je nach Seed
blieb der Sprung massiv: Bei v3-02 lag die größte benachbarte Bildänderung in
einer frisch reproduzierten Graustufenmessung beim 52-Fachen des Clip-Medians,
bei v3-08 beim 108-Fachen. Der gemeinsame Fehler war nicht nur das Seitenformat,
sondern die **andere Bildwelt** der Referenz: Studio beziehungsweise Gemälde
gegen nächtliche Industriehalle.

Der kontrollierte A/B-Test `scene-reference-ab-2026-08-10.json` hält Prompt,
Seed 3001, 129 Frames, 25 fps und 1280×704 konstant. Einziger beabsichtigter
Unterschied ist ein bei Stärke 1,0 gebundener Frame aus einem zuvor in derselben
Szene erzeugten Casting-Shot.

| Rohmessung | Ohne Referenz | Referenz aus der Szene |
| --- | ---: | ---: |
| Bildsprung Maximum / Median | 1,78× | **1,49×** |
| Identitätsabdeckung | nicht anwendbar | **100 %** |
| SFace Median / Minimum | — | **0,911 / 0,852** |
| Zeitliche Identitätskonsistenz | — | **0,988** |
| Nasengeschwindigkeit p95 | 1,667 | **0,432** |
| Mundhaut-Flussdeformation p95 | 0,448 | **0,227** |
| Öffnungskorrelation | 0,302 | **0,558** |
| Rundungskorrelation | 0,270 | **0,675** |
| Dialog-WER | **0 %** | **0 %** |
| Schärfe-Rohwert | **52,7** | 5,5 |

Damit ist die Produktentscheidung enger und belastbarer:

- Eine Referenz **aus derselben Szene** hält die Person messbar gebunden, ohne
  die harte Bildnaht externer Porträts wieder einzuführen.
- Der Test gibt **keine automatische Lip-Sync-Freigabe**: Der AV-Proxy enthält
  sich wegen geringer Konfidenz, und der Szenenreferenz-Arm unterschreitet die
  Schärfeschwelle deutlich.
- Der nächste Optimierungsschritt ist daher keine weitere Referenztheorie,
  sondern eine bessere Frame-Auswahl beziehungsweise ein schärferer Casting-
  Shot. Der sichtbare Frame muss in der App auswählbar sein, bevor weitere GPU-
  Varianten sinnvoll sind.

Die reproduzierbare Rohbilanz mit Artefakt-, Analyse- und Provenienz-Hashes
steht in `docs/evidence/scene-reference-ab-2026-08-10.json`.

### Qualitätsgeführte Frame-Auswahl

Die App bietet dafür jetzt zwei Wege: Der Operator kann den sichtbaren Frame
weiterhin exakt per Zeitpunkt übernehmen oder den gepinnten CPU-Selektor
verwenden. Dieser untersucht höchstens 48 Frames außerhalb der Anlauf- und
Endphase. Er bewertet nur nachvollziehbare Bildmerkmale: YuNet-Erkennung und
-Konfidenz, Gesichtsgröße, lokale Laplace-Schärfe, Belichtung, frontale
Fünf-Punkt-Geometrie, Bildzentrum, zweite prominente Gesichter und Änderung
zum direkten Nachbarframe. Auswahlskript, YuNet-Modell, Kandidatenwerte und
FFmpeg-Griff werden in der Asset-Herkunft gebunden.

Zwei CPU-Nachweise bestehen:

1. In einem absichtlich unscharf–scharf–unscharf codierten Vier-Sekunden-Clip
   wählt der Selektor `1,88 s` und damit den scharfen Mittelteil
   (`1,40–2,80 s`).
2. Beim tatsächlich verwendeten `casting-a.mp4` empfiehlt er `0,96 s` statt
   des manuellen Frames bei `1,60 s`. Die lokale Gesichtsschärfe steigt von
   `17,90` auf `22,02`, also um **23,0 %**, bei einem Gesicht und praktisch
   gleicher zeitlicher Stabilität.

Das beweist die bessere **Eingangswahl**, noch nicht die Schärfe des nächsten
LTX-Renders.

### Kontrollierter Gegenlauf: relative Auswahl reicht nicht

Der GPU-Gegenlauf `einzelshot-mit-auto-szenenreferenz-20260810.mp4` hielt
Prompt, Dialog, Seed 3001, 129 Frames, 25 fps, 1280×704 und alle
Modellparameter konstant. Nur der manuelle Frame bei `1,60 s` wurde durch den
automatisch gewählten Frame bei `0,96 s` ersetzt. Laufprovenienz und
Identitätsreferenz wurden nach der vollständigen Ausgabe verifiziert.

| Rohmessung | Manuell 1,60 s | Automatisch 0,96 s |
| --- | ---: | ---: |
| Bildsprung Maximum / Median | **1,49×** | 2,27× |
| Schärfe-Rohwert | **5,51** | 5,42 |
| SFace Median / Minimum | **0,911 / 0,852** | 0,889 / 0,738 |
| Nasengeschwindigkeit p95 | **0,432** | 0,845 |
| Mundhaut-Flussdeformation p95 | **0,227** | 0,322 |
| Öffnungskorrelation | **0,558** | 0,394 |
| Rundungskorrelation | **0,675** | 0,430 |
| Bilabial-F1 | **0,222** | 0,100 |
| Dialog-WER | **0 %** | **0 %** |

Der automatisch gewählte Quellframe war innerhalb des Casting-Clips zwar um
23 % schärfer, lag absolut aber nur bei `22,02`. Das ist kein ausreichend
gutes Referenzmaterial; die zweite Generation verstärkte die bereits vorhandene
Weichheit. Die Hypothese „bester Frame eines beliebig schlechten Clips genügt"
ist damit widerlegt.

Der Selektor enthält deshalb nun ein absolutes Fail-closed-Gate bei lokaler
Gesichtsschärfe `< 35`. `casting-a.mp4` wird mit der konkreten Abhilfe
„schärferes Ausgangsvideo oder Originalbild verwenden" abgelehnt. Die Grenze
trennt die kontrollierten schlechten Frames (`14,8–22,4`) von den beiden
hochwertigen Positivkontrollen (`84,7` und `85,6`). Ein real codierter,
durchgehend weichgezeichneter Negativclip ist Teil der Testsuite. Damit heißt
„automatisch" nicht mehr „das kleinste Übel auswählen", sondern enthält sich,
wenn die Eingangsbasis nachweislich ungeeignet ist.
