/**
 * Casting-Shots: Jede Figur einmal in der echten Szene, damit die
 * Bildkonditionierung eine Referenz aus derselben Welt bekommt.
 *
 * Moddys Befund zu v3: "diese Referenz-Bilder passen nicht zu dem Video."
 * Das trifft die Ursache des Anlaufsprungs. Das Porträt ist ein helles, warmes
 * Studiobild, die Superman-Vorlage ein Renaissance-Gemälde - der Film spielt
 * nachts in einer verregneten Halle. Frame 0 zeigt Welt A, der Prompt fordert
 * Welt B, und an dieser Naht bricht das Bild um (gemessen: bis zum 87-fachen
 * der übrigen Bildänderung).
 *
 * Diese beiden Shots erzeugen die fehlende Zwischenstufe. Superman bekommt
 * seine Vorlage als Ausgangspunkt, damit er erkennbar bleibt, landet aber im
 * Regenlicht der Halle. Die Frau läuft ohne Vorlage: Ihre Identität muss nicht
 * einer Vorgabe entsprechen, sondern über den Film konstant bleiben - und
 * genau das leistet der Frame aus der Szene besser als ein fremdes Porträt.
 *
 * Aus dem Ergebnis nimmt POST /api/images/from-output den besten Frame; der
 * wird die Referenz für alle Dialogshots in v4.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import {
  createDefaultRequest,
  generationRequestSchema,
} from "/home/moddy/LTX-2/apps/ltx-studio/shared/pipelines.js";
import { withOfficialSpeechModelPaths } from "/home/moddy/LTX-2/apps/ltx-studio/shared/models.js";

const SCRATCH = "/tmp/claude-1000/-home-moddy-LTX-2/ac2cebad-2dbf-46a0-bc9a-155e1648071c/scratchpad";
const OUT_DIR = `${SCRATCH}/casting`;
mkdirSync(OUT_DIR, { recursive: true });

// Die Superman-Vorlage als Ausgangspunkt - sie muss die Figur liefern, nicht die Welt.
const REF_B = "/home/moddy/LTX-2/.ltx-studio/uploads/image/807530c8-c986-4c2d-b0c4-76f8b72e0f3d.png";

const A = "a woman in her late twenties with long dark wavy hair, green eyes, "
  + "high cheekbones and a small scar above her left eyebrow, wearing a worn olive field jacket";
const B = "a broad-shouldered man with black hair and a single curl on his forehead, "
  + "a square jaw and blue eyes, wearing a blue suit with a red cape and a red and yellow chest emblem";

// Genau die Welt, in der der Film spielt - sonst wäre nichts gewonnen.
const ENV = "inside a derelict industrial workshop at night, rusted machinery and hanging cables "
  + "behind her, rain hammering against tall broken windows";
const LIGHT = "a single work lamp above her, warm light falling on the face, "
  + "cold blue moonlight from the windows behind";
const LOOK = "photorealistic live-action film still, natural skin texture, cinematic";
const NEG = "blurry, distorted face, extra limbs, watermark, text overlay, low quality, "
  + "painting, illustration, canvas texture, brush strokes, oil painting, cartoon, anime, "
  + "wide shot, full body, small distant face";

type Casting = { id: string; subject: string; ref: string | null; seed: number };

const CASTINGS: Casting[] = [
  { id: "casting-a", subject: A, ref: null, seed: 2001 },
  { id: "casting-b", subject: B, ref: REF_B, seed: 2002 },
];

const records: { name: string; file: string }[] = [];

for (const casting of CASTINGS) {
  const request = createDefaultRequest("two-stage");
  request.width = 1280;
  request.height = 704;
  request.frameRate = 25;
  // Kurz: Es geht nur um einen brauchbaren Frame, nicht um einen Filmausschnitt.
  request.numFrames = 65;
  request.seed = casting.seed;
  request.sourceMode = casting.ref ? "image" : "text";
  request.images = casting.ref
    ? [{ path: casting.ref, name: "vorlage.png", frameIndex: 0, strength: 1.0, crf: 18 }]
    : [];
  const environment = casting.ref ? ENV.replaceAll("her", "him") : ENV;
  const lighting = casting.ref ? LIGHT.replaceAll("her", "him") : LIGHT;
  request.promptParts = {
    subject: casting.subject,
    action: "standing still, looking straight into the camera, calm expression, not speaking",
    environment,
    camera: "close-up, head and shoulders, shallow depth of field, locked-off camera",
    lighting,
    dialogue: "",
    ambience: "rain on metal, low electrical hum",
    music: "",
  };
  request.prompt = [
    casting.subject,
    "standing still, looking straight into the camera, calm expression",
    environment,
    "close-up, head and shoulders, shallow depth of field",
    lighting,
    LOOK,
  ].join(", ");
  request.negativePrompt = NEG;
  request.continuity = { project: "casting-20260808", notes: `Referenzfindung ${casting.id}` };
  request.outputName = `${casting.id}.mp4`;

  const finalized = generationRequestSchema.parse(withOfficialSpeechModelPaths(request));
  const file = `${OUT_DIR}/${casting.id}.json`;
  writeFileSync(file, JSON.stringify(finalized, null, 2));
  records.push({ name: finalized.outputName, file });
  console.log(`OK ${casting.id}  ${finalized.sourceMode}  seed=${finalized.seed}  `
    + `${finalized.numFrames}f`);
}

writeFileSync(`${OUT_DIR}/castings.json`, JSON.stringify(records, null, 2));
console.log(`\n${CASTINGS.length} Casting-Shots vorbereitet`);
