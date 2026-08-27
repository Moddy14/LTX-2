const SESSION = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const SESSION_ROOT = new RegExp(`^/api/blind-evaluations/${SESSION}$`, "i");
const MEDIA = new RegExp(`^/api/blind-evaluations/${SESSION}/media/[xy]$`, "i");
const MUTATION = new RegExp(`^/api/blind-evaluations/${SESSION}/(?:claim|submission|abort)$`, "i");
const RELEASE = new RegExp(`^/api/blind-evaluations/${SESSION}/scope/release$`, "i");

export type BlindV5ApiGateRejection = {
  status: 403 | 404 | 405 | 423;
  error: string;
  allow?: string;
};

export type BlindV5ApiGateResult = {
  locked: boolean;
  rejection: BlindV5ApiGateRejection | null;
};

export function blindV5AllowedMethods(path: string): readonly string[] | null {
  if (path === "/api/blind-evaluator-scope") return ["GET"];
  if (path === "/api/blind-evaluations") return ["POST"];
  if (SESSION_ROOT.test(path)) return ["GET"];
  if (MEDIA.test(path)) return ["GET"];
  if (MUTATION.test(path) || RELEASE.test(path)) return ["POST"];
  return null;
}

function isBlindV5ApiPath(path: string): boolean {
  return blindV5AllowedMethods(path) !== null;
}

function capabilityAllows(path: string): boolean {
  return path === "/api/blind-evaluator-scope"
    || path === "/api/blind-evaluations"
    || SESSION_ROOT.test(path)
    || MEDIA.test(path)
    || MUTATION.test(path)
    || RELEASE.test(path);
}

export function evaluateBlindV5ApiGate({
  path,
  method,
  capabilityCookiePresent,
  readGlobalLock,
}: {
  path: string;
  method: string;
  capabilityCookiePresent: boolean;
  readGlobalLock: () => boolean;
}): BlindV5ApiGateResult {
  const allowedMethods = blindV5AllowedMethods(path);
  if (allowedMethods && !allowedMethods.includes(method)) {
    return {
      locked: false,
      rejection: {
        status: 405,
        error: "Methode ist für diesen Blind-v5-Pfad nicht erlaubt.",
        allow: allowedMethods.join(", "),
      },
    };
  }
  if (!allowedMethods
    && (path === "/api/blind-evaluator-scope" || path.startsWith("/api/blind-evaluations"))) {
    return {
      locked: false,
      rejection: { status: 404, error: "Blind-v5-API-Pfad nicht gefunden." },
    };
  }

  let locked = false;
  if (path.startsWith("/api/")) {
    try {
      locked = readGlobalLock();
    } catch {
      return {
        locked: true,
        rejection: {
          status: 423,
          error: "Der persistente globale v5-Blind-Evaluator-Zustand ist beschädigt; die Studio-API bleibt gesperrt.",
        },
      };
    }
  }
  if (locked && path.startsWith("/api/") && !isBlindV5ApiPath(path)) {
    return {
      locked,
      rejection: {
        status: 423,
        error: path === "/api/events"
          ? "Studio-Ereignisse sind während des v5-Evaluator-Scopes gesperrt."
          : "Der persistente globale v5-Blind-Evaluator-Lock sperrt die Studio-API.",
      },
    };
  }
  if (capabilityCookiePresent && !capabilityAllows(path)) {
    return {
      locked,
      rejection: {
        status: 403,
        error: "Die Blind-Evaluator-Capability ist auf diese Session beschränkt.",
      },
    };
  }
  return { locked, rejection: null };
}
