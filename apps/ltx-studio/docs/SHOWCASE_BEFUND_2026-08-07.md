# Showcase-Befund: was der Ein-Minuten-Film zeigt

Stand: 2026-08-07. Erster durchgehender Produktionsversuch — 62 Sekunden,
12 Shots, zwei Figuren, Dialog und Action. Zweck war nicht Abnahme, sondern
die Frage: **Was schafft der Stack heute wirklich?**

Material: `szene-master-60s-20260807.mp4`, Shots `szene-01…12-20260807.mp4`,
Rohdaten in `evidence/showcase-2026-08-07.jsonl`.

## Das Ergebnis in Zahlen

| | |
| --- | --- |
| Länge | 62,0 s (12 × 129 Frames @ 25 fps) |
| Auflösung | 1280×704 |
| Reine Renderzeit | 2 h 07 min |
| Pro Shot | 9,8–20,3 min, Median ~10 min |
| Wanduhr gesamt | 3 h 26 min |
| Fehlschläge | keine — 12/12 im ersten Versuch, alle provenienzverifiziert |

**Faustregel: rund zwei Minuten Rechenzeit pro Sekunde Film.**

Der Betrieb hat gehalten: Admission, Thermik-Gate und Provenienzprüfung liefen
über dreieinhalb Stunden unbeaufsichtigt durch. Das ist das Ergebnis der
Infrastrukturarbeit der Vortage und war vor einer Woche nicht möglich.

## Was gut ist

- **Bildsprache und Atmosphäre.** Der Establishing-Shot — Regenlicht,
  Spiegelungen auf nassem Beton, Kamerafahrt durch eine Tür — ist auf dem
  Niveau, das man von guten Beispielen kennt.
- **Kamera.** Push-in, Tracking und Whip-Pan werden aus der Beschreibung
  korrekt umgesetzt.
- **Stilauflösung.** Der Superman-Shot startet im Renaissance-Gemäldestil des
  Referenzbildes und löst sich innerhalb von zwei Sekunden in eine
  fotorealistische Industriehalle auf. Das war nicht geplant.

## Was nicht funktioniert — vier Befunde

### 1. Das Referenzbild steht am Shot-Anfang und springt dann weg

**Messung:** Die mittlere Frame-zu-Frame-Differenz springt in Shot 04 bei
Frame 3 von ~1,5 auf **48,6** — ein harter Bildwechsel.

**Ursache:** LTX-I2V konditioniert nicht auf ein abstraktes Identitätsmerkmal,
sondern hart auf **Frame 0**. Das Modell hält die Konditionierung und löst sie
dann per Sprung auf. Verstärkt wurde das durch ein 512×512-Porträt als
Referenz für einen 1280×704-Shot: Seitenverhältnis, Bildausschnitt und Pose
passen nicht zur Zielkomposition.

**Wichtig:** `id-lora` löst das **nicht** automatisch — auch dort ist die
Bildkonditionierung eine First-Frame-Konditionierung
(`ImageConditioningInput` mit `frame_index`).

### 2. Figuren werden zum Clipende comichaft

**Ursache:** zeitlicher Generationsdrift über die Clipdauer. Kein spezieller
129-Frame-Fehler (129 ist als `8n+1` formal korrekt), aber je länger die
Zeitachse, desto mehr Raum für Identitäts-, Textur- und Stilabweichung. Der
x2-Upscaler ist räumlich und erklärt einen nur zum Ende zunehmenden Fehler
nicht allein; der Stage-2-Pass kann vorhandenen Drift aber verstärken.

**Nicht genutzt:** Der Film lief komplett über `two-stage` — den 8-Schritt-Pfad.
Der Qualitätspfad `two-stage-hq` (`ltx_pipelines.ti2vid_two_stages_hq`, eigene
Distilled-LoRA-Stärken je Stufe) wurde nie getestet.

### 3. Es gibt keinen Lipsync

**Ursache: strukturell.** `two-stage` erzeugt Bild und Sprache **gemeinsam aus
dem Text**. Es gibt keine Konditionierung des Mundes auf eine Lautfolge — also
auch keine garantierte Wortzeit oder Lippenposition. Das deckt sich mit den
früheren Messungen: `bilabialClosureF1` zwischen 0 und 0,45, der klassische
AV-Korrelationspeak besteht das Nullmodell nicht.

Auch `id-lora` löst das nicht: Dessen Referenzaudio ist eine **Stimmprobe**
zum Klonen der Stimme, nicht die phonemgenaue Zielspur.

**Das ist die härteste Grenze des aktuellen Stacks** — und sie ist mit
Parametern nicht zu beheben.

### 4. Die Figuren driften von Shot zu Shot

Identischer Seed und wortgleicher Prompt sind **keine** Charakterbindung. Auch
eine bekannte Figur wie Superman ist für das Modell eine semantische Kategorie,
keine festgelegte Gesichtsgeometrie. Ohne persistente Charakterrepräsentation
bleibt jeder Shot eine eigene Ziehung.

## Plan

### Stufe 1 — sofort, ohne neues Modell (ein Nachmittag)

Erwartete Wirkung: behebt Befund 1 und 4 weitgehend, mildert 2. **Nicht 3.**

1. **Anlauf abschneiden.** 25–30 Frames mehr rendern und die ersten
   25–30 verwerfen. Kostet ~1 Minute Rechenzeit pro Shot und entfernt den
   sichtbaren Referenzbild-Transienten vollständig.
2. **Dialogshots auf `id-lora` umstellen.** Identity Guidance wirkt über den
   ganzen Clip (gemessene Identitätsähnlichkeit 0,867 Median) statt nur auf
   Frame 0. Pro Figur genau **eine kanonische Referenz** für alle Shots.
3. **Shots auf 97 Frames kürzen** (3,88 s statt 5,16 s) — weniger Zeitachse,
   weniger Drift, nebenbei ~25 % schneller.
4. **`two-stage-hq` gegen `two-stage` testen** an einem einzelnen Shot, bevor
   die ganze Serie darauf umgestellt wird.
5. **Referenzbilder shotgerecht vorbereiten:** 16:9, Zielausschnitt, Licht und
   Kleidung wie im gewünschten Shot — nicht ein quadratisches Porträt in ein
   Breitbild zwingen.
6. **Kein FLF2V als Charakter-Memory.** Letzter Frame → erster Frame erzeugt
   in einer Schnittfolge Morphing, Endpunkt-Kleben und schleppt Drift mit.
   Nur für echte Fortsetzungen oder Übergänge einsetzen.
7. **Beleuchtung hochziehen.** Die Vorgabe „Nacht, Mondlicht, harte Schatten"
   hat die Gesichter ins Dunkle gezogen; warmes Führungslicht direkt aufs
   Gesicht.

### Stufe 2 — Lipsync nur über ein zusätzliches Modell

Innerhalb von LTX ist Befund 3 nicht lösbar. Der einzige lokal lauffähige,
kostenlose Kandidat mit echter Zielaudio-Konditionierung ist
**Wan2.2-S2V-14B** (Apache 2.0):

- nimmt echte Audiodatei plus Referenzbild, 480p/720p
- Anforderungen `torch>=2.4` und `flash_attn`, **kein xformers** — passt zum
  vorhandenen Container (torch 2.10+cu130, flash-attn 2.7.4, ARM64)
- Wan-Infrastruktur ist bereits erprobt: `Wan2.1_VAE.pth` und
  `wav2vec2-base-960h` liegen lokal, der LipForcing-Container läuft auf
  NGC-ARM64-Basis
- Modellkarte nennt ≥80 GB GPU-Speicher; 121 GiB Unified Memory reichen
  kapazitiv voraussichtlich, die Geschwindigkeit ist offen

**Vorgehen:** erst ein 5–10-Sekunden-Smoke-Test bei 480p, ausgewertet mit
**demselben** Bilabial-/Nullmodelltest wie alle bisherigen Arme. Erst wenn er
besteht, lohnt die Migration der Dialogshots.

InfiniteTalk ist die zweite Wahl: technisch passend, aber hart auf
torch 2.4.1/CUDA 12.1 und xformers 0.0.28 ausgerichtet — ABI-Konflikt mit
unserem Container, auf ARM64 zusätzlich ein Source-Build. Nur in einem
getrennten Container, niemals durch Downgrade des funktionierenden Stacks.

### Realistisches Zielbild

Ein Hybrid, kein Einzelmodell:

- **LTX** für Establishing-, Action- und Nicht-Dialogshots — dort ist es stark
- **Wan2.2-S2V** mit echtem Zielaudio für einzelne 3–5-Sekunden-Dialogshots
- pro Figur dieselbe kanonische Referenz in allen Armen
- Dialog überwiegend als Schnitt/Gegenschnitt statt beide Figuren gleichzeitig
- Anlauftransienten durch Schnittgestaltung verbergen

**Ehrliche Erwartung:** „Eine Minute, zwei Figuren, wortgenauer Lipsync und
über alle Schnitte konsistente Identität" ist mit LTX-2.3 allein nicht
zuverlässig erreichbar. Mit Stufe 1 wird der Film deutlich besser — ruhiger
Einstieg, stabilere Figuren, weniger Drift —, aber die Lippen passen weiterhin
nicht zu den Worten. Das entscheidet Stufe 2.

## Beraterhinweis

Die Bewertung der vier Befunde wurde am 2026-08-07 gegen eine unabhängige
Zweitmeinung (Codex, gpt-5.6-sol, reasoning effort high) geprüft. Sie deckt
sich in allen vier Ursachenzuschreibungen und korrigierte die Annahme, dass
`id-lora` den First-Frame-Transienten löst.
