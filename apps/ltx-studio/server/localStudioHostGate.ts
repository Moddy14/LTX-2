import type { RequestHandler } from "express";

export const LOCAL_STUDIO_HOST_REJECTION =
  "Nur der exakt lokale LTX-Studio-Host darf Anfragen senden." as const;

export function allowedLocalStudioHosts(port: number): ReadonlySet<string> {
  return new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
  ]);
}

/**
 * Reject DNS-rebinding and forged-Host requests before any route or other
 * middleware can disclose local state. The server binds only IPv4 loopback,
 * so an IPv6 literal is deliberately not part of this authority boundary.
 */
export function createLocalStudioHostGate(port: number): RequestHandler {
  const allowedHosts = allowedLocalStudioHosts(port);
  return (request, response, next) => {
    const host = request.headers.host;
    if (typeof host !== "string" || !allowedHosts.has(host.toLowerCase())) {
      response.status(403).json({ error: LOCAL_STUDIO_HOST_REJECTION });
      return;
    }
    next();
  };
}
