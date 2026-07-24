# LTX Studio 2.3: Umsetzungsplan

## Zielbild

LTX Studio soll die nativen LTX-2.3-Pipelines als lokale, DGX-konforme
Produktionsoberfläche zugänglich machen. Die Oberfläche führt von einer Idee zu
vergleichbaren Varianten, ohne Modellpfade, Frame-Arithmetik oder
Orchestrator-Details vorauszusetzen. Experten behalten vollständigen Zugriff auf
die nativen Parameter.

Der Browser bleibt loopback-only. Kein UI-Pfad darf fremde Anwendungen stoppen,
Modelle entladen oder Admission umgehen. LTX-Jobs durchlaufen weiterhin den
DGX-Orchestrator. Modell-Autodiscovery ist ausschließlich
lesend und auf konfigurierte Wurzeln begrenzt.

## Quellenbewertung

Das bereitgestellte LTX-2.3-Transkript ist ein Erfahrungsbericht zu ComfyUI und
keine technische Spezifikation. Übernommen werden belastbare Workflow-Erkenntnisse:

- 121 Frames bei 24 FPS entsprechen fünf Sekunden Modellzeit.
- Bild-zu-Video bietet bei Identität, Komposition und sichtbarer Schrift meist
  die bessere Ausgangskontrolle.
- Gute Prompts beschreiben Bild, Bewegung, Kamera und Audio gemeinsam.
- Lange Clips und hohe Auflösungen erhöhen Laufzeit, Speicherbedarf und
  Fehlversuchsrisiko.
- Varianten, konsistente Referenzen und eine reproduzierbare Seed-Verwaltung
  sind Kernbestandteile eines Produktionsworkflows.

Nicht ungeprüft übernommen werden 4K-, Laufzeit- oder Speicher-Versprechen einer
RTX 5090, externe Sponsor-Produkte und die ComfyUI-Eigenheit, Text-zu-Video mit
einem bedeutungslosen Bild zu starten.

## Aktueller Zustand und Lücken

1. Auflösung, Frames und FPS sind freie Zahlenfelder. Ungültige LTX-Werte werden
   erst bei der Validierung sichtbar; Dauer und Seitenverhältnis sind nicht als
   Produktionsentscheidungen modelliert.
2. Text- und Bild-zu-Video sind in einem gemeinsamen Modus verborgen. Ein Bild
   ist optional, aber die beabsichtigte Arbeitsweise ist nicht explizit.
3. Die native Gemma-Verbesserung ist vorhanden, strukturierte Prompt-Bausteine
   werden jedoch noch nicht lokal in eine vorab editierbare Fassung überführt.
4. Alle benötigten Modelle sind lokal vorhanden, müssen aber als absolute Pfade
   eingetragen werden. Das ist fehleranfällig und verdeckt Qualitäts-/RAM-Profile.
5. Jobhistorie kann nur betrachtet oder abgebrochen werden. Rerun, neuer Seed,
   Favoriten und Vergleich fehlen.
6. Admission erhält pauschal 64 GiB. Auflösung, Dauer, Checkpoint-Präzision und
   aktuelle geschützte Lanes werden nicht als Prognose erklärt.
7. Uploads sind nach einem Request nicht als Referenzbibliothek wiederverwendbar.
8. Ein Seed von `-1` wird in der UI als zufällig beschrieben, obwohl die meisten
   nativen Pipelines ihn direkt an `torch.Generator.manual_seed` reichen.

## Architekturentscheidungen

### 1. Generierungsvertrag

`GenerationRequest` erhält additive, strikt validierte Produktionsfelder:

- `sourceMode`: `text` oder `image`.
- `promptParts`: Motiv, Handlung, Umgebung, Kamera, Licht, Dialog,
  Geräusche/Ambiente und Musik.
- `longClipAcknowledged`: explizite Bestätigung für Clips über zehn Sekunden.
- `continuity`: optionale Serienkennung und Notiz zur Wiederverwendung von
  Figuren-, Stil- und Kameraentscheidungen.

Alte Browser- und Jobdaten werden beim Einlesen auf Defaults migriert. Der
Python-CLI-Vertrag bleibt unverändert; nur der finale `prompt`, Seed und die
bereits existierenden nativen Parameter werden übergeben.

### 2. Presets und Dauer

Presets setzen ausschließlich LTX-konforme Dimensionen:

| Preset | Breite x Höhe | Zweck |
| --- | --- | --- |
| Entwurf quer | 1280 x 704 | schneller Qualitätscheck |
| Produktion quer | 1536 x 1024 | bestehender Zwei-Stufen-Standard |
| Full HD quer | 1920 x 1088 | HQ-Ausgabe |
| Produktion vertikal | 1024 x 1536 | vertikaler Standard |
| Full HD vertikal | 1088 x 1920 | vertikale HQ-Ausgabe |
| Quadrat | 1024 x 1024 | Social/Produkt |

Dauer-Presets berechnen `frames = seconds * fps + 1` und runden auf `8k+1`.
Die angezeigte Dauer wird korrekt als `(frames - 1) / fps` berechnet. Fünf,
zehn und zwanzig Sekunden sind direkte Presets. Über zehn Sekunden erscheint
ein bestätigungspflichtiges Langclip-Gate; über zwanzig Sekunden eine deutlich
als experimentell markierte Warnung, aber kein unbelegtes technisches Verbot.

### 3. Prompt-Komposition

Die strukturierte Eingabe erzeugt sofort lokal eine deterministische Vorschau.
Der Befehl „Bausteine übernehmen“ setzt daraus lokal eine editierbare positive
Beschreibung zusammen und kann rückgängig gemacht werden. Die modellgestützte
Verbesserung erfolgt beim Pipeline-Start mit derselben Gemma-Instanz, die danach
die LTX-Konditionierung erzeugt. Der Editor ruft dafür kein separates Modell auf.

### 4. Modell-Autodiscovery

Der Server scannt nur `LTX_STUDIO_MODEL_ROOTS` (Standard:
`/home/moddy/LTX-2.3-max`) mit begrenzter Tiefe. Dateien werden nach expliziten
LTX-2.3-Namensmustern klassifiziert: Dev, FP8 Dev, Distilled, Spatial Upscaler,
Distilled LoRA, IC-LoRA und Gemma-Root. Größe und Lesbarkeit werden angezeigt.

Ein Menü wählt erkannte Modelle. Die empfohlene Auswahl berücksichtigt den
Pipeline-Typ und kennzeichnet FP8 als speicherschonend, nicht pauschal als
qualitativ gleichwertig. Absolute Pfade bleiben in „Erweitert“ editierbar.

### 5. Varianten und Vergleich

Jobs erhalten `favorite`, `variantOf` und eine serverseitig gemessene Laufzeit.
Rerun mit gleichem Seed und Variante mit einem kryptografisch erzeugten,
konkreten Seed erstellen neue Jobs mit kollisionsfreiem Ausgabedateinamen.
`-1` wird nicht länger als Zufallsprotokoll verwendet.

Bis zu zwei abgeschlossene Jobs können in einer unverschachtelten
Vergleichsansicht parallel abgespielt werden. Favoriten bleiben in der privaten
Jobdatei erhalten. Laufende oder fehlgeschlagene Jobs werden nicht als
vergleichbare Ausgabe angeboten.

### 6. Ressourcen und ETA

Eine gemeinsame, reine Schätzfunktion liefert:

- korrekte Videodauer,
- relative Arbeitsmenge aus Pixeln, Frames, Schritten und Pipeline-Stufen,
- konservative RAM-Spanne anhand Checkpoint-Präzision und Arbeitsmenge,
- Empfehlungen zu FP8, Preset und Langclip-Risiko.

Admission verwendet die konservative Obergrenze statt eines pauschalen Werts.
Die UI vergleicht sie mit dem aktuellen freien RAM. Orchestrator-Snapshotdaten
werden nur lesend eingeblendet, insbesondere geschützte Avatar-/Qwen-Lanes.

Eine ETA wird nur aus erfolgreich beendeten lokalen Jobs abgeleitet. Verwendet
wird der Median der normalisierten Laufzeiten passender Jobs. Ohne belastbare
Historie zeigt die UI „Noch keine Messwerte“ und erfindet keine RTX-5090-Zahl.

### 7. Referenzbibliothek und Kontinuität

Uploads werden atomar in einer privaten Metadatendatei registriert. Die API
liefert nur vorhandene Dateien unterhalb des Studio-Upload-Verzeichnisses aus.
Bild-Assets können mehreren Requests hinzugefügt werden, ohne neu hochzuladen.
Serienkennung, Kontinuitätsnotiz, Seed und Referenzen werden beim Laden eines
früheren Jobs übernommen.

Bei Dialog weist die Oberfläche darauf hin, dass native Stimmen zwischen
Varianten schwanken können. Für festes Audio verweist sie auf den vorhandenen
Audio-zu-Video-Modus, ohne eine nicht vorhandene Voice-Lock-Funktion zu
versprechen.

## Umsetzungsschritte und Abnahme

### Phase A: Verträge und Migration

- Zod-Schema, Defaults und Restore-Migration erweitern.
- Preset-, Seed-, Prompt- und Schätzfunktionen als reine Shared-Module anlegen.
- Unit-Tests für `8k+1`, Dauer, Migration, Langclip-Gate und Schätzgrenzen.
- Abnahme: alle acht Pipeline-Modi bleiben valide und CLI-Argumente unverändert.

### Phase B: Presets, T2V/I2V und Prompt

- Format-, Dauer- und Source-Mode-Steuerung implementieren.
- Bildpflicht nur für explizites I2V erzwingen.
- Strukturierte Promptfelder, lokale Übernahme und Undo ergänzen.
- Abnahme: Desktop/Mobil ohne Überlauf; 5/10/20 Sekunden ergeben
  121/241/481 Frames bei 24 FPS; Prompt-Bausteine verursachen keinen Modellaufruf.

### Phase C: Modelle

- Bounded Discovery, API-Typen, Auswahlmenüs, Status und Refresh implementieren.
- Leere Request-Pfade einmalig mit erkannten Empfehlungen befüllen.
- Abnahme: die aktuelle DGX-Installation erkennt Dev, FP8, Distilled,
  Spatial Upscaler, Distilled LoRA, IC-LoRAs und einen vollständigen Gemma-Root.

### Phase D: Produktion und Historie

- Rerun-/Varianten-API, konkrete Seeds, eindeutige Ausgaben und Favoriten.
- Vergleichsansicht und „Einstellungen laden“.
- Telemetrie und medianbasierte ETA.
- Abnahme: Persistenz über Serverneustart, keine Überschreibung bestehender
  Ausgaben, Vergleich nur mit vorhandenen fertigen Videos.

### Phase E: Ressourcen und Kontinuität

- Request-spezifische Admission-Schätzung und lesende Orchestratoranzeige.
- Langclip- und Voice-Hinweise.
- Persistente Referenzbibliothek und Kontinuitätsfelder.
- Abnahme: Avatar wird als geschützt/laufend angezeigt; keine UI-Aktion bietet
  Stop, Kill, Unload oder Reclaim an.

### Phase F: Qualitätsgates

- TypeScript-Build, ESLint, Vitest und Playwright auf Desktop/Mobil.
- API-Sicherheits- und Pfadtests, Persistenz-/Migrations- und Fehlerpfade.
- Visuelle Screenshots aller Hauptmodi, Tooltip-/Dialog-/Vergleichszustände.
- Review 1: Korrektheit, Datenmigration, Race Conditions, Sicherheit.
- Review 2: UX, Barrierefreiheit, responsive Layouts, verständliche Sprache.
- Review 3: DGX-Admission, Ressourcenwahrheit, Prozess- und Eigentumsgrenzen.
- Alle High- und Medium-Befunde werden vor Abschluss korrigiert. Low-Befunde
  werden korrigiert oder mit begründeter Restgefahr dokumentiert.

## Definition of Done

Die Arbeit ist erst abgeschlossen, wenn jeder Punkt dieses Dokuments durch Code,
Tests und gerenderte Browserzustände belegt ist, keine offenen High-/Medium-
Reviewbefunde bestehen, der Produktionsserver auf `127.0.0.1:4318` die neue
Version ausliefert und ein finaler Audit bestätigt, dass weder Avatar noch eine
andere fremde DGX-Anwendung verändert wurde.
