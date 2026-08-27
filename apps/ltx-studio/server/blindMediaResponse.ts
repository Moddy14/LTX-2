import { closeSync, createReadStream } from "node:fs";

import type { Request, Response } from "express";

import type { BlindEvaluationMediaLease } from "./blindEvaluationStore.js";
import { assertBlindEvaluationMediaLeaseIntegrity } from "./blindEvaluationStore.js";

type ByteRange = { start: number; end: number };

function requestedRange(header: string | undefined, sizeBytes: number): ByteRange | null | "invalid" {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "")) return "invalid";
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return "invalid";
    return { start: Math.max(0, sizeBytes - suffix), end: sizeBytes - 1 };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] === "" ? sizeBytes - 1 : Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd)
    || start < 0 || requestedEnd < start || start >= sizeBytes) return "invalid";
  return { start, end: Math.min(requestedEnd, sizeBytes - 1) };
}

/**
 * Streams only a fully copied, fsync'd and unlinked anonymous lease descriptor.
 * The committed session inode is never the response source, so path replacement
 * or same-inode mutation after lease creation cannot alter delivered bytes.
 */
export function sendVerifiedBlindEvaluationMedia(
  request: Request,
  response: Response,
  lease: BlindEvaluationMediaLease,
): void {
  let closed = false;
  const closeLease = () => {
    if (closed) return;
    closed = true;
    lease.releaseResponse();
    closeSync(lease.fd);
  };
  if (request.method !== "GET") {
    closeLease();
    response.setHeader("Allow", "GET");
    response.status(405).json({ error: "Blind-v5-Medien erlauben ausschließlich GET." });
    return;
  }
  try {
    assertBlindEvaluationMediaLeaseIntegrity(lease, false);
  } catch {
    closeLease();
    response.status(409).json({ error: "Der private Blind-Snapshot stimmt nicht mehr mit seinem Commitment überein." });
    return;
  }
  const range = requestedRange(request.headers.range, lease.sizeBytes);
  response.setHeader("Accept-Ranges", "bytes");
  response.setHeader("Cache-Control", "private, no-store");
  response.setHeader("Content-Disposition", "inline");
  response.setHeader("Content-Type", lease.mimeType);
  response.setHeader("X-Content-Type-Options", "nosniff");
  if (range === "invalid") {
    closeLease();
    response.setHeader("Content-Range", `bytes */${lease.sizeBytes}`);
    response.status(416).end();
    return;
  }
  const selected = range ?? { start: 0, end: lease.sizeBytes - 1 };
  const contentLength = selected.end - selected.start + 1;
  try {
    lease.reserveResponseBytes(contentLength);
  } catch (error) {
    closeLease();
    const status = error !== null && typeof error === "object" && "statusCode" in error
      && (error as { statusCode?: unknown }).statusCode === 429 ? 429 : 409;
    response.status(status).json({ error: error instanceof Error ? error.message : "v5-Media-Budget erschöpft." });
    return;
  }
  if (range) {
    response.status(206);
    response.setHeader("Content-Range", `bytes ${selected.start}-${selected.end}/${lease.sizeBytes}`);
  }
  response.setHeader("Content-Length", String(contentLength));
  const stream = createReadStream("", {
    fd: lease.fd,
    autoClose: false,
    start: selected.start,
    end: selected.end,
  });
  const lifetimeTimer = setTimeout(() => {
    if (!response.writableEnded) stream.destroy(new Error("v5-Media-Lease-Lifetime überschritten."));
  }, Math.max(1, lease.responseDeadlineAtMs - Date.now()));
  lifetimeTimer.unref();
  stream.on("error", () => {
    clearTimeout(lifetimeTimer);
    closeLease();
    if (response.headersSent) response.destroy();
    else response.status(409).json({ error: "Der private Blind-Snapshot ist nicht mehr verfügbar." });
  });
  stream.on("end", () => {
    clearTimeout(lifetimeTimer);
    try {
      assertBlindEvaluationMediaLeaseIntegrity(lease, false);
      closeLease();
      response.end();
    } catch {
      closeLease();
      if (response.headersSent) response.destroy();
      else response.status(409).json({ error: "Der private Blind-Snapshot änderte sich während der Auslieferung." });
    }
  });
  stream.on("close", () => {
    clearTimeout(lifetimeTimer);
    closeLease();
  });
  request.on("aborted", () => stream.destroy());
  response.on("close", () => {
    if (!response.writableEnded) stream.destroy();
  });
  stream.pipe(response, { end: false });
}
