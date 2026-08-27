import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";

import {
  createLocalStudioHostGate,
  LOCAL_STUDIO_HOST_REJECTION,
} from "../server/localStudioHostGate.js";

function invokeHostGate(host: string | undefined) {
  const request = {
    headers: host === undefined ? {} : { host },
  } as Request;
  const response = {
    status: vi.fn(),
    json: vi.fn(),
  };
  response.status.mockReturnValue(response);
  response.json.mockReturnValue(response);
  const next = vi.fn() as unknown as NextFunction;

  createLocalStudioHostGate(4_318)(request, response as unknown as Response, next);
  return { response, next };
}

describe("local Studio Host gate", () => {
  it("rejects an attacker Host without relying on an Origin header", () => {
    const { response, next } = invokeHostGate("attacker.invalid");

    expect(response.status).toHaveBeenCalledWith(403);
    expect(response.json).toHaveBeenCalledWith({ error: LOCAL_STUDIO_HOST_REJECTION });
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects a missing Host and near-miss loopback authorities", () => {
    for (const host of [undefined, "localhost", "localhost:4319", "127.0.0.2:4318", "[::1]:4318"]) {
      const { response, next } = invokeHostGate(host);
      expect(response.status, String(host)).toHaveBeenCalledWith(403);
      expect(next, String(host)).not.toHaveBeenCalled();
    }
  });

  it.each([
    "127.0.0.1:4318",
    "localhost:4318",
    "LOCALHOST:4318",
  ])("allows the configured loopback authority %s", (host) => {
    const { response, next } = invokeHostGate(host);

    expect(response.status).not.toHaveBeenCalled();
    expect(response.json).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });
});
