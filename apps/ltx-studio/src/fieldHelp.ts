export const fieldHelp = {
  prompt:
    "Wofür: Beschreibt Inhalt und Gestaltung des Videos. Gute Eingabe: Motiv, Handlung, Umgebung, Kamera, Licht und gewünschten Ton in klaren Sätzen nennen.",
  enhancePrompt:
    "Wofür: Der ohnehin benötigte Gemma-Textencoder erweitert den positiven Prompt und verwendet bei Bild-zu-Video auch das Referenzbild. Danach erzeugt dieselbe Modellinstanz die LTX-Konditionierung. Empfehlung: Bei kurzen visuellen Ideen einschalten; bei nativ erzeugtem Dialog bleibt die Option aus, damit der exakte Wortlaut nicht umformuliert wird.",
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
  imageCropX:
    "Wofür: Linke Kante des neuen Ausschnitts in Pixeln ab dem linken Rand des Quellbildes. Gute Eingabe: 0 beginnt ganz links; der Ausschnitt muss vollständig innerhalb des Quellbildes bleiben.",
  imageCropY:
    "Wofür: Obere Kante des neuen Ausschnitts in Pixeln ab dem oberen Rand des Quellbildes. Gute Eingabe: 0 beginnt ganz oben; bei Porträts so wählen, dass Kinn und Stirn nicht versehentlich abgeschnitten werden.",
  imageCropWidth:
    "Wofür: Breite des entnommenen Quellbereichs vor der Skalierung. Gute Eingabe: mindestens 64 Pixel; für Lipsync Mund, Kinn, Nase und etwas Wangenkontext einschließen.",
  imageCropHeight:
    "Wofür: Höhe des entnommenen Quellbereichs vor der Skalierung. Gute Eingabe: mindestens 64 Pixel und für unverzerrte Gesichter passend zur Ausschnittbreite wählen.",
  imageCropOutputWidth:
    "Wofür: Breite des neuen reproduzierbaren Referenzassets. Gute Eingabe: 576 für die aktuellen quadratischen Lipsync-Tests; der Wert muss durch 64 teilbar sein.",
  imageCropOutputHeight:
    "Wofür: Höhe des neuen reproduzierbaren Referenzassets. Gute Eingabe: 576 für die aktuellen quadratischen Lipsync-Tests; der Wert muss durch 64 teilbar sein.",
  mediaPath:
    "Wofür: Verwendet eine bereits auf dem DGX vorhandene Datei ohne Upload. Gute Eingabe: ein absoluter, lesbarer Pfad zur passenden Audio-, Video- oder Maskendatei.",
  audioUpload:
    "Wofür: Lädt eine Audiodatei als zeitliche und akustische Vorlage hoch. Gute Eingabe: für Lipsync zuerst saubere, sprachdominante Mono- oder Stereo-Sprache ohne Musikbett; Musik erst hinzufügen, wenn die Mundbewegung funktioniert.",
  audioConditioning:
    "Wofür: Diese Spur steuert die Mundbewegung im nativen Audio-zu-Video-Modell. Gute Eingabe: klare Sprache ohne Musik, Hall oder Rauschen, exakt auf die Videodauer zugeschnitten. Die gelieferte Sprache bleibt im LTX-Ergebnis unverändert.",
  audioFinalMix:
    "Wofür: Optionale fertige Tonspur, die nach dem LTX-Render anstelle der reinen Sprachspur eingesetzt wird. Gute Eingabe: derselbe zeitlich ausgerichtete Sprachtext mit gewünschter Musik und Atmosphäre; Anfang und Dauer folgen den Feldern darunter.",
  lipDubTargetLanguage:
    "Wofür: Nennt die Sprache, in der das offizielle LipDub-Modell den neuen Dialog erzeugen soll. Gute Eingabe: ein eindeutiger Sprachname wie Deutsch, Englisch oder Japanisch; den Dialog im üblichen Schriftsystem dieser Sprache eingeben.",
  lipDubPipelineProfile:
    "Wofür: Wählt den Modellaufbau für LipDub. „Offiziell Comfy HQ“ bildet den veröffentlichten Lightricks-Workflow mit Dev-Checkpoint, Distilled-LoRA 1.1 bei Stärke 0,5, LipDub-IC-LoRA und zwei hochauflösenden Stufen nach. „Native Distilled (Legacy)“ ist ausschließlich für reproduzierbare Wiederholungen alter Jobs gedacht.",
  lipDubSingleSpeaker:
    "Wofür: Bestätigt die Modellvoraussetzung, dass im Referenzclip genau eine sichtbare Person spricht. Einschalten nur bei einem einzelnen Sprecher; mehrere Sprecher, Stimmen aus dem Off oder überlappende Sprache sind für diesen Modus ungeeignet.",
  videoUpload:
    "Wofür: Lädt ein Quell- oder Kontrollvideo in das Studio. Gute Eingabe: ein sauber dekodierbares Video mit passender Dauer und stabiler Bildrate.",
  maskUpload:
    "Wofür: Lädt eine zeitlich ausgerichtete IC-LoRA-Kontrollmaske hoch. Gute Eingabe: helle Bereiche für starke Kontrolle, dunkle für geringe Kontrolle, passend zur Videoauflösung.",
  audioStart:
    "Wofür: Überspringt den angegebenen Anfang der Audiodatei. Empfehlung: 0 für den Dateianfang oder die exakte Startzeit in Sekunden, zum Beispiel 12,5.",
  audioDuration:
    "Wofür: Begrenzt den verwendeten Audioausschnitt. Empfehlung: leer für automatische Dauer oder eine positive Sekundenangabe passend zur gewünschten Szene.",
  lipDubReferenceStrength:
    "Wofür: Regelt, wie stark LipDub das Bild des Referenzvideos festhält. Empfehlung: 1,0 wie im offiziellen Workflow. Der gemessene Vergleich mit 0,8 verschlechterte bei dieser Referenz Identität, Mundform und Pausenruhe; daher nur nach einem gezielten A/B-Test ändern.",
  lipDubCalibrationClip:
    "Wofür: Schneidet zuerst einen kurzen, reproduzierbaren Testausschnitt und normalisiert Video und Audio gemeinsam. Empfehlung: eingeschaltet lassen, bis LipSync, Identität und Referenzstärke mit einem 2- bis 5-Sekunden-Clip stimmen.",
  lipDubCalibrationStart:
    "Wofür: Startzeit des Kalibrierclips im Referenzvideo. Gute Eingabe: eine ruhige Stelle mit klar sichtbarem Mund, einem Sprecher, ohne Schnitt, Hand oder Haare vor dem Gesicht.",
  lipDubCalibrationDuration:
    "Wofür: Gewünschte Länge des Kalibrierclips. Empfehlung: 4,2 Sekunden; die Vorbereitung kürzt geringfügig auf die nächste kleinere 8k+1-Framezahl, damit LTX später keine weiteren Frames verwirft.",
  longcatLipsync:
    "Wofür: Erzeugt mit LongCat Video Avatar 1.5 eine separate Sprechbewegung und überträgt daraus nur den Mundbereich in das LTX-Video. Der aktuelle Mund-Composite ist experimentell und kann bei Kopfbewegung sichtbare Übergänge, einen schiefen Mund oder unnatürliche Hautbewegung erzeugen. Empfehlung: ausgeschaltet lassen; LongCat, LatentSync und MuseTalk nur in kontrollierten Vergleichen einzeln testen, da keiner dieser Zusatzpfade bisher eine Produktionsfreigabe erreicht hat.",
  longcatResolution:
    "Wofür: Auflösung des zusätzlichen LongCat-Renders. Empfehlung: 480p für Tests und die meisten Mundbereiche; 720p nur für große Nahaufnahmen, da es wesentlich mehr Zeit und Speicher benötigt.",
  longcatBlend:
    "Wofür: Breite der weichen Übergangszone um den vollständig ersetzten Mundkern. Empfehlung: 0,9; bei zu viel Bewegung der umgebenden Haut auf 0,6 bis 0,8 senken. Die Zone endet unterhalb der Nase und überträgt außerhalb des Mundkerns keine vollflächige LongCat-Haut.",
  latentSync:
    "Wofür: Verfeinert nach dem LTX-Render das vorhandene Gesicht mit LatentSync 1.6 passend zur bereits erzeugten Tonspur. Der offizielle InsightFace-106-Punkt-Pfad richtet das Gesicht aus; Kopf, Körper und Hintergrund bleiben aus dem LTX-Video. Empfehlung: nur für lokale, nicht-kommerzielle Qualitätsvergleiche einschalten. Der zusätzliche GPU-Pass ist deutlich langsamer.",
  latentSyncSteps:
    "Wofür: Anzahl der offiziellen LatentSync-Diffusionsschritte. Empfehlung: 30 als Qualitätsstandard; 20 für einen schnelleren Test, 40 bis 50 nur nach einem sichtbaren Vergleich, da mehr Schritte nicht automatisch bessere Synchronität liefern.",
  latentSyncGuidance:
    "Wofür: Stärke der Audiosteuerung im LatentSync-Gesichtsrefiner. Empfehlung: 2,0. Werte näher an 3 können Mundformen stärker erzwingen, erhöhen aber das Risiko sichtbarer Gesichtsänderungen; Werte näher an 1 bewahren das Ausgangsbild stärker.",
  museTalk:
    "Wofür: Ersetzt nach dem LTX-Render den unteren Gesichtsbereich bildweise mit MuseTalk 1.5 und der vorhandenen Tonspur. Kopfbewegung, Körper und Hintergrund bleiben aus LTX; eine semantische Gesichtsmaske blendet das Ergebnis ein. Empfehlung: für Qualitätsvergleiche einschalten, standardmäßig AUS lassen, bis die objektive P/B/M- und Identitätsmessung für die konkrete Aufnahme besser als der native Lauf ist.",
  museTalkExtraMargin:
    "Wofür: Erweitert den bearbeiteten Gesichtsausschnitt unter dem erkannten Kinn. Empfehlung: 10 wie in MuseTalk 1.5. Erhöhen, wenn der Unterlippen- oder Kinnbereich abgeschnitten wirkt; senken, wenn Hals oder Kleidung sichtbar mitverändert werden.",
  museTalkCheekWidth:
    "Wofür: Schützt die äußeren Wangen vor unnötiger Veränderung durch die semantische Einblendmaske. Empfehlung: 90 wie im offiziellen MuseTalk-1.5-Pfad. Größer bewahrt mehr Originalhaut, kleiner erlaubt eine breitere Anpassung um den Mund.",
  museTalkAudioPaddingLeft:
    "Wofür: Anzahl zusätzlicher Audio-Kontextfenster vor jedem Videobild. Empfehlung: 2. Ein größerer Wert kann frühe Mundbewegungen glätten, kann den sichtbaren Einsatz aber zeitlich nach vorne ziehen.",
  museTalkAudioPaddingRight:
    "Wofür: Anzahl zusätzlicher Audio-Kontextfenster nach jedem Videobild. Empfehlung: 2. Ein größerer Wert kann Übergänge zwischen Lauten glätten, kann den sichtbaren Einsatz aber zeitlich verzögern.",
  lipForcing:
    "Wofür: Regeneriert den Mundbereich mit dem offiziellen LipForcing-14B-Modell. Eine vorhandene saubere Konditionierungs-Sprachspur wird mit derselben Startzeit und Maximaldauer zugeschnitten, steuert die Lippen und bleibt bis zum optionalen späteren Musik-Endmix die hörbare Spur. Ohne separate Führung wird der LTX-Ton verwendet. Die Person wird pro Bild mit InsightFace ausgerichtet; Kopfbewegung, Körper, Hintergrund, Bildzahl und Bildrate bleiben erhalten. Empfehlung: nur für kontrollierte Qualitätsvergleiche einschalten und standardmäßig AUS lassen, bis das konkrete Ergebnis die native Version bei P/B/M-Verschluss, Identität und Pausenruhe messbar übertrifft.",
  lipForcingDecoder:
    "Wofür: Wählt die Bilddekodierung des LipForcing-Ergebnisses. „Maximale Qualität“ verwendet die offizielle vollständige Wan-VAE und ist langsamer; „Schneller Test“ verwendet den kleinen Streaming-TAEHV-Decoder und kann sichtbar weichere oder unruhigere Munddetails erzeugen. Empfehlung: für die Endbeurteilung maximale Qualität.",
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
  icLoraProfile:
    "Wofür: Wählt einen veröffentlichten LTX-2.3-IC-LoRA-Ablauf. Union Control überträgt Tiefe, Kanten oder Pose. Ingredients kombiniert ein Referenzblatt. Motion Track folgt Bewegungsbahnen. Pixel x4 vergrößert generativ. V2V Rasur entfernt Bart. Inpainting ersetzt maskierte Bildteile, Outpainting erweitert die Leinwand, HDR erzeugt ein lineares Master.",
  controlVideoPath:
    "Wofür: Absoluter DGX-Pfad zu einem IC-LoRA-Kontrollvideo, das Bewegung oder Struktur vorgibt. Gute Eingabe: ein lesbares Video mit passender Dauer und klarer Bewegung.",
  unionControlLora:
    "Wofür: Offizielle LTX-2.3 Union-Control IC-LoRA für framegenaue Tiefen-, Posen- oder Kantenführung. Gute Eingabe: die verifizierte ref0.5-Datei; andere LoRAs gehören in „Weitere LoRAs“.",
  unionControlStrength:
    "Wofür: Bestimmt, wie stark das offizielle Union-Control-Modell die Struktur des Kontrollvideos übernimmt. Empfehlung: mit 1,0 starten und erst nach einem Vergleichslauf in Schritten von 0,1 ändern.",
  ingredientsLora:
    "Wofür: Offizielle LTX-2.3 Ingredients IC-LoRA, die mehrere sichtbare Bestandteile eines Referenzblatts in der beschriebenen Zielszene kombiniert. Gute Eingabe: die vollständig SHA-256-verifizierte Datei ltx-2.3-22b-ic-lora-ingredients-0.9.safetensors.",
  ingredientsStrength:
    "Wofür: Gewichtet die offizielle Ingredients IC-LoRA. Empfehlung: 1,0 wie in der veröffentlichten Vorlage; zuerst Prompt und Referenzblatt verbessern, bevor dieser Wert verändert wird.",
  motionTrackLora:
    "Wofür: Offizielle Motion-Track IC-LoRA, die im Referenzbild markierte Motive entlang einer vorbereiteten farbigen Track-Sequenz bewegt. Gute Eingabe: die vollständig SHA-256-verifizierte ref0.5-Datei.",
  motionTrackStrength:
    "Wofür: Gewichtet die Motion-Track-Führung. Empfehlung: 1,0 wie in der offiziellen Vorlage; Bewegungsbahnen zuerst im Track-Video korrigieren, statt die Stärke zu erhöhen.",
  pixelUpscalerLora:
    "Wofür: Offizielle generative Pixel-Spatial-Upscaler-IC-LoRA x4. Sie erhält Bewegung und Bildaufbau des Quellvideos, erzeugt Details aber neu. Ausgabe-Breite und -Höhe müssen jeweils dem Vierfachen der Quelle entsprechen.",
  pixelUpscalerStrength:
    "Wofür: Gewichtet die x4-Pixelreferenz. Empfehlung: 1,0 wie in der offiziellen Vorlage; für stärkere Quelltreue eher den Denoise-Schedule verkürzen als diesen Wert willkürlich abzusenken.",
  instantShaveLora:
    "Wofür: Offizielle V2V-Demonstrations-IC-LoRA „Instant Shave“. Sie ist ausschließlich auf das Entfernen von Bart und Stoppeln spezialisiert; das Studio setzt das benötigte Triggerwort REMOVEBEARD automatisch vor den Prompt.",
  instantShaveStrength:
    "Wofür: Gewichtet das spezialisierte Instant-Shave-Modell. Empfehlung: 1,0 wie in der offiziellen Vorlage; ein klar sichtbares Gesicht und eine genaue Beschreibung glatter, bartloser Haut sind wichtiger als höhere Werte.",
  inOutpaintLora:
    "Wofür: Offizielle LTX-2.3 In-/Outpainting IC-LoRA für zeitlich konsistentes Ersetzen maskierter Videobereiche oder Erweitern des Bildrands. Gute Eingabe: die SHA-256-verifizierte Datei ltx-2.3-22b-ic-lora-in-outpainting-0.9.safetensors.",
  inOutpaintStrength:
    "Wofür: Gewichtet die In-/Outpainting IC-LoRA in beiden Diffusionsstufen. Empfehlung: exakt 1,0 wie in den veröffentlichten Vorlagen; die Form der Maske und der Szenenprompt sind die wirksameren Stellschrauben.",
  inpaintMask:
    "Wofür: Weiß markiert in jedem Frame den neu zu erzeugenden Bereich, Schwarz bewahrt das Quellvideo. Gute Eingabe: verlustarm gespeichertes, framegenaues Graustufen-Video mit derselben Dauer wie das Quellvideo; Maskenkanten nicht unnötig knapp um das Objekt legen.",
  controlMask:
    "Wofür: Begrenzt Union-Control räumlich. Helle Bereiche erhalten stärkere Kontrollführung, dunkle Bereiche weniger. Gute Eingabe: framegenaues Graustufen-Video passend zum Kontrollvideo; leer lassen, wenn die Führung im ganzen Bild gelten soll.",
  hdrLora:
    "Wofür: Offizielle LTX-2.3 HDR IC-LoRA. Sie führt ein Quellvideo in einem linearen HDR-Arbeitsfarbraum weiter und erzeugt neben der sichtbaren MP4-Vorschau eine EXR-Bildsequenz für Farbkorrektur und echtes HDR-Mastering.",
  hdrStrength:
    "Wofür: Gewichtet die HDR IC-LoRA. Der native veröffentlichte Ablauf verwendet fest 1,0; diesen Wert für vergleichbare Resultate beibehalten.",
  hdrEmbeddings:
    "Wofür: Offizielle vorab berechnete Szenen-Embeddings für den nativen HDR-Pfad. Gute Eingabe: die vollständig SHA-256-verifizierte Datei ltx-2.3-22b-ic-lora-hdr-scene-emb.safetensors aus demselben gated Repository.",
  hdrHighQuality:
    "Wofür: Erzeugt intern die doppelte zeitliche Dichte und behält danach jeden zweiten Frame. Das reduziert HDR-Zeitflimmern, benötigt aber ungefähr die doppelte Rechenzeit. Für einen ersten Test ausschalten, für das Master nach sichtbarem Vergleich einschalten.",
  controlType:
    "Wofür: Legt fest, wie das hochgeladene Fahrvideo in eine Union-Control-Eingabe umgewandelt wird. MoGe-Tiefe ist die offizielle Vorlage; Canny betont Konturen. Fertige Map und Pose erwarten bereits aufbereitete, framegenaue Kontrollbilder.",
  mogeModel:
    "Wofür: Offizielles MoGe-2-Geometriemodell für automatische Tiefenschätzung. Gute Eingabe: die vollständig SHA-256-verifizierte FP16-Datei aus Comfy-Org/MoGe.",
  idLoraReferenceAudio:
    "Wofür: Überträgt die Sprecheridentität auf die neu erzeugte Stimme. Gute Eingabe: etwa fünf Sekunden saubere Einzelsprache ohne Musik, Hall, Rauschen oder zweite Stimme; der Wortlaut der Referenz wird nicht übernommen.",
  idLoraModel:
    "Wofür: Offizielle LTX-2.3 TalkVid-ID-LoRA für gemeinsame Personen- und Stimmidentität. Gute Eingabe: die vollständig SHA-256-verifizierte Datei ltx-2.3-id-lora-talkvid-3k.safetensors.",
  idLoraStrength:
    "Wofür: Gewichtet die TalkVid-ID-LoRA. Empfehlung: 1,0 als offizieller Ausgangswert; nur nach einem reproduzierbaren Vergleich in kleinen Schritten ändern.",
  idLoraGuidance:
    "Wofür: Verstärkt die aus dem Referenzton gelernte Stimme durch einen zusätzlichen Modelllauf ohne Referenz. Empfehlung: 3,0 wie in der offiziellen Vorlage; höhere Werte können Klang und Artikulation verschlechtern.",
  idLoraGuidanceWindow:
    "Wofür: Legt fest, in welchem Anteil des Entrauschungsverlaufs die zusätzliche Stimmidentitätsführung aktiv ist. Empfehlung: Start 0 und Ende 1 für den vollständigen offiziellen Ablauf.",
  idLoraStage1ImageStrength:
    "Wofür: Bindet das Referenzbild während der ersten, niedrig aufgelösten Stufe. Empfehlung: 0,7 wie in der offiziellen ID-LoRA-Vorlage. Die zweite Stufe verwendet danach Stärke 1,0, damit Identitätsdetails beim Hochskalieren erhalten bleiben.",
  idLoraDistilledStrength:
    "Wofür: Gewichtet die offizielle dynamische Distilled-LoRA in beiden ID-LoRA-Stufen. Empfehlung: 0,5 wie in der offiziellen Vorlage; dieser Wert ist bewusst niedriger als bei der normalen Zwei-Stufen-Pipeline.",
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
    "Wofür: Modellordner des von LTX-2 benötigten Gemma-Textencoders. Für Sprach- und LipDub-Läufe verlangt das Studio den vollständig geprüften offiziellen Google-Gemma-QAT-Q4-Ordner einschließlich Tokenizer und preprocessor_config.json.",
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
  lipDubDistilledLoraStrength:
    "Wofür: Gewichtet die Distilled-LoRA innerhalb des offiziellen Comfy-HQ-LipDub-Aufbaus. Empfehlung: exakt 0,5 wie in der veröffentlichten Lightricks-Vorlage; erst nach einem reproduzierbaren Vergleich verändern.",
  loraPath:
    "Wofür: Lädt eine zusätzliche Stil-, Charakter- oder Kontroll-LoRA. Gute Eingabe: absoluter Pfad zu einer mit dem LTX-Checkpoint kompatiblen .safetensors-Datei.",
  loraStrength:
    "Wofür: Regelt den Einfluss der zusätzlichen LoRA. Empfehlung: mit 1,0 starten; 0,5 bis 0,8 wirkt subtiler, negative Werte kehren den Einfluss experimentell um.",
  width:
    "Wofür: Breite der Ausgabe in Pixeln. Empfehlung: Pipeline-Vorgabe verwenden; bei Zwei-Stufen durch 64, bei Eine-Stufe durch 32 teilbare Werte wählen.",
  height:
    "Wofür: Höhe der Ausgabe in Pixeln. Empfehlung: Pipeline-Vorgabe verwenden; bei Zwei-Stufen durch 64, bei Eine-Stufe durch 32 teilbare Werte wählen.",
  frames:
    "Wofür: Bestimmt zusammen mit FPS die Dauer. Bei Video ist es die Bildanzahl; bei Text zu Audio dient derselbe Wert nur als Zeitraster. Gültige Werte folgen 8k+1, zum Beispiel 121 für etwa 5 Sekunden bei 24 FPS.",
  fps:
    "Wofür: Wiedergabegeschwindigkeit in Frames pro Sekunde. Empfehlung: 24 für filmische Bewegung, 25 oder 30 für gängige Videoformate; beeinflusst die Dauer, nicht die Framezahl.",
  seed:
    "Wofür: Startwert des Zufallsprozesses. Empfehlung: denselben sichtbaren Wert für reproduzierbare Ergebnisse behalten; der Würfel erzeugt einen neuen konkreten Zufalls-Seed.",
  steps:
    "Wofür: Anzahl der Entrauschungsschritte. Empfehlung: Pipeline-Vorgabe nutzen; mehr Schritte kosten Zeit und bringen nach einem gewissen Punkt kaum sichtbare Verbesserung.",
  outputName:
    "Wofür: Dateiname der fertigen Ausgabe im konfigurierten Ausgabeordner. Gute Eingabe: Buchstaben, Zahlen, Punkt, Bindestrich oder Unterstrich; Video endet auf .mp4, Text zu Audio auf .wav.",
  tiling:
    "Wofür: Verarbeitet die VAE in Kacheln und senkt damit den Speicherbedarf. Empfehlung: auf dem DGX eingeschaltet lassen; nur bei sichtbaren Kachelnaht-Artefakten testweise ausschalten.",
  quantization:
    "Wofür: Reduziert Speicherbedarf und kann die Inferenz beschleunigen. Empfehlung: FP8 Cast ausschließlich mit BF16-Checkpoint; FP8 Scaled ausschließlich mit einem vorquantisierten FP8-Checkpoint, dessen Skalen bereits in der Datei liegen.",
  gemmaLora:
    "Wofür: Offizielle Gemma-Abliterated-LoRA der Comfy-LTX-2.3-Vorlagen. Sie wird nur in den Textencoder geladen und verbessert die uneingeschränkte Promptausführung. Gute Eingabe: die SHA-256-verifizierte Datei gemma-3-12b-it-abliterated_lora_rank64_bf16.safetensors.",
  gemmaLoraStrength:
    "Wofür: Gewicht der Gemma-LoRA im Textencoder. Empfehlung: 1,0 wie in den offiziellen Comfy-LTX-2.3-Vorlagen.",
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
    "Wofür: Gibt hörbare Sprache vor. Im nativen Text/Bild-zu-Video-Modus erzeugt LTX Stimme und Mundbewegung gemeinsam aus diesem exakten Wortlaut. Gute Eingabe: ein kurzer Satz im gewünschten Schriftsystem; bei Audio zu Video exakt die vorhandene Audiodatei transkribieren.",
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
  objectiveAnalysis:
    "Wofür: Misst den technischen Audio-/Videovertrag, verfolgt Gesicht, Nase und Mund mit CPU-YuNet, vergleicht die Identität mit CPU-SFace und schätzt grobe Audio-Mund-Bewegungsverzögerungen ohne fremden Modell-Checkpoint. Die Rohwerte helfen beim Vergleich identischer Testfälle. Sie sind noch keine kalibrierte 0-bis-10-Note.",
  objectiveFaceDetection:
    "Wofür: Anteil der untersuchten Frames, in denen YuNet ein Gesicht erkennt. Gut: bei einem unverdeckten Einzelporträt nahe 100 %. Ein niedriger Wert kann Verdeckung, Bewegungsunschärfe oder eine ungeeignete Ansicht bedeuten; er ist kein Qualitäts-Score.",
  objectiveGeometryCoverage:
    "Wofür: Anteil der Frames mit ausreichend stabilen Augen-, Nasen- und Mundpunkten für Geometriemessungen. Gut: bei einem frontalen Test nahe 100 %. Noch kein kalibrierter Grenzwert.",
  objectiveNoseVelocity:
    "Wofür: 95. Perzentil der Nasenbewegung, normiert auf den Augenabstand pro Sekunde. Einzelne Spitzen werden damit sichtbar. Niedriger ist nicht automatisch besser, weil natürliche Kopfbewegung dazugehört; nur gleiche Testfälle vergleichen.",
  objectiveNoseAcceleration:
    "Wofür: 95. Perzentil der Änderung der normalisierten Nasengeschwindigkeit in Augenabständen pro Sekunde². Hohe Ausreißer können eine springende Nasenspitze anzeigen. Noch kein kalibrierter Grenzwert.",
  objectiveMouthAngle:
    "Wofür: Median der Mundlinie relativ zur Augenlinie in Grad. Werte nahe 0° wirken meist gerade, hängen aber von Perspektive und Anatomie ab. Noch kein Identitäts- oder Qualitätsurteil.",
  objectiveMouthAngleDynamics:
    "Wofür: 95. Perzentil der Änderung des relativen Mundwinkels in Grad pro Sekunde. Starke Spitzen können einen kippenden oder springenden Mund anzeigen. Noch kein kalibrierter Grenzwert.",
  objectiveMouthSkinCoverage:
    "Wofür: Anteil aller aufeinanderfolgenden Video-Stichproben, in denen die stabilisierte Hautzone um Mund und Nase mit vorwärts/rückwärts-konsistentem Bewegungsfeld verglichen werden konnte. Für einen belastbaren Rohvergleich sind mindestens acht Paare und 50 % Abdeckung nötig; näher an 100 % ist besser.",
  objectiveMouthSkinPixelCoverage:
    "Wofür: 10. Perzentil des pro Bildpaar tatsächlich verwertbaren Anteils der Hautring-Pixel nach Masken-, Rand-, Okklusions- und Vorwärts-/Rückwärtsprüfung. Für einen belastbaren Rohvergleich müssen selbst die schwächeren Paare mindestens 60 % erreichen.",
  objectiveMouthSkinWarpResidual:
    "Wofür: Zuerst wird pro Bildpaar das räumliche 95. Perzentil des verbleibenden photometrischen Texturfehlers gebildet, danach das zeitliche 95. Perzentil dieser Paarwerte. Optische Bewegung und eine gleichmäßige Helligkeitsverschiebung sind kompensiert. Höhere Rohwerte können Fremdmundkanten oder Flimmern anzeigen. Erst nach lokaler Kalibrierung bewerten.",
  objectiveMouthSkinLuminance:
    "Wofür: 95. Perzentil der Helligkeitsänderung in der bewegungskompensierten Hautzone um Mund und Nase. Hohe Werte können Flimmern anzeigen, reagieren aber auch auf echte Lichtwechsel. Deshalb nur identische Testfälle vergleichen und noch nicht als Qualitätsnote verwenden.",
  objectiveMouthSkinFlowDeformation:
    "Wofür: Die beste globale affine Kopfbewegung wird aus einer stabilen Gesichtsregion außerhalb des Mundkerns geschätzt und entfernt. Danach wird pro Bildpaar das räumliche 95. Perzentil des symmetrischen lokalen Deformationstensors und daraus das zeitliche 95. Perzentil gebildet. Nur Pixel mit vollständig gültiger 3×3-Flow-Nachbarschaft zählen. Lokales Verziehen kann den unkalibrierten Rohwert erhöhen.",
  objectiveIdentityCoverage:
    "Wofür: Anteil der untersuchten Ausgabeframes, in denen SFace die kryptografisch gebundene Referenzidentität eindeutig vergleichen konnte. Gut: bei einem sichtbaren Einzelgesicht nahe 100 %. Mehrere ähnlich passende Gesichter werden absichtlich als mehrdeutig ausgelassen.",
  objectiveIdentityMedian:
    "Wofür: Median der SFace-Cosinusähnlichkeit zwischen Referenz und Ausgabe über alle verwertbaren Frames. Höher bedeutet ähnlicher; 1,000 wäre identisch im Merkmalsraum. Nur mit demselben Modell und derselben Vorverarbeitung vergleichen; noch keine Qualitätsnote.",
  objectiveIdentityP10:
    "Wofür: Schlechtestes Dezil der SFace-Cosinusähnlichkeit. 90 % der verwertbaren Frames liegen mindestens auf diesem Wert. Er reagiert stärker auf zeitweilige Identitätsdrift als der Median. Noch kein lokal kalibrierter Grenzwert.",
  objectiveIdentityMinimum:
    "Wofür: Niedrigste gemessene SFace-Cosinusähnlichkeit eines eindeutigen Ausgabeframes. Hilfreich zum Finden einzelner Ausreißer, aber empfindlich gegenüber Unschärfe, Pose und Licht. Deshalb nie allein als Bestehensgrenze verwenden.",
  objectiveAvStartDelta:
    "Wofür: Differenz der Startzeitstempel von Audio- und Videospur. Gut für den technischen Vertrag: höchstens 40 ms. Dieser Wert misst nicht, ob Laute und Lippenbewegung phonemgenau synchron sind.",
  objectiveAvDurationDelta:
    "Wofür: Differenz zwischen messbarer Audio- und Videospurdauer. Gut für den technischen Vertrag: höchstens 40 ms. Fehlt eine echte Audiodauer, bleibt der Wert ausdrücklich nicht messbar.",
  objectiveAvMotionLag:
    "Wofür: Grobe Verzögerung am stärksten gemeinsamen Audio-Onset-/Mundbewegungssignal. Positiv bedeutet, dass die sichtbare Mundbewegung dem Audio folgt; negativ bedeutet, dass sie vorausläuft. Nur bei demselben Testclip vergleichen. Das ist keine Phonem- oder Visemprüfung.",
  objectiveConditioningAvMotionLag:
    "Wofür: Grobe Verzögerung zwischen der während der Generierung verwendeten, kryptografisch gebundenen Konditionierungs-Sprachspur und der Mundbewegung. Die eingestellte Quellstartzeit und Maximaldauer werden identisch ausgeschnitten. Positiv bedeutet Mund folgt Audio; negativ bedeutet Mund läuft voraus. Keine Phonem-/Visemprüfung.",
  objectiveAvMotionCorrelation:
    "Wofür: Pearson-Korrelation am besten gefundenen Versatz zwischen Audio-Onsets und stabilisierter Mundbewegung. Höher bedeutet ein klareres gemeinsames Bewegungssignal, nicht automatisch bessere LipSync-Qualität. Musik und Lichtwechsel können den Wert verfälschen.",
  objectiveAvMotionProminence:
    "Wofür: Abstand des besten Korrelationspeaks zum stärksten konkurrierenden Peak. Ein größerer Abstand macht die Lag-Schätzung eindeutiger. Der Rohwert ist lokal noch nicht als Qualitätsgrenze kalibriert.",
  objectiveAvMotionPeakWidth:
    "Wofür: Breite des nahezu besten Lag-Bereichs. Eine schmale Spitze lokalisiert den Versatz genauer; eine breite Spitze ist zeitlich mehrdeutig. Der Wert ist eine Unsicherheitsanzeige, keine Qualitätsnote.",
  objectiveAvMotionCoverage:
    "Wofür: Anteil aufeinanderfolgender Stichproben, für die dieselbe stabilisierte Mundregion verfolgt und optische Bewegung gemessen werden konnte. Gut: bei einem sichtbaren Einzelgesicht nahe 100 %.",
  objectiveAvAudioActivity:
    "Wofür: Anteil der Audiofenster mit ausreichend strukturierter Pegel-/Onset-Aktivität. Der Wert bestätigt keine Sprache. Sehr niedrige oder nahezu durchgehend aktive Werte liefern zu wenig zeitliche Struktur; Musik kann den Rohwert verfälschen.",
  objectiveAvActivityCoverage:
    "Wofür: Anteil der erwarteten aktiven Audiozeit, für die eine kontinuierlich stabilisierte Mundbewegung vorliegt. Gut: mindestens 70 %. Der Wert verhindert, dass nur stille oder leicht verfolgbare Stellen die Lag-Schätzung tragen.",
  objectiveAvUsableActivity:
    "Wofür: Effektive Dauer der aktiven Audiozeit mit verwertbarem Mundtrack. Für den Rohproxy sind mindestens 1,0 Sekunden nötig. Mehr Dauer liefert mehr unabhängige Vergleichsfenster.",
  objectiveAvResolution:
    "Wofür: Tatsächliche zeitliche Auflösung der Lag-Suche, abgeleitet aus dem Abstand der untersuchten Videoframes. Sie ist bei 24 FPS ungefähr 42 ms und wird bei ausgedünnter Analyse gröber; kleinere Unterschiede sind nicht belastbar.",
  objectiveAvFeatureAgreement:
    "Wofür: Abstand zwischen den getrennt aus optischem Fluss und Erscheinungsänderung geschätzten Lags. Ein kleiner Wert bedeutet, dass zwei unterschiedliche Mundbewegungsmerkmale denselben Zeitbereich unterstützen.",
  objectiveAvWindowIqr:
    "Wofür: Interquartilsabstand der Lag-Schätzungen aus mehreren Zeitfenstern. Ein kleiner Wert zeigt zeitlichen Konsens über den Clip; große Werte bedeuten wechselnde oder zufällige Übereinstimmung.",
  objectiveAvNullP95:
    "Wofür: 95. Perzentil der besten Scheinkorrelationen nach kontrolliertem zyklischem Verschieben des Audios. Der echte Peak muss diesen Nullmodellwert klar übertreffen, sonst bleibt die Messung unzureichend.",
  objectivePvCapability:
    "Wofür: Prüft, ob die sichtbare Lippenbewegung zu den gesprochenen Lauten passt. Besonders wichtig: Bei p, b und m müssen sich die Lippen im richtigen Moment schließen. Prüfung aktiv bedeutet, dass diese Kontrolle automatisch ausgeführt wird.",
  objectivePvOffset:
    "Wofür: Zeitversatz des gelernten Audio-/Mundinhaltevaluators. Positiv bedeutet, dass der sichtbare Mund dem Audio folgt. Gut: Medianfehler höchstens 20 ms und p95 höchstens 40 ms auf dem unabhängigen Holdout; ein Einzelclipwert allein ist kein Release-Gate.",
  objectivePvOffsetConfidence:
    "Wofür: Kalibrierte Sicherheit der gelernten Offsetentscheidung. Gut ist nicht einfach ein hoher Rohwert, sondern eine auf unabhängigem Holdout bestandene FAR-/FRR-, Brier- und ECE-Kalibration.",
  objectivePvFrameMacroF1:
    "Wofür: Übereinstimmung der 15 sichtbaren Visemklassen zwischen Audioinhalt und Mundframes, gemittelt über Nicht-Stille-Klassen. Product-GO verlangt mindestens 0,85 insgesamt, 0,75 je kritischem Stratum und bestandene Bootstrap-Grenzen.",
  objectiveProvenanceFingerprint:
    "Wofür: SHA-256-Fingerabdruck des gesamten Laufmanifests. Er bindet verwendete Modelldateien, Eingaben, Code-Repositories und Runtime-Versionen. Nur identische Fingerprints beschreiben exakt denselben technischen Ausgangszustand.",
  objectiveProvenanceVerified:
    "Wofür: Zeitpunkt der letzten Prüfung nach dem vollständigen Render und allen Nachbearbeitungen. Nein bedeutet, dass die Ausgabe keine abgeschlossene Ende-zu-Ende-Verifikation besitzt und nicht als reproduzierbarer Vergleichslauf gelten darf.",
  objectiveProvenanceModels:
    "Wofür: Anzahl der tatsächlich vom Command-Plan referenzierten, inhaltsgehashten Modellartefakte oder Modellmanifeste. Ein Gemma-Verzeichnis zählt als ein Manifest mit allen referenzierten Shards.",
  objectiveProvenanceInputs:
    "Wofür: Anzahl der kryptografisch gebundenen Eingabedateien, etwa Konditionierungs-Audio, Endmix, Referenzbild oder Referenzvideo. Abgeleitete Studio-Assets besitzen zusätzlich ihre eigene Quell- und Transformationskette.",
  objectiveProvenanceCode:
    "Wofür: Bindet Commit, getrackten Diff und ungetrackte Dateien jedes verwendeten Code-Repositories. Ein gebundener Diff ist reproduzierbar dokumentiert, aber kein sauberer Release-Commit.",
  objectiveProvenanceRuntime:
    "Wofür: SHA-256-Fingerabdruck aus Betriebssystem, Kernel, Node, Python, FFmpeg und den relevanten Python-Paketversionen. A/B-Vergleiche werden bei unterschiedlichen Runtime-Fingerprints absichtlich nicht als direkt vergleichbar bewertet.",
  objectivePvTransitionF1:
    "Wofür: Übereinstimmung sichtbarer Visemwechsel mit einer Toleranz von einem Videoframe. Product-GO verlangt mindestens 0,90 insgesamt, 0,80 je kritischem Stratum und bestandene Bootstrap-Grenzen.",
  objectivePvRawLag:
    "Wofür: Geschätzter zeitlicher Abstand zwischen Ton und Lippenbewegung. Ein positiver Wert bedeutet, dass der Mund dem Ton hinterherläuft; ein negativer Wert bedeutet, dass sich der Mund zu früh bewegt. Eine niedrige Sicherheit macht den Wert unzuverlässig.",
  objectivePvRawLagConfidence:
    "Wofür: Eindeutigkeit des besten Roh-Lag-Peaks gegenüber dem zweitbesten Peak. Höher bedeutet nur, dass dieser Clip einen klareren Versatz liefert. Der Wert ist keine kalibrierte Wahrscheinlichkeit und keine Qualitätsnote.",
  objectivePvBilabialF1:
    "Wofür: Prüft den sichtbaren Lippenschluss bei p, b und m. 100 % bedeutet, dass sich die Lippen bei diesen Lauten passend schließen. 0 % bedeutet, dass kein passender Lippenschluss erkannt wurde.",
  objectivePvOpeningCorrelation:
    "Wofür: Pearson-Korrelation zwischen grob erwarteter Phone-Mundöffnung und der normalisierten sichtbaren Öffnung. Höher bedeutet ähnlichere zeitliche Öffnungsdynamik. Anatomie, Betonung und Kopfpose beeinflussen den unkalibrierten Rohwert.",
  objectivePvRoundingCorrelation:
    "Wofür: Pearson-Korrelation zwischen erwarteten gerundeten Lauten und MediaPipe mouthPucker/mouthFunnel. Höher bedeutet passendere zeitliche Lippenrundung. Der Rohwert benötigt kontrollierte Positiv-, Negativ- und Zeitverschiebungskalibrierung.",
  objectivePvSpeechMotion:
    "Wofür: Anteil auswertbarer Sprechframes mit sichtbarer Mundbewegung. Sehr niedrige Werte zeigen einen zu statischen Mund. 100 % beweist keine korrekten Mundformen und kann bei übertriebener Dauerbewegung ebenfalls auftreten.",
  objectivePvPauseLeak:
    "Wofür: Anteil auswertbarer Phone-Pausen mit sichtbarer Mundbewegung. Niedriger ist bei einem ruhigen Einzelsprecher meist plausibler; Atmung, Mimik und Trackingrauschen können den Rohwert erhöhen.",
  objectivePvPhoneCoverage:
    "Wofür: Zeitanteil der von MFA gelieferten Nicht-Stille-Phones, die das eingefrorene Deutsch/Englisch-Visem-Mapping kennt. Für einen brauchbaren Rohvergleich sollte der Wert mindestens 90 % betragen und es sollten keine unbekannten Phones bleiben.",
  objectivePvUnknownPhones:
    "Wofür: MFA-Phone-Symbole ohne Eintrag im eingefrorenen Visem-Mapping. Sie werden strikt aus den Inhaltsmetriken ausgeschlossen. Gute Eingabe beziehungsweise Evidenz: keine unbekannten Phones; andernfalls Mapping und Aussprachemodell getrennt prüfen.",
  objectivePvFaceTrackCoverage:
    "Wofür: Anteil der geprüften Frames mit genau einem von MediaPipe verwertbaren Gesicht. Für belastbare Rohmessungen werden mindestens 80 % erwartet; Verdeckung, Profilansicht, Unschärfe oder mehrere Gesichter senken den Wert.",
  objectivePvMouthTrackCoverage:
    "Wofür: Anteil der Frames mit verwertbarer Mundgeometrie und Mundmerkmalen. Gut ist nahe 100 %. Der Wert misst Beobachtbarkeit, nicht LipSync-Qualität.",
  objectivePvMultiFaceRatio:
    "Wofür: Anteil der Frames, in denen MediaPipe mehr als ein Gesicht erkannt hat. Für den aktuellen Einzelsprecher-Messpfad sollten höchstens 5 % auftreten, weil sonst die Sprecherzuordnung nicht belastbar ist.",
  objectivePvBlurVariance:
    "Wofür: Median der Laplace-Varianz als technischer Bildschärfe-Rohwert. Höher ist meist schärfer, hängt aber stark von Auflösung, Hauttextur und Kompression ab. Nur gleich vorbereitete Clips vergleichen.",
  objectivePvYaw:
    "Wofür: 95. Perzentil der absoluten horizontalen Kopfdrehung aus der MediaPipe-Gesichtsmatrix. Große Werte markieren Seitenansichten, bei denen Mundmetriken schwieriger werden. Noch kein kalibrierter Ausschlussgrenzwert.",
  objectivePvPitch:
    "Wofür: 95. Perzentil der absoluten vertikalen Kopfneigung aus der MediaPipe-Gesichtsmatrix. Große Werte können Mundöffnung und Tracking verzerren. Noch kein kalibrierter Ausschlussgrenzwert.",
  objectivePvUsableDuration:
    "Wofür: Tatsächlich untersuchte Dauer des auf fünf Sekunden begrenzten Messclips. Für Roh-Lag und Bewegung werden mindestens eine Sekunde und 24 verwertbare Frames verlangt; längere kontrollierte Clips liefern mehr Evidenz.",
  objectivePvSampledFrames:
    "Wofür: Anzahl der mit echten Video-PTS untersuchten Frames, höchstens 300. Gute Evidenz: mindestens 24 Frames bei konstanter 24-, 25- oder 30-FPS-Zeitbasis und hoher Trackingabdeckung.",
  objectiveDialogueCapability:
    "Wofür: Prüft mit dem lokal installierten Whisper-small-Modell, ob die hörbaren Wörter dem exakten Text aus dem Dialogfeld entsprechen, und richtet diesen Text grob an der Audiospur aus. Das misst echte Worttreue, aber keine sichtbaren Phoneme oder Visemklassen.",
  objectiveDialogueWer:
    "Wofür: Wortfehlerrate zwischen dem exakten Dialogfeld und der frei erkannten Ausgabesprache. 0 % bedeutet keine Einfügung, Auslassung oder Ersetzung. Der Rohwert kann bei vielen Einfügungen über 100 % liegen und ist noch keine kalibrierte 0-bis-10-Note.",
  objectiveDialogueWords:
    "Wofür: Zeigt frei erkannte Wörter im Verhältnis zur erwarteten Wortzahl. Gleiche Zahlen beweisen allein noch keinen identischen Wortlaut; dafür ist die Wortfehlerrate maßgeblich.",
  objectiveDialogueAlignmentCoverage:
    "Wofür: Anteil der erwarteten Wörter, für die Whisper im geführten Abgleich ein Audio-Zeitfenster liefern konnte. Gut ist nahe 100 %. Eine geführte Ausrichtung kann einen falschen oder fehlenden Laut nicht in einen richtigen verwandeln.",
  objectiveDialogueAlignmentConfidence:
    "Wofür: Median der Whisper-Tokenwahrscheinlichkeit innerhalb der geführten Wortausrichtung. Höher ist plausibler. Niedrige Werte markieren unsichere Wortfenster; es gibt noch keinen lokal kalibrierten Bestehensgrenzwert.",
  objectiveDialogueMouthCoverage:
    "Wofür: Anteil der geführten Wortfenster, in denen YuNet eine kontinuierlich stabilisierte Mundregion verfolgen konnte. Gut ist nahe 100 %. Der Wert misst Beobachtbarkeit, nicht Artikulationsrichtigkeit.",
  objectiveDialogueWordMotion:
    "Wofür: Anteil der verfolgten Wortfenster mit mindestens einem klaren Mundbewegungssignal. Sehr niedrige Werte zeigen fehlende sichtbare Artikulation. 100 % beweist noch keine korrekten Mundformen oder Phonemtreue.",
  objectiveDialoguePauseMotion:
    "Wofür: Anteil der auswertbaren Pausenstichproben mit deutlicher Mundbewegung. Niedriger ist bei einem ruhigen Einzelsprecher meist besser, kann aber durch Atmen, Mimik, Kopfbewegung oder Trackingfehler beeinflusst werden.",
  objectiveDialogueActivityLag:
    "Wofür: Grober Versatz zwischen Whisper-Wortaktivitätsfenstern und stabilisierter Mundbewegung. Positiv bedeutet Audio/Wortaktivität läuft der sichtbaren Bewegung voraus. Der Wert erscheint nur bei bestandener Korrelations- und Nullmodellprüfung und bleibt bis zu kontrollierten Verschiebungstests ein Rohwert.",
  experimentTitle:
    "Wofür: Benennt einen vorab geplanten Vergleich dauerhaft. Gute Eingabe: Pipeline, Ausgangswert und Kandidatenwert nennen, zum Beispiel 'A2V Guidance 5 gegen 3'.",
  experimentVariable:
    "Wofür: Wählt genau eine serverseitig zugelassene Änderung. Alle übrigen Request-Felder einschließlich Seed bleiben bei einer Ablation unverändert; ein Seedwechsel wird ausdrücklich als Replikat geführt.",
  experimentCandidate:
    "Wofür: Legt den Kandidatenwert vor dem ersten Lauf fest. Gute Eingabe: nur einen fachlich begründeten Wert wählen; nach dem Einfrieren kann er nicht mehr geändert werden.",
  experimentProtocolHash:
    "Wofür: Bindet Titel, beide vollständigen Requests, kontrollierte Variable und erlaubte Diff-Pfade kryptografisch. Derselbe Hash muss auf Baseline, Kandidat und späterem Vergleich liegen.",
  experimentEvidenceStatus:
    "Wofür: Trennt reproduzierbare Entwicklungsvergleiche von einem SOTA-Nachweis. Solange Phonem/Visem, ASR, Artefaktkalibration, Holdout und externer Vergleich fehlen, darf das Experiment keine 10/10-Freigabe erzeugen.",
} as const;
