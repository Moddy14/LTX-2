import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import {
  blindEvaluationInitialPinSchema,
  blindEvaluationPublicSchema,
  blindEvaluationPublicStateSha256,
  type BlindEvaluationPublic,
} from "../shared/blindEvaluation";
import { finishBlindEvaluationCreation } from "./api";
import { BlindEvaluationApp } from "./components/BlindEvaluationPanel";
import "./styles.css";

const root = createRoot(document.getElementById("root")!);
const nativeFetch = window.fetch.bind(window);
const blindRoutePattern = /^\/blind-evaluation\/([^/]{1,128})\/?$/;
const scopeChannel = typeof BroadcastChannel === "function"
  ? new BroadcastChannel("ltx-studio-blind-scope-v5")
  : null;
type RootRenderMode = "bootstrapping" | "studio" | "evaluator" | "fail-closed" | "unmounted";
let rootMounted = true;
let rootRenderMode: RootRenderMode = "bootstrapping";
let failClosedNeedsRevalidation = false;
let bootstrapScopePending = true;

function unmountStudio(): void {
  if (!rootMounted) return;
  rootMounted = false;
  rootRenderMode = "unmounted";
  failClosedNeedsRevalidation = false;
  root.unmount();
}

function renderRoot(mode: Exclude<RootRenderMode, "bootstrapping" | "unmounted">, content: ReactNode): void {
  // A scope deadline or peer lock can unmount while bootstrap still awaits its
  // first response. React roots cannot be rendered again after `unmount()`.
  if (!rootMounted) return;
  rootRenderMode = mode;
  failClosedNeedsRevalidation = false;
  root.render(content);
}

function safeBlindHref(value: unknown): string {
  return typeof value === "string"
    && (value === "/"
      || /^\/blind-evaluation\/[0-9a-f-]{36}(?:#[^\r\n]*)?$/i.test(value)
      || value === "/blind-evaluation-lock")
    ? value
    : "/blind-evaluation-lock";
}

function replaceScope(hrefValue: unknown, broadcast: boolean): void {
  const href = safeBlindHref(hrefValue);
  if (`${window.location.pathname}${window.location.hash}` === href) {
    if (broadcast) scopeChannel?.postMessage({ type: "lock", href });
    if (!rootMounted) window.location.reload();
    return;
  }
  unmountStudio();
  if (broadcast) scopeChannel?.postMessage({ type: "lock", href });
  const target = new URL(href, window.location.origin);
  if (target.pathname === window.location.pathname) {
    // `location.replace()` alone is only a same-document navigation when the
    // creating and pinned routes differ by their fragment. Bootstrap must run
    // again so the durable active record and the new initial pin are checked.
    window.history.replaceState(null, "", `${target.pathname}${target.search}${target.hash}`);
    window.location.reload();
    return;
  }
  window.location.replace(href);
}

let scopeRevalidation: Promise<void> | null = null;
const BLIND_SCOPE_REQUEST_DEADLINE_MS = 500;

async function fetchScopeWithDeadline(onDeadline?: () => void): Promise<Response> {
  const controller = new AbortController();
  const deadline = window.setTimeout(() => {
    // The callback runs before the abort rejection is delivered.  The watchdog
    // uses that ordering to remove a potentially stale Studio tree
    // synchronously instead of waiting for the Fetch promise to settle.
    onDeadline?.();
    controller.abort();
  }, BLIND_SCOPE_REQUEST_DEADLINE_MS);
  try {
    return await nativeFetch("/api/blind-evaluator-scope", {
      cache: "no-store",
      signal: controller.signal,
    });
  } finally {
    window.clearTimeout(deadline);
  }
}

async function hardScopeRevalidation(): Promise<void> {
  if (scopeRevalidation) return scopeRevalidation;
  // Hide/unmount synchronously before any network wait. A stale or offline tab
  // must never keep normal Studio data visible while its scope is uncertain.
  document.documentElement.dataset.blindScopeRevalidating = "true";
  unmountStudio();
  scopeRevalidation = (async () => {
    let href = "/blind-evaluation-lock";
    try {
      const response = await fetchScopeWithDeadline();
      if (!response.ok) throw new Error("scope unavailable");
      const scope = await response.json() as { locked?: unknown; evaluation?: unknown };
      if (scope.locked === false && scope.evaluation === null) {
        href = "/";
      } else if (scope.locked === true && scope.evaluation !== null && scope.evaluation !== undefined) {
        const evaluation = blindEvaluationPublicSchema.parse(scope.evaluation);
        href = await navigationFor(evaluation);
      }
    } catch {
      // The dedicated lock route bootstraps fail-closed and retries no Studio API.
    }
    replaceScope(href, true);
  })();
  return scopeRevalidation;
}

window.fetch = (async (...args: Parameters<typeof fetch>) => {
  const requestedUrl = typeof args[0] === "string"
    ? args[0]
    : args[0] instanceof URL
      ? args[0].href
      : args[0].url;
  const requestedPath = new URL(requestedUrl, window.location.origin).pathname;
  try {
    const response = await nativeFetch(...args);
    const normalStudioVisible = rootRenderMode === "studio";
    if (normalStudioVisible && (response.status === 423 || response.status === 403)) {
      // The server's evaluator gate uses 423 for an unscoped peer and 403 for
      // a scoped evaluator requesting Studio data. Unmount synchronously when
      // either state is observed; navigation/recovery may continue afterward.
      void hardScopeRevalidation();
    }
    return response;
  } catch (error) {
    if (requestedPath === "/api/blind-evaluator-scope"
      && rootRenderMode !== "bootstrapping"
      && rootRenderMode !== "fail-closed") {
      // A scope-network failure is uncertainty, never permission to leave
      // names/settings mounted in an already visible Studio peer.
      void hardScopeRevalidation();
    }
    throw error;
  }
}) as typeof window.fetch;

const BLIND_SCOPE_WATCHDOG_INTERVAL_MS = 750;
let scopeWatchdogRunning = false;
window.setInterval(() => {
  if (scopeWatchdogRunning || scopeRevalidation || !rootMounted) return;
  scopeWatchdogRunning = true;
  let deadlineTriggered = false;
  void fetchScopeWithDeadline(() => {
    deadlineTriggered = true;
    // A fail-closed tree already exposes no Studio data. Keep its recovery UI
    // stable while the scope is still unavailable and retry on the next tick.
    if (rootRenderMode !== "fail-closed") void hardScopeRevalidation();
  })
    .then(async (response) => {
      if (!response.ok) throw new Error(`scope watchdog HTTP ${response.status}`);
      const scope = await response.json() as { locked?: unknown; evaluation?: unknown };
      const currentBlindRoute = blindRoutePattern.exec(window.location.pathname);
      const parsedEvaluation = scope.evaluation === null || scope.evaluation === undefined
        ? null
        : blindEvaluationPublicSchema.safeParse(scope.evaluation);
      const expectedEvaluatorScope = currentBlindRoute !== null
        && scope.locked === true
        && parsedEvaluation?.success === true
        && parsedEvaluation.data.id === decodeURIComponent(currentBlindRoute[1]!);
      const expectedStudioScope = currentBlindRoute === null
        && window.location.pathname !== "/blind-evaluation-lock"
        && scope.locked === false
        && scope.evaluation === null;
      const expectedFailClosedLock = window.location.pathname === "/blind-evaluation-lock"
        && scope.locked === true
        && (parsedEvaluation === null || parsedEvaluation.success === false);
      if (bootstrapScopePending || failClosedNeedsRevalidation
        || (!expectedEvaluatorScope && !expectedStudioScope && !expectedFailClosedLock)) {
        // Detection is complete at this point; remove the visible peer before
        // any pin calculation or route transition can await.
        void hardScopeRevalidation();
      }
    })
    .catch(() => {
      if (!deadlineTriggered && rootRenderMode !== "fail-closed") void hardScopeRevalidation();
    })
    .finally(() => { scopeWatchdogRunning = false; });
}, BLIND_SCOPE_WATCHDOG_INTERVAL_MS);

let scopeNeedsRevalidation = false;
window.addEventListener("blur", () => { scopeNeedsRevalidation = true; });
window.addEventListener("pagehide", () => { scopeNeedsRevalidation = true; });
window.addEventListener("focus", () => {
  if (scopeNeedsRevalidation) void hardScopeRevalidation();
}, { capture: true });
window.addEventListener("pageshow", (event) => {
  if (event.persisted || scopeNeedsRevalidation) void hardScopeRevalidation();
}, { capture: true });
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") scopeNeedsRevalidation = true;
  else if (scopeNeedsRevalidation) void hardScopeRevalidation();
}, { capture: true });

scopeChannel?.addEventListener("message", (event: MessageEvent<unknown>) => {
  const value = event.data !== null && typeof event.data === "object"
    ? (event.data as { type?: unknown; href?: unknown })
    : null;
  if (value?.type === "lock") replaceScope(value.href, false);
});

window.addEventListener("ltx-studio:hard-navigation", (event) => {
  const href = event instanceof CustomEvent ? (event.detail as { href?: unknown } | null)?.href : null;
  replaceScope(href, true);
});

async function navigationFor(evaluation: BlindEvaluationPublic): Promise<string> {
  if (evaluation.status === "creating") {
    const fragment = new URLSearchParams({ id: evaluation.id, creating: "v5" });
    return `/blind-evaluation/${encodeURIComponent(evaluation.id)}#${fragment.toString()}`;
  }
  const pin = blindEvaluationInitialPinSchema.parse({
    schemaVersion: "ltx-studio-blind-evaluation-initial-pin.v5",
    id: evaluation.id,
    commitment: evaluation.commitment,
    publicStateSha256: await blindEvaluationPublicStateSha256(evaluation),
  });
  const fragment = new URLSearchParams({
    id: pin.id,
    commitment: pin.commitment,
    publicStateSha256: pin.publicStateSha256,
  });
  return `/blind-evaluation/${encodeURIComponent(pin.id)}#${fragment.toString()}`;
}

function renderFailClosed(message: string, revalidateWhenHealthy = false): void {
  if (!rootMounted) return;
  renderRoot(
    "fail-closed",
    <StrictMode>
      <main className="blind-evaluation-scope" data-evaluator-role="blind-evaluator">
        <div className="blind-evaluation" role="alert">
          <h1>Blind-Evaluator-Lock</h1>
          <p>{message}</p>
          <button type="button" className="button" onClick={() => window.location.reload()}>
            Scope erneut prüfen
          </button>
        </div>
      </main>
    </StrictMode>,
  );
  failClosedNeedsRevalidation = revalidateWhenHealthy;
}

async function bootstrap(): Promise<void> {
  const blindRoute = blindRoutePattern.exec(window.location.pathname);
  let scope: { locked?: unknown; evaluation?: unknown };
  try {
    const response = await fetch("/api/blind-evaluator-scope", { cache: "no-store" });
    if (!response.ok) throw new Error("Scope-Status nicht verfügbar.");
    scope = await response.json() as { locked?: unknown; evaluation?: unknown };
    bootstrapScopePending = false;
  } catch {
    bootstrapScopePending = false;
    renderFailClosed("Der Evaluator-Scope konnte vor dem App-Start nicht sicher geprüft werden.", true);
    return;
  }

  if (blindRoute) {
    const scopeEvaluation = scope.evaluation === null || scope.evaluation === undefined
      ? null
      : blindEvaluationPublicSchema.safeParse(scope.evaluation);
    if (scope.locked !== true || !scopeEvaluation || !scopeEvaluation.success
      || scopeEvaluation.data.id !== decodeURIComponent(blindRoute[1]!)) {
      renderFailClosed("Evaluator-Cookie, Route und serverseitiger v5-Scope sind nicht identisch gebunden.");
      return;
    }
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const creatingRoute = fragment.get("creating") === "v5"
      && fragment.get("id") === scopeEvaluation.data.id
      && [...fragment.keys()].every((key) => key === "id" || key === "creating");
    if (scopeEvaluation.data.status === "creating") {
      if (!creatingRoute) {
        renderFailClosed("Die v5-Reservation besitzt keine identisch gebundene Creating-Route.");
        return;
      }
      renderRoot(
        "evaluator",
        <StrictMode>
          <BlindEvaluationApp
            routeSessionId={decodeURIComponent(blindRoute[1]!)}
            initialPin={null}
            initialEvaluation={scopeEvaluation.data}
          />
        </StrictMode>,
      );
      return;
    }
    // Bootstrap can observe the durable active record before the initiating
    // component receives its claim response. The one-shot capability is no
    // longer needed and must not survive that race in session storage.
    finishBlindEvaluationCreation(scopeEvaluation.data.id);
    if (creatingRoute) {
      if (scopeEvaluation.data.status !== "active") {
        renderFailClosed("Eine bereits terminale v5-Session darf keinen neuen initialen Pin erhalten.");
        return;
      }
      replaceScope(await navigationFor(scopeEvaluation.data), true);
      return;
    }
    const parsedPin = blindEvaluationInitialPinSchema.safeParse({
      schemaVersion: "ltx-studio-blind-evaluation-initial-pin.v5",
      id: fragment.get("id"),
      commitment: fragment.get("commitment"),
      publicStateSha256: fragment.get("publicStateSha256"),
    });
    renderRoot(
      "evaluator",
      <StrictMode>
        <BlindEvaluationApp
          routeSessionId={decodeURIComponent(blindRoute[1]!)}
          initialPin={parsedPin.success ? parsedPin.data : null}
          initialEvaluation={scopeEvaluation.data}
        />
      </StrictMode>,
    );
    return;
  }

  try {
    if (scope.locked === true) {
      if (scope.evaluation !== null && scope.evaluation !== undefined) {
        const evaluation = blindEvaluationPublicSchema.parse(scope.evaluation);
        replaceScope(await navigationFor(evaluation), true);
        return;
      }
      renderFailClosed("Der Studio-Scope bleibt serverseitig gesperrt; normale App-Daten wurden nicht geladen.");
      return;
    }
    if (scope.locked !== false || scope.evaluation !== null) {
      throw new Error("Scope-Status ist strukturell ungültig.");
    }
  } catch {
    renderFailClosed("Der Evaluator-Scope konnte vor dem App-Start nicht sicher ausgeschlossen werden.");
    return;
  }

  const { App } = await import("./App");
  renderRoot(
    "studio",
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void bootstrap();
