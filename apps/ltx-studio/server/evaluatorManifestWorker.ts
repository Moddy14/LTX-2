import { parentPort } from "node:worker_threads";

import { resolvePhonemeVisemeEvaluatorState } from "./evaluatorManifest.js";

const port = parentPort;
if (!port) throw new Error("Evaluator-Manifest-Worker benötigt einen Parent-Port.");

port.on("message", (value: unknown) => {
  if (!value || typeof value !== "object" || !("type" in value) || value.type !== "refresh") return;
  port.postMessage({
    type: "state",
    state: resolvePhonemeVisemeEvaluatorState(),
  });
});
