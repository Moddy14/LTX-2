/**
 * Zweite Fassung des Ein-Minuten-Showcase — mit den Lehren aus dem Framing-Befund.
 *
 * Was sich gegenüber v1 ändert und warum:
 *
 * 1. DIALOGSHOTS SIND GESICHTSFÜLLEND. In v1 war das Gesicht rund 90 px hoch und
 *    der Mund keine 20 px breit; die Gesichtserkennung fand es in 3 % der Frames.
 *    Bei der Pixelmenge kann kein Lipsync-Refiner arbeiten. Jetzt bekommt jeder
 *    Dialogshot eine eigene Kameraangabe, die das Gesicht formatfüllend fordert,
 *    und eine auf einen unscharfen Halbsatz eingedampfte Umgebung. In v1 machten
 *    Umgebung und Licht zusammen den größten Teil des Prompts aus — das Modell
 *    lieferte folgerichtig die Halle statt des Gesichts.
 *
 * 2. REFERENZBILDER IM ZIELFORMAT. Ein 512×512-Porträt in einen 1280×704-Rahmen
 *    geworfen ergibt keinen Closeup. Beide Figuren liegen jetzt als 1280×704 vor,
 *    Gesicht auf rund der halben Bildhöhe, Rest als weich auslaufender Bokeh-
 *    Hintergrund aus demselben Bild. Damit ist auch Frame 0 filmisch — der
 *    Transient am Shot-Anfang fällt nicht mehr als Fremdkörper auf.
 *
 * 3. KONDITIONIERUNGSSTÄRKE 1,0 statt 0,7.
 *
 * 4. FOTO-LOOK ERZWUNGEN. Die Superman-Referenz ist ein Renaissance-Gemälde mit
 *    Craquelé und Malschicht. Ohne Gegensteuer driften die Figuren über den Clip
 *    ins Gemalte — genau der beobachtete Comic-Effekt. `photorealistic live-action
 *    film still` positiv, Malbegriffe negativ.
 *
 * 5. WIDERSPRUCH ENTFERNT. v1 forderte `static` in der Kamera und verbot
 *    gleichzeitig `static camera` im Negativprompt.
 *
 * 6. LICHT AUFS GESICHT. „cold blue moonlight" und „hard shadows" haben die
 *    Dialogshots so dunkel gemacht, dass auch die Auswertung blind wurde.
 *    Actionshots behalten die harte Nachtstimmung.
 *
 * 7. 97 STATT 129 FRAMES BEI DIALOGSHOTS. Die Sätze dauern 1,5–2,5 s; in v1 war
 *    ein Drittel des Shots Leerlauf, in dem die Figur nur driften konnte. Kürzere
 *    Shots halten außerdem den Qualitätsverfall zum Clipende klein.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import {
  createDefaultRequest,
  generationRequestSchema,
} from "/home/moddy/LTX-2/apps/ltx-studio/shared/pipelines.js";
import { withOfficialSpeechModelPaths } from "/home/moddy/LTX-2/apps/ltx-studio/shared/models.js";

const SCRATCH = "/tmp/claude-1000/-home-moddy-LTX-2/ac2cebad-2dbf-46a0-bc9a-155e1648071c/scratchpad";
const OUT_DIR = `${SCRATCH}/szene-v3`;
mkdirSync(OUT_DIR, { recursive: true });

// Beide Referenzen hat das Studio selbst erzeugt: Original hochladen über
// POST /api/uploads/image, dann POST /api/images/crop mit fit "bokeh" auf
// 1280×704. Das Ergebnis ist ein abgeleitetes Asset mit gebundener Herkunft.
//
// Nie eine Datei ins Upload-Verzeichnis kopieren: Für das Studio ist sie dann
// keine Mediathek-Referenz, die Identitätsevidenz fällt auf "unavailable"
// ("stammt nicht aus der Studio-Mediathek"), und mit ihr entfällt der
// Basis-Reuse, der eine verifizierte Identitätsbindung voraussetzt.
const REF_A = "/home/moddy/LTX-2/.ltx-studio/uploads/image/a329650d-c427-42f0-85bf-128f8ba5e716.png";
const REF_B = "/home/moddy/LTX-2/.ltx-studio/uploads/image/807530c8-c986-4c2d-b0c4-76f8b72e0f3d.png";

const A = "a woman in her late twenties with long dark wavy hair, green eyes, "
  + "high cheekbones and a small scar above her left eyebrow, wearing a worn olive field jacket";
const B = "a broad-shouldered man with black hair and a single curl on his forehead, "
  + "a square jaw and blue eyes, wearing a blue suit with a red cape and a red and yellow chest emblem";

// Dialogshots: die Halle nur noch als unscharfe Andeutung hinter der Figur.
const ENV_DIALOG = "a dark industrial workshop far behind them, completely out of focus";
const LIGHT_DIALOG = "soft warm key light on the face, clearly lit skin, gentle fill from the side, "
  + "cool rim light from behind";
// Actionshots behalten die Nachtstimmung, dort ist kein Gesicht zu lesen.
const ENV_ACTION = "inside a derelict industrial workshop at night, rusted machinery, "
  + "hanging cables, rain hammering against tall broken windows";
const LIGHT_ACTION = "a single swinging work lamp, hard shadows swinging across the walls, "
  + "cold blue moonlight through the windows, warm amber highlights on skin";

const LOOK = "photorealistic live-action film still, natural skin texture, cinematic";
const NEG_BASE = "blurry, distorted face, extra limbs, watermark, text overlay, low quality, "
  + "painting, illustration, canvas texture, brush strokes, oil painting, cartoon, anime";
const NEG_DIALOG = `${NEG_BASE}, wide shot, full body, small distant face, underexposed, dark face`;

type Shot = {
  id: string;
  source: "A" | "B" | "text";
  subject: string;
  action: string;
  camera: string;
  dialogue: string;
  ambience: string;
};

/**
 * Kameraangaben für sprechende Shots.
 *
 * v2 hatte hier "extreme close-up ... locked-off camera". Das hat den Lipsync
 * gerettet und dabei jede Handlung aus dem Bild geworfen: Die Figuren standen
 * still und redeten. Der Mund muss groß bleiben, die Kamera aber nicht.
 * Deshalb bleibt der Ausschnitt nah und bekommt Bewegung - abwechselnd, damit
 * nicht jeder Schnitt gleich aussieht.
 */
const CLOSE_PUSH = "close-up, head and shoulders in frame, shallow depth of field, "
  + "slow push in";
const CLOSE_DRIFT = "close-up, head and shoulders in frame, shallow depth of field, "
  + "slow handheld drift";
const CLOSE_ARC = "close-up, head and shoulders in frame, shallow depth of field, "
  + "camera arcs slowly around her";
const CLOSE_ARC_HIM = "close-up, head and shoulders in frame, shallow depth of field, "
  + "camera arcs slowly around him";

const SHOTS: Shot[] = [
  { id: "01-establishing", source: "text",
    subject: "a rain-soaked alley outside a derelict factory, a steel door standing ajar",
    action: "rain pours down, the door swings slowly in the wind, light spills out into the puddles",
    camera: "slow dolly push toward the open door, shallow depth of field",
    dialogue: "", ambience: "heavy rain on metal, distant thunder, a door creaking" },

  { id: "02-a-entry", source: "A",
    subject: A,
    action: "she wipes rain from her face with the back of her hand, then locks eyes with him "
      + "and speaks, lips moving clearly with every word",
    camera: CLOSE_PUSH,
    dialogue: "Du bist zu früh. Das war nicht der Plan.",
    ambience: "footsteps on wet concrete, rain outside" },

  { id: "03-b-turn", source: "B",
    subject: B,
    action: "he turns his head toward the camera, the cape shifting on his shoulder, "
      + "and speaks without blinking, lips moving clearly with every word",
    camera: CLOSE_ARC_HIM,
    dialogue: "Der Plan hat sich geändert. Vor zwanzig Minuten.",
    ambience: "metal groaning, rain against glass" },

  { id: "04-a-closeup", source: "A",
    subject: A,
    action: "she leans in, jaw tightening and eyes narrowing as she speaks, "
      + "lips moving clearly with every word",
    camera: CLOSE_PUSH,
    dialogue: "Sag mir bitte, dass du das nicht angefasst hast.",
    ambience: "swinging lamp creaking, rain" },

  { id: "05-b-case", source: "B",
    subject: B,
    action: "he glances down at his open hands, then lifts his chin and speaks, "
      + "lips moving clearly with every word",
    camera: CLOSE_DRIFT,
    dialogue: "Zu spät. Es lief schon, als ich reinkam.",
    ambience: "low electrical hum, rain" },

  { id: "06-detail-case", source: "text",
    subject: "weathered hands opening the latches of a scratched metal case",
    action: "the latches snap open one after another, cold blue light spills from inside across the fingers",
    camera: "extreme close-up, macro, shallow focus",
    dialogue: "", ambience: "two sharp metallic snaps, rising electrical whine" },

  { id: "07-a-react", source: "A",
    subject: A,
    action: "blue light hits her face from below, she flinches back half a step and shouts, "
      + "lips moving clearly with every word",
    camera: CLOSE_DRIFT,
    dialogue: "Mach es aus. Sofort.",
    ambience: "rising electrical whine, rain" },

  { id: "08-b-refuse", source: "B",
    subject: B,
    action: "he shakes his head once, shadows sweeping across his face, and speaks, "
      + "lips moving clearly with every word",
    camera: CLOSE_ARC_HIM,
    dialogue: "Wenn ich das abschalte, kommen wir hier nicht mehr raus.",
    ambience: "electrical hum, distant metal groaning" },

  { id: "08b-case-surge", source: "text",
    subject: "the open metal case on the workbench, coils glowing inside",
    action: "the blue light inside surges brighter and brighter, cables jerk taut, "
      + "the whole bench begins to vibrate",
    camera: "close-up on the case, slow push in, camera trembling",
    dialogue: "", ambience: "electrical whine rising to a scream, metal rattling" },

  { id: "09-action-lights", source: "text",
    subject: "the industrial workshop hall seen wide",
    action: "the work lamps burst one after another in a chain, sparks rain down, papers whirl up from the floor",
    camera: "wide shot, fast whip pan following the bursting lamps",
    dialogue: "", ambience: "glass shattering, electrical arcing, wind" },

  { id: "10-a-shout", source: "A",
    subject: A,
    action: "sparks fall behind her, she throws an arm up to shield her face and shouts over "
      + "her shoulder, lips moving clearly with every word",
    camera: "close-up, head and shoulders in frame, camera runs alongside her, handheld",
    dialogue: "Lauf! Zur hinteren Tür, jetzt!",
    ambience: "sparks crackling, running footsteps, alarm starting" },

  { id: "11-action-door", source: "text",
    subject: "a heavy steel door at the end of a dark corridor",
    action: "the door bursts open from the outside, blinding white light and smoke pour through the frame",
    camera: "low wide shot, camera shakes as the door hits the wall",
    dialogue: "", ambience: "steel door slamming, alarm, roaring wind" },

  // Das Finale zeigte in v2 zwei frei erfundene Figuren - Superman wurde dabei
  // fett. Zwei Personen kann die Bildkonditionierung nicht binden, also darf man
  // hier keine Gesichter sehen: echte Gegenlicht-Silhouetten im Rauch.
  { id: "12-final", source: "text",
    subject: "two backlit silhouettes in thick smoke, one slim, one broad-shouldered with a cape",
    action: "they run out through the doorway into blinding white light and rain, "
      + "only their dark outlines readable against the glare",
    camera: "wide shot from inside the hall, strong backlight, faces never visible, "
      + "camera slowly pulls back",
    dialogue: "", ambience: "alarm fading, rain, settling debris" },
];

const records: { name: string; file: string; dialog: boolean }[] = [];

for (const [index, shot] of SHOTS.entries()) {
  const spricht = shot.dialogue.length > 0;
  const request = createDefaultRequest("two-stage");
  request.width = 1280;
  request.height = 704;
  request.frameRate = 25;
  // Dialogshots kürzer: der Satz füllt sie aus, statt Leerlauf zum Driften zu lassen.
  // Das Finale darf atmen, damit der Film über die geforderte Minute kommt.
  request.numFrames = shot.id === "12-final" ? 193 : spricht ? 97 : 129;
  request.seed = 1000 + index;
  request.sourceMode = shot.source === "text" ? "text" : "image";
  request.images = shot.source === "A"
    ? [{ path: REF_A, name: "figur-a-closeup.png", frameIndex: 0, strength: 1.0, crf: 18 }]
    : shot.source === "B"
    ? [{ path: REF_B, name: "figur-b-closeup.png", frameIndex: 0, strength: 1.0, crf: 18 }]
    : [];
  const env = spricht ? ENV_DIALOG : ENV_ACTION;
  const light = spricht ? LIGHT_DIALOG : LIGHT_ACTION;
  request.promptParts = {
    subject: shot.subject,
    action: shot.action,
    environment: env,
    camera: shot.camera,
    lighting: light,
    dialogue: shot.dialogue,
    ambience: shot.ambience,
    music: "",
  };
  request.prompt = [shot.subject, shot.action, env, shot.camera, light, LOOK].join(", ");
  request.negativePrompt = spricht ? NEG_DIALOG : NEG_BASE;
  request.continuity = { project: "showcase-v3-20260808", notes: `Shot ${shot.id}` };
  request.outputName = `v3-${shot.id}.mp4`;

  const finalized = generationRequestSchema.parse(withOfficialSpeechModelPaths(request));
  const file = `${OUT_DIR}/${shot.id}.json`;
  writeFileSync(file, JSON.stringify(finalized, null, 2));
  records.push({ name: finalized.outputName, file, dialog: spricht });
  console.log(
    `OK ${shot.id.padEnd(18)} ${finalized.sourceMode.padEnd(5)} seed=${finalized.seed} `
    + `${finalized.numFrames}f ${spricht ? "DIALOG" : "-"}`,
  );
}

writeFileSync(`${OUT_DIR}/shots.json`, JSON.stringify(records, null, 2));
const frames = SHOTS.reduce(
  (sum, s) => sum + (s.id === "12-final" ? 193 : s.dialogue ? 97 : 129), 0);
console.log(`\n${SHOTS.length} Shots, ${records.filter((r) => r.dialog).length} mit Dialog, `
  + `Gesamtlaufzeit ${(frames / 25).toFixed(1)} s`);
