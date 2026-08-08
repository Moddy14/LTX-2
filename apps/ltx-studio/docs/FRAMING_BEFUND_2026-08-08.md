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
