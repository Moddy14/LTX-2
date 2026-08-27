import { closeSync } from "node:fs";

import type { NextFunction, Response } from "express";

import {
  OutputSnapshotCapacityError,
  OutputSnapshotMaterializationError,
} from "./outputs.js";

function responseCannotAcceptHeaders(response: Response): boolean {
  return response.headersSent || response.writableEnded || response.destroyed;
}

/** Sends the shared redacted HTTP contract for retryable snapshot failures. */
export function sendOutputSnapshotUnavailableResponse(
  error: unknown,
  response: Response,
): boolean {
  if (!(error instanceof OutputSnapshotCapacityError)
    && !(error instanceof OutputSnapshotMaterializationError)) return false;
  response.setHeader("Retry-After", String(error.retryAfterSeconds));
  response.status(error.statusCode).json({ error: error.message });
  return true;
}

/**
 * Binds descriptor ownership to both the sendFile callback and the response's
 * abnormal-close event. The returned finalizer is idempotent, so either order
 * releases the cache lease exactly once.
 */
export function bindHeldFileResponseRelease(
  response: Response,
  descriptor: number,
  ownedRelease?: () => void,
): () => void {
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    response.off("close", release);
    if (ownedRelease) ownedRelease();
    else closeSync(descriptor);
  };
  response.once("close", release);
  return release;
}

/**
 * Finalizes a sendFile callback while retaining ownership of the leased file
 * descriptor. Once a response is committed, forwarding the callback error to
 * JSON middleware would attempt a second response; the only safe action for an
 * incomplete connection is to close it.
 */
export function finishHeldFileResponse(
  response: Response,
  next: NextFunction,
  descriptor: number,
  error?: Error,
  release?: () => void,
): void {
  if (release) release();
  else closeSync(descriptor);
  if (!error) return;
  if (!responseCannotAcceptHeaders(response)) {
    next(error);
    return;
  }
  if (!response.destroyed && !response.writableEnded) response.destroy();
}

/**
 * Express requires errors raised after headers were committed to be delegated
 * to its terminal handler instead of trying to serialize another response.
 */
export function delegateCommittedResponseError(
  error: unknown,
  response: Response,
  next: NextFunction,
): boolean {
  if (!responseCannotAcceptHeaders(response)) return false;
  next(error);
  return true;
}
