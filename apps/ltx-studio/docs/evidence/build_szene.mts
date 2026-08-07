/**
 * Baut die Shot-Requests für das Ein-Minuten-Showcase-Video.
 *
 * Aufbau: 12 Shots à 129 Frames @ 25 fps (5,16 s) = 61,9 s Gesamtlaufzeit.
 * Dialogszene zwischen zwei Figuren mit Action-Beats dazwischen.
 *
 * Identität: Figur A läuft als I2V über das vorhandene, verifizierte
 * Referenzporträt (Erstframe). Figur B und alle Shots ohne erkennbares
 * Gesicht laufen als T2V mit identischer Figurenbeschreibung.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import {
  createDefaultRequest,
  generationRequestSchema,
} from "/home/moddy/LTX-2/apps/ltx-studio/shared/pipelines.js";
import { withOfficialSpeechModelPaths } from "/home/moddy/LTX-2/apps/ltx-studio/shared/models.js";

const SCRATCH = "/tmp/claude-1000/-home-moddy-LTX-2/9dd5dabc-5f25-4618-b983-4cbc7db4c60a/scratchpad";
const OUT_DIR = `${SCRATCH}/szene`;
mkdirSync(OUT_DIR, { recursive: true });

const REF_A = "/home/moddy/LTX-2/.ltx-studio/uploads/image/1f5e3589-994b-4f8d-bc8d-0558407493dc.png";
const REF_B = "/tmp/claude-1000/-home-moddy-LTX-2/9dd5dabc-5f25-4618-b983-4cbc7db4c60a/scratchpad/figur-b-superman-1280x704.png";

// Feste Figurenbeschreibungen — wortgleich in jedem Shot, damit die Modelle
// nicht bei jedem Schnitt eine neue Person erfinden.
const A = "a woman in her late twenties with long dark wavy hair, green eyes, "
  + "high cheekbones and a small scar above her left eyebrow, wearing a worn olive field jacket";
const B = "a broad-shouldered man with black hair and a single curl on his forehead, "
  + "a square jaw and blue eyes, wearing a blue suit with a red cape and a red and yellow chest emblem";

const ENV = "inside a derelict industrial workshop at night, rusted machinery, "
  + "hanging cables, rain hammering against tall broken windows";
const LIGHT = "a single swinging work lamp, hard shadows swinging across the walls, "
  + "cold blue moonlight through the windows, warm amber highlights on skin";

type Shot = {
  id: string;
  source: "A" | "B" | "text";
  subject: string;
  action: string;
  camera: string;
  dialogue: string;
  ambience: string;
};

const SHOTS: Shot[] = [
  { id: "01-establishing", source: "text",
    subject: "a rain-soaked alley outside a derelict factory, a steel door standing ajar",
    action: "rain pours down, the door swings slowly in the wind, light spills out into the puddles",
    camera: "slow dolly push toward the open door, shallow depth of field",
    dialogue: "", ambience: "heavy rain on metal, distant thunder, a door creaking" },

  { id: "02-a-entry", source: "A",
    subject: A,
    action: "she steps through the doorway, pushes wet hair from her face and scans the dark hall",
    camera: "medium shot, handheld, slight camera shake as she moves",
    dialogue: "Du bist zu früh. Das war nicht der Plan.",
    ambience: "footsteps on wet concrete, rain outside" },

  { id: "03-b-turn", source: "B",
    subject: B,
    action: "he lowers his head and turns to face the camera, the cape shifting on his shoulders, "
      + "rain-lit workshop darkness closing in behind him",
    camera: "medium close-up, slow push in",
    dialogue: "Der Plan hat sich geändert. Vor zwanzig Minuten.",
    ambience: "metal groaning, rain against glass" },

  { id: "04-a-closeup", source: "A",
    subject: A,
    action: "she steps closer into the lamplight, jaw tight, eyes narrowing",
    camera: "close-up, static, lamp swinging behind her",
    dialogue: "Sag mir bitte, dass du das nicht angefasst hast.",
    ambience: "swinging lamp creaking, rain" },

  { id: "05-b-case", source: "B",
    subject: B,
    action: "he steps forward into the swinging lamplight and glances down at a battered metal case on the workbench",
    camera: "medium shot from a low angle, lamp flaring into the lens",
    dialogue: "Zu spät. Es lief schon, als ich reinkam.",
    ambience: "low electrical hum, rain" },

  { id: "06-detail-case", source: "text",
    subject: "weathered hands opening the latches of a scratched metal case",
    action: "the latches snap open one after another, cold blue light spills from inside across the fingers",
    camera: "extreme close-up, macro, shallow focus",
    dialogue: "", ambience: "two sharp metallic snaps, rising electrical whine" },

  { id: "07-a-react", source: "A",
    subject: A,
    action: "blue light hits her face from below, she takes half a step back, breathing faster",
    camera: "close-up, slow handheld drift",
    dialogue: "Mach es aus. Sofort.",
    ambience: "rising electrical whine, rain" },

  { id: "08-b-refuse", source: "B",
    subject: B,
    action: "he shakes his head slowly, jaw set, shadows swinging across his face, "
      + "then his eyes narrow as he looks past the camera",
    camera: "close-up, static, hard side light",
    dialogue: "Wenn ich das abschalte, kommen wir hier nicht mehr raus.",
    ambience: "electrical hum, distant metal groaning" },

  { id: "09-action-lights", source: "text",
    subject: "the industrial workshop hall seen wide",
    action: "the work lamps burst one after another in a chain, sparks rain down, papers whirl up from the floor",
    camera: "wide shot, fast whip pan following the bursting lamps",
    dialogue: "", ambience: "glass shattering, electrical arcing, wind" },

  { id: "10-a-shout", source: "A",
    subject: A,
    action: "she shields her face from falling sparks and shouts over her shoulder while running",
    camera: "handheld tracking shot running alongside her",
    dialogue: "Lauf! Zur hinteren Tür, jetzt!",
    ambience: "sparks crackling, running footsteps, alarm starting" },

  { id: "11-action-door", source: "text",
    subject: "a heavy steel door at the end of a dark corridor",
    action: "the door bursts open from the outside, blinding white light and smoke pour through the frame",
    camera: "low wide shot, camera shakes as the door hits the wall",
    dialogue: "", ambience: "steel door slamming, alarm, roaring wind" },

  { id: "12-final", source: "text",
    subject: `${A}, and beside her ${B}, both silhouetted against the smoke`,
    action: "they run out through the doorway into the rain and the camera holds on the empty smoking hall",
    camera: "wide shot, camera slowly pulls back, smoke drifting through the frame",
    dialogue: "", ambience: "alarm fading, rain, settling debris" },
];

const records: { name: string; file: string }[] = [];

for (const [index, shot] of SHOTS.entries()) {
  const request = createDefaultRequest("two-stage");
  request.width = 1280;
  request.height = 704;
  request.frameRate = 25;
  request.numFrames = 129;               // 5,16 s je Shot -> 12 Shots = 61,9 s
  request.seed = 1000 + index;           // fester, dokumentierter Seed je Shot
  request.sourceMode = shot.source === "text" ? "text" : "image";
  request.images = shot.source === "A"
    ? [{ path: REF_A, name: "figur-a-referenz.png", frameIndex: 0, strength: 0.7, crf: 18 }]
    : shot.source === "B"
    ? [{ path: REF_B, name: "figur-b-superman.png", frameIndex: 0, strength: 0.7, crf: 18 }]
    : [];
  request.promptParts = {
    subject: shot.subject,
    action: shot.action,
    environment: ENV,
    camera: shot.camera,
    lighting: LIGHT,
    dialogue: shot.dialogue,
    ambience: shot.ambience,
    music: "",
  };
  request.prompt = [shot.subject, shot.action, ENV, shot.camera, LIGHT].join(", ");
  request.negativePrompt = "blurry, distorted face, extra limbs, watermark, text overlay, "
    + "static camera, cartoon, low quality";
  request.continuity = { project: "showcase-60s-20260807", notes: `Shot ${shot.id}` };
  request.outputName = `szene-${shot.id}-20260807.mp4`;

  const finalized = generationRequestSchema.parse(withOfficialSpeechModelPaths(request));
  const file = `${OUT_DIR}/${shot.id}.json`;
  writeFileSync(file, JSON.stringify(finalized, null, 2));
  records.push({ name: finalized.outputName, file });
  console.log(
    `OK ${shot.id.padEnd(18)} ${finalized.sourceMode.padEnd(5)} seed=${finalized.seed} `
    + `${finalized.width}x${finalized.height} ${finalized.numFrames}f@${finalized.frameRate} `
    + `${shot.dialogue ? "DIALOG" : "-"}`,
  );
}

writeFileSync(`${OUT_DIR}/shots.json`, JSON.stringify(records, null, 2));
const seconds = (SHOTS.length * 129) / 25;
console.log(`\n${SHOTS.length} Shots, Gesamtlaufzeit ${seconds.toFixed(1)} s`);
