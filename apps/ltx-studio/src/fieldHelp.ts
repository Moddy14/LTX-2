export const fieldHelp = {
  prompt:
    "Wofür: Beschreibt Inhalt und Gestaltung des Videos. Gute Eingabe: Motiv, Handlung, Umgebung, Kamera, Licht und gewünschten Ton in klaren Sätzen nennen.",
  enhancePrompt:
    "Wofür: Der ohnehin benötigte Gemma-Textencoder erweitert den positiven Prompt und verwendet bei Bild-zu-Video auch das Referenzbild. Danach erzeugt dieselbe Modellinstanz die LTX-Konditionierung. Empfehlung: Bei kurzen Ideen einschalten; bei exakt formulierten Prompts ausschalten.",
  negativePrompt:
    "Wofür: Nennt Bild- oder Audioeigenschaften, die vermieden werden sollen. Gute Eingabe: konkrete Begriffe wie Flimmern, Text, verzerrte Hände oder Rauschen; leer lassen, wenn keine Ausschlüsse nötig sind.",
  imagePath:
    "Wofür: Absoluter DGX-Pfad zum Referenzbild oder Keyframe. Gute Eingabe: eine vorhandene PNG-, JPEG- oder WebP-Datei, möglichst im Seitenverhältnis der Ausgabe.",
  imageUpload:
    "Wofür: Kopiert ein lokales Referenzbild in den geschützten Upload-Bereich des Studios. Gute Eingabe: PNG, JPEG oder WebP mit klaren Details und passendem Seitenverhältnis.",
  imageFrame:
    "Wofür: Legt fest, an welchem Ausgabeframe das Bild verankert wird. Empfehlung: erstes Bild 0; weitere Keyframes zeitlich aufsteigend und innerhalb der gesamten Framezahl setzen.",
  imageStrength:
    "Wofür: Bestimmt, wie strikt das Ergebnis dem Referenzbild folgt. Empfehlung: 1,0 für starke Bindung; 0,7 bis 0,9 für mehr gestalterische Freiheit.",
  imageCrf:
    "Wofür: Steuert die H.264-Vorverarbeitung des Referenzbildes; kleinere Werte erhalten mehr Details. Empfehlung: 33 als Standard, 18 bis 28 für detailkritische Vorlagen, 0 ohne Kompression.",
  mediaPath:
    "Wofür: Verwendet eine bereits auf dem DGX vorhandene Datei ohne Upload. Gute Eingabe: ein absoluter, lesbarer Pfad zur passenden Audio-, Video- oder Maskendatei.",
  audioUpload:
    "Wofür: Lädt eine Audiodatei als zeitliche und akustische Vorlage hoch. Gute Eingabe: für Lipsync zuerst saubere, sprachdominante Mono- oder Stereo-Sprache ohne Musikbett; Musik erst hinzufügen, wenn die Mundbewegung funktioniert.",
  videoUpload:
    "Wofür: Lädt ein Quell- oder Kontrollvideo in das Studio. Gute Eingabe: ein sauber dekodierbares Video mit passender Dauer und stabiler Bildrate.",
  maskUpload:
    "Wofür: Lädt eine zeitlich ausgerichtete IC-LoRA-Kontrollmaske hoch. Gute Eingabe: helle Bereiche für starke Kontrolle, dunkle für geringe Kontrolle, passend zur Videoauflösung.",
  audioStart:
    "Wofür: Überspringt den angegebenen Anfang der Audiodatei. Empfehlung: 0 für den Dateianfang oder die exakte Startzeit in Sekunden, zum Beispiel 12,5.",
  audioDuration:
    "Wofür: Begrenzt den verwendeten Audioausschnitt. Empfehlung: leer für automatische Dauer oder eine positive Sekundenangabe passend zur gewünschten Szene.",
  lipDubReferenceStrength:
    "Wofür: Gewichtet, wie stark das Referenzvideo Bewegung, Timing und Mundführung vorgibt. Empfehlung: mit 1,0 starten; bei zu starrer Kopplung auf 0,7 bis 0,9 senken.",
  lipDubCalibrationClip:
    "Wofür: Schneidet zuerst einen kurzen, reproduzierbaren Testausschnitt und normalisiert Video und Audio gemeinsam. Empfehlung: eingeschaltet lassen, bis LipSync, Identität und Referenzstärke mit einem 2- bis 5-Sekunden-Clip stimmen.",
  lipDubCalibrationStart:
    "Wofür: Startzeit des Kalibrierclips im Referenzvideo. Gute Eingabe: eine ruhige Stelle mit klar sichtbarem Mund, einem Sprecher, ohne Schnitt, Hand oder Haare vor dem Gesicht.",
  lipDubCalibrationDuration:
    "Wofür: Gewünschte Länge des Kalibrierclips. Empfehlung: 4,2 Sekunden; die Vorbereitung kürzt geringfügig auf die nächste kleinere 8k+1-Framezahl, damit LTX später keine weiteren Frames verwirft.",
  longcatLipsync:
    "Wofür: Rendert zusätzlich mit LongCat eine präziser audiogeführte Mundbewegung und überträgt sie per dynamischem Gesichts- und Mundwinkel-Tracking auf das LTX-Video. Position und Größe folgen dem Mund, die Rotation der stabileren Augen- und Kopfachse. Bei unsicherer Erkennung bleibt der jeweilige LTX-Frame unverändert. Das ist deutlich langsamer, bleibt deshalb optional und wird bei identischem Bild und Audio zwischengespeichert.",
  longcatResolution:
    "Wofür: Auflösung des zusätzlichen LongCat-Renders. Empfehlung: 480p für Tests und die meisten Mundbereiche; 720p nur für große Nahaufnahmen, da es wesentlich mehr Zeit und Speicher benötigt.",
  longcatBlend:
    "Wofür: Breite der weichen Übergangszone um den vollständig ersetzten Mundkern. Empfehlung: 0,9; bei zu viel Bewegung der umgebenden Haut auf 0,6 bis 0,8 senken. Die Zone endet unterhalb der Nase und überträgt außerhalb des Mundkerns keine vollflächige LongCat-Haut.",
  retakeStart:
    "Wofür: Beginn des zu regenerierenden Bereichs im Quellvideo. Gute Eingabe: Zeit in Sekunden ab Videostart; für saubere Übergänge etwas vor der problematischen Stelle beginnen.",
  retakeEnd:
    "Wofür: Ende des zu regenerierenden Bereichs im Quellvideo. Gute Eingabe: eine Zeit nach dem Start und innerhalb der Videodauer; für saubere Übergänge etwas danach enden.",
  regenerateVideo:
    "Wofür: Erzeugt die Bildspur im gewählten Retake-Bereich neu. Empfehlung: einschalten, wenn Bildinhalt oder Bewegung geändert werden sollen.",
  regenerateAudio:
    "Wofür: Erzeugt die Audiospur im gewählten Retake-Bereich neu. Empfehlung: einschalten, wenn Sprache, Geräusche oder Synchronität angepasst werden sollen.",
  distilledSchedule:
    "Wofür: Nutzt den schnellen Distilled-Ablauf und den Distilled Checkpoint. Empfehlung: für schnelle Retakes einschalten; für maximale Steuerbarkeit ausschalten.",
  controlVideoPath:
    "Wofür: Absoluter DGX-Pfad zu einem IC-LoRA-Kontrollvideo, das Bewegung oder Struktur vorgibt. Gute Eingabe: ein lesbares Video mit passender Dauer und klarer Bewegung.",
  controlStrength:
    "Wofür: Gewichtet den Einfluss des IC-LoRA-Kontrollvideos. Empfehlung: mit 1,0 starten; für mehr Freiheit absenken, für stärkere Kontrolle vorsichtig erhöhen.",
  maskPath:
    "Wofür: Beschränkt IC-LoRA-Aufmerksamkeit räumlich auf die hellen Maskenbereiche. Gute Eingabe: Video oder Maske mit gleicher Größe und zeitlicher Ausrichtung wie die Konditionierung.",
  maskStrength:
    "Wofür: Skaliert die Aufmerksamkeit innerhalb der Kontrollmaske. Empfehlung: 1,0 für volle Wirkung; 0,5 für eine weichere lokale Kontrolle; 0 deaktiviert sie.",
  skipStage2:
    "Wofür: Überspringt Upscaling und Verfeinerung der zweiten IC-LoRA-Stufe. Empfehlung: nur für schnelle Vorschauen einschalten; für die finale Ausgabe ausschalten.",
  checkpoint:
    "Wofür: LTX-2 Hauptcheckpoint für die Video- und Audioerzeugung. Gute Eingabe: absoluter Pfad zur passenden .safetensors-Datei der gewählten Pipeline.",
  distilledCheckpoint:
    "Wofür: Für wenige Inferenzschritte optimierter LTX-2 Checkpoint. Gute Eingabe: absoluter Pfad zum kompatiblen Distilled-.safetensors-Modell.",
  gemmaRoot:
    "Wofür: Modellordner des von LTX-2 benötigten Gemma-Textencoders. Derselbe Encoder kann optional auch den Prompt verbessern. Gute Eingabe: absoluter Pfad zum vollständigen lokalen Gemma-Modellordner einschließlich Tokenizer und preprocessor_config.json.",
  spatialUpscaler:
    "Wofür: Modell für die zweite Stufe, die das Video räumlich vergrößert und verfeinert. Gute Eingabe: absoluter Pfad zum zu diesem LTX-Checkpoint passenden Upscaler.",
  distilledLora:
    "Wofür: Pfad zur Distilled-LoRA, die den schnellen Ablauf der Zwei-Stufen-Pipeline unterstützt. Gute Eingabe: kompatible lokale .safetensors-Datei.",
  distilledLoraStrength:
    "Wofür: Gewichtet den Einfluss der Distilled-LoRA. Empfehlung: mit 1,0 starten und nur bei sichtbarer Über- oder Untersteuerung in kleinen Schritten ändern.",
  lipDubLora:
    "Wofür: Spezialisierte IC-LoRA für die native LipDub-Pipeline. Gute Eingabe: das offizielle lokale Lightricks-LipDub-LoRA-Modell, nicht eine normale Stil- oder Charakter-LoRA. Das Modell ist gated und muss im Hugging-Face-Account freigegeben sein.",
  lipDubLoraStrength:
    "Wofür: Regelt den Einfluss der LipDub-IC-LoRA auf Mundbewegung und Referenzbindung. Empfehlung: mit 1,0 starten; nur in kleinen Schritten ändern, wenn der Mund zu schwach oder zu dominant folgt.",
  loraPath:
    "Wofür: Lädt eine zusätzliche Stil-, Charakter- oder Kontroll-LoRA. Gute Eingabe: absoluter Pfad zu einer mit dem LTX-Checkpoint kompatiblen .safetensors-Datei.",
  loraStrength:
    "Wofür: Regelt den Einfluss der zusätzlichen LoRA. Empfehlung: mit 1,0 starten; 0,5 bis 0,8 wirkt subtiler, negative Werte kehren den Einfluss experimentell um.",
  width:
    "Wofür: Breite der Ausgabe in Pixeln. Empfehlung: Pipeline-Vorgabe verwenden; bei Zwei-Stufen durch 64, bei Eine-Stufe durch 32 teilbare Werte wählen.",
  height:
    "Wofür: Höhe der Ausgabe in Pixeln. Empfehlung: Pipeline-Vorgabe verwenden; bei Zwei-Stufen durch 64, bei Eine-Stufe durch 32 teilbare Werte wählen.",
  frames:
    "Wofür: Anzahl der erzeugten Videoframes und damit zusammen mit FPS die Dauer. Gültige Werte folgen 8k+1, zum Beispiel 121; das sind bei 24 FPS etwa 5 Sekunden.",
  fps:
    "Wofür: Wiedergabegeschwindigkeit in Frames pro Sekunde. Empfehlung: 24 für filmische Bewegung, 25 oder 30 für gängige Videoformate; beeinflusst die Dauer, nicht die Framezahl.",
  seed:
    "Wofür: Startwert des Zufallsprozesses. Empfehlung: denselben sichtbaren Wert für reproduzierbare Ergebnisse behalten; der Würfel erzeugt einen neuen konkreten Zufalls-Seed.",
  steps:
    "Wofür: Anzahl der Entrauschungsschritte. Empfehlung: Pipeline-Vorgabe nutzen; mehr Schritte kosten Zeit und bringen nach einem gewissen Punkt kaum sichtbare Verbesserung.",
  outputName:
    "Wofür: Dateiname der fertigen Ausgabe im konfigurierten Ausgabeordner. Gute Eingabe: Buchstaben, Zahlen, Punkt, Bindestrich oder Unterstrich und zwingend die Endung .mp4.",
  tiling:
    "Wofür: Verarbeitet die VAE in Kacheln und senkt damit den Speicherbedarf. Empfehlung: auf dem DGX eingeschaltet lassen; nur bei sichtbaren Kachelnaht-Artefakten testweise ausschalten.",
  quantization:
    "Wofür: Reduziert Speicherbedarf und kann die Inferenz beschleunigen. Empfehlung: FP8 Cast für weniger RAM; Aus für maximale Genauigkeit; FP8 Scaled nur mit passender AMAX-Datei.",
  amaxPath:
    "Wofür: Liefert Kalibrierungs-Maxima für FP8 Scaled MM. Gute Eingabe: absoluter Pfad zur exakt zum verwendeten Checkpoint passenden AMAX-Datei.",
  hqLoraStage1:
    "Wofür: Distilled-LoRA-Gewicht in der ersten HQ-Stufe. Empfehlung: 0,25 als Ausgangspunkt; nur in kleinen Schritten ändern.",
  hqLoraStage2:
    "Wofür: Distilled-LoRA-Gewicht in der zweiten HQ-Verfeinerungsstufe. Empfehlung: 0,5 als Ausgangspunkt; nur in kleinen Schritten ändern.",
  cfg:
    "Wofür: Verstärkt die Bindung an den Prompt. Empfehlung: Video 3,0 und Audio 7,0 als Startwerte; hohe Werte können Bewegung oder Klang unnatürlich machen.",
  stg:
    "Wofür: Spatio-Temporal Guidance verbessert zeitliche Konsistenz mit zusätzlichen Modellberechnungen. Empfehlung: 1,0; 0 deaktiviert STG, 0,5 bis 1,5 ist der typische Bereich.",
  rescale:
    "Wofür: Gleicht die Varianz nach Guidance an und reduziert Übersättigung. Empfehlung: 0,7 für Video; 0 deaktiviert den Effekt.",
  modality:
    "Wofür: Verbessert die Abstimmung zwischen Bild und Ton. Empfehlung: 3,0 für audiovisuelle Szenen; 1,0 deaktiviert die zusätzliche Modalitätsführung.",
  skipStep:
    "Wofür: Überspringt Guidance regelmäßig, um Rechenzeit zu sparen. Empfehlung: 0 für beste Qualität; positive Werte nur für gezielte Geschwindigkeitstests.",
  stgBlocks:
    "Wofür: Kommagetrennte Transformer-Blocknummern, auf die STG angewendet wird. Empfehlung: 28 für LTX-2.3 beibehalten; leer lassen, wenn STG deaktiviert ist.",
  resolutionPreset:
    "Wofür: Setzt Breite und Höhe gemeinsam auf geprüfte LTX-Werte. Empfehlung: Entwurf quer zum Testen, Produktion für Standardausgaben und Full HD erst für den finalen Lauf.",
  durationPreset:
    "Wofür: Berechnet aus Sekunden und FPS automatisch eine gültige Framezahl nach 8k+1. Empfehlung: zuerst 5 Sekunden testen, danach auf 10 oder 20 Sekunden erweitern.",
  longClip:
    "Wofür: Bestätigt den höheren Speicher-, Laufzeit- und Fehlversuchsaufwand ab mehr als 10 Sekunden. Erst aktivieren, nachdem Motiv und Bewegung mit einem 5-Sekunden-Test funktionieren.",
  sourceMode:
    "Wofür: Legt fest, ob LTX nur aus Text startet oder ein Referenzbild als ersten visuellen Anker verwendet. Empfehlung: Bild-zu-Video für Personen, Produkte, Logos und konsistente Bildgestaltung.",
  promptSubject:
    "Wofür: Definiert das zentrale Motiv. Gute Eingabe: konkrete Identität, Erscheinung, Material, Kleidung und unveränderliche Merkmale nennen.",
  promptAction:
    "Wofür: Beschreibt Handlung und Bewegung über die Zeit. Gute Eingabe: eindeutige Verben, Bewegungsrichtung, Tempo und gewünschtes Endergebnis nennen.",
  promptEnvironment:
    "Wofür: Legt Ort, Zeitpunkt und Hintergrund fest. Gute Eingabe: räumliche Anordnung, Wetter, Tageszeit und wichtige Hintergrundelemente beschreiben.",
  promptCamera:
    "Wofür: Steuert Bildausschnitt und Kamerabewegung. Gute Eingabe: Einstellungsgröße, Blickwinkel, Brennweitencharakter und genau eine klare Bewegung nennen.",
  promptLighting:
    "Wofür: Definiert Beleuchtung und visuellen Look. Gute Eingabe: Hauptlicht, Richtung, Härte, Kontrast, Farbtemperatur und Materialwirkung beschreiben.",
  promptDialogue:
    "Wofür: Gibt hörbare Sprache vor. Gute Eingabe: Sprecher und exakten Wortlaut in Anführungszeichen nennen; bei Audio zu Video exakt die Audiodatei transkribieren. Kurze Sätze sind zuverlässiger als lange Monologe.",
  promptAmbience:
    "Wofür: Beschreibt die Geräuschkulisse. Gute Eingabe: wenige konkrete Geräusche, räumliche Nähe und Lautstärkeverhältnis zur Sprache nennen.",
  promptMusic:
    "Wofür: Beschreibt die musikalische Begleitung. Gute Eingabe: Genre, Tempo, Instrumente und Einsatzzeit nennen oder ausdrücklich keine Musik verlangen.",
  continuityProject:
    "Wofür: Gruppiert Szenen gedanklich unter einem wiedererkennbaren Projekt. Gute Eingabe: kurzer stabiler Name für Kampagne, Film, Figur oder Produktreihe.",
  continuityNotes:
    "Wofür: Hält unveränderliche Merkmale für Gemma und spätere Varianten fest. Gute Eingabe: exakte Farben, Kleidung, Requisiten, räumliche Positionen und Anschlüsse zwischen Szenen nennen.",
  qualityReview:
    "Wofür: Speichert eine reproduzierbare manuelle Qualitätsmessung direkt beim fertigen Sprachvideo. Empfehlung: Video mit Ton vollständig ansehen, jeden Einzelwert unabhängig vergeben und konkrete Fehler in der Notiz festhalten.",
  qualityLipSync:
    "Wofür: Bewertet die zeitliche Übereinstimmung von Lauten und sichtbarer Mundbewegung. 10 bedeutet framegenau und glaubwürdig, 5 merklich versetzt, 0 ohne verwertbare Synchronität.",
  qualityIdentity:
    "Wofür: Bewertet, wie exakt Gesicht und Person der visuellen Referenz entsprechen. 10 bedeutet stabile Identität über alle Frames; Abzüge für Gesichtsdrift, fremde Merkmale oder wechselnde Proportionen.",
  qualityMouthNaturalness:
    "Wofür: Bewertet Mundform, Symmetrie, Zähne, Lippen und Artikulation unabhängig vom Timing. Abzüge für schiefen, aufgesetzten oder anatomisch unplausiblen Mund.",
  qualitySkinStability:
    "Wofür: Bewertet Haut und Gewebe um Mund, Nase und Wangen. 10 bedeutet stabil und natürlich; Abzüge für Hüpfen, Flimmern, Schwabbeln oder maskenartige Übergänge.",
  qualityMotion:
    "Wofür: Bewertet Kopf-, Gesichts- und Körperbewegung sowie zeitliche Kontinuität. 10 bedeutet flüssige natürliche Bewegung ohne Jitter, Einfrieren oder unerklärliche Sprünge.",
  qualityAudio:
    "Wofür: Bewertet Sprachverständlichkeit, Klangqualität und Störfreiheit. 10 bedeutet klare natürliche Sprache ohne Knacken, Verzerrung, Pumpen oder falsches Lautstärkeverhältnis.",
  qualityNote:
    "Wofür: Hält sichtbare Fehler und die nächste gezielte Parameteränderung fest. Gute Eingabe: Zeitpunkt, konkrete Beobachtung und vermutete Ursache, zum Beispiel '1,8 s: Lippen 3 Frames zu spät; Referenzstärke 0,9 testen'.",
} as const;
