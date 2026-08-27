import { closeSync, fstatSync, openSync } from "node:fs";
import { EventEmitter, once } from "node:events";
import type { AddressInfo } from "node:net";

import express, { type NextFunction, type Request, type Response } from "express";
import { describe, expect, it, vi } from "vitest";

import { OutputSnapshotMaterializationError } from "../server/outputs.js";
import {
  bindHeldFileResponseRelease,
  delegateCommittedResponseError,
  finishHeldFileResponse,
  sendOutputSnapshotUnavailableResponse,
} from "../server/expressResponseSafety.js";

function responseState(options: {
  headersSent?: boolean;
  writableEnded?: boolean;
  destroyed?: boolean;
} = {}): { response: Response; destroy: ReturnType<typeof vi.fn> } {
  const destroy = vi.fn();
  return {
    response: {
      headersSent: options.headersSent ?? false,
      writableEnded: options.writableEnded ?? false,
      destroyed: options.destroyed ?? false,
      destroy,
    } as unknown as Response,
    destroy,
  };
}

function expectClosed(descriptor: number): void {
  expect(() => fstatSync(descriptor)).toThrow();
}

describe("Express response safety", () => {
  it("closes a successful held-file lease without forwarding an error", () => {
    const descriptor = openSync("/dev/null", "r");
    const next = vi.fn() as unknown as NextFunction;
    const { response, destroy } = responseState();

    finishHeldFileResponse(response, next, descriptor);

    expectClosed(descriptor);
    expect(next).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
  });

  it("uses the cache lease release callback exactly once instead of directly closing ownership", () => {
    const descriptor = openSync("/dev/null", "r");
    const next = vi.fn() as unknown as NextFunction;
    const { response } = responseState();
    const release = vi.fn(() => closeSync(descriptor));

    finishHeldFileResponse(response, next, descriptor, undefined, release);

    expect(release).toHaveBeenCalledOnce();
    expectClosed(descriptor);
    expect(next).not.toHaveBeenCalled();
  });

  it("releases exactly once when an abnormal response close races the sendFile callback", () => {
    const descriptor = openSync("/dev/null", "r");
    const response = Object.assign(new EventEmitter(), {
      headersSent: true,
      writableEnded: false,
      destroyed: false,
      destroy: vi.fn(),
    }) as unknown as Response;
    const releaseOwner = vi.fn(() => closeSync(descriptor));
    const release = bindHeldFileResponseRelease(response, descriptor, releaseOwner);

    response.emit("close");
    release();

    expect(releaseOwner).toHaveBeenCalledOnce();
    expectClosed(descriptor);
  });

  it("serves a redacted 503 with Retry-After over a real HTTP socket", async () => {
    const internal = Object.assign(
      new Error("ENOSPC at /secret/private/snapshot-root"),
      { code: "ENOSPC" },
    );
    const exposed = new OutputSnapshotMaterializationError(internal);
    const app = express();
    app.get("/snapshot", () => { throw exposed; });
    app.use((
      error: unknown,
      _request: Request,
      response: Response,
      next: NextFunction,
    ) => {
      if (sendOutputSnapshotUnavailableResponse(error, response)) return;
      next(error);
    });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/snapshot`);
      const body = await response.json();

      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("1");
      expect(body).toEqual({ error: exposed.message });
      expect(JSON.stringify(body)).not.toContain("/secret/private/snapshot-root");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error) reject(error); else resolve(); });
      });
    }
  });

  it("forwards a held-file failure while an error response can still be written", () => {
    const descriptor = openSync("/dev/null", "r");
    const next = vi.fn() as unknown as NextFunction;
    const { response, destroy } = responseState();
    const error = new Error("before headers");

    finishHeldFileResponse(response, next, descriptor, error);

    expectClosed(descriptor);
    expect(next).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith(error);
    expect(destroy).not.toHaveBeenCalled();
  });

  it("closes an incomplete committed stream instead of attempting a JSON response", () => {
    const descriptor = openSync("/dev/null", "r");
    const next = vi.fn() as unknown as NextFunction;
    const { response, destroy } = responseState({ headersSent: true });

    finishHeldFileResponse(response, next, descriptor, new Error("client aborted"));

    expectClosed(descriptor);
    expect(next).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("delegates middleware errors after a response is no longer writable", () => {
    const next = vi.fn() as unknown as NextFunction;
    const error = new Error("late failure");
    const committed = responseState({ headersSent: true }).response;
    const open = responseState().response;

    expect(delegateCommittedResponseError(error, committed, next)).toBe(true);
    expect(next).toHaveBeenCalledWith(error);
    expect(delegateCommittedResponseError(error, open, next)).toBe(false);
    expect(next).toHaveBeenCalledOnce();
  });
});
