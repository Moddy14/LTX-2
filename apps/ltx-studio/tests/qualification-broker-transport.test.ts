import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  UnixQualificationBrokerTransport,
  type QualificationBrokerRequest,
} from "../server/qualificationBroker.js";

const roots: string[] = [];
const servers: Server[] = [];
const sha = (character: string) => character.repeat(64);

function request(): QualificationBrokerRequest {
  return {
    schemaVersion: "ltx-studio-qualification-broker-request.v1",
    requestId: "00000000-0000-4000-8000-000000000200",
    action: "accept",
    requestedAt: "2026-08-15T00:05:00Z",
    expectedGeneration: 1,
    expectedHeadSha256: sha("a"),
    expectedReleaseDigest: sha("b"),
    expectedSurfaceDigest: sha("c"),
    claim: {
      authorizationDigest: sha("d"),
      authorizationId: "qualification-r0l-001",
      authorizationNonce: "e".repeat(32),
      ticketId: "r0l-ticket-001",
      ticketNonce: "f".repeat(32),
      purposeId: "r0l-live-canary",
      phaseId: "r0l",
      matrixDigest: sha("0"),
      surfaceEntryId: "native-generation.text-to-video",
      inputDigest: sha("1"),
      seed: 42,
    },
    terminal: null,
  };
}

async function listen(handler: (payload: string) => string | null): Promise<{ root: string; socketPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "ltx-qbroker-"));
  roots.push(root);
  const socketPath = join(root, "broker.sock");
  const server = createServer((socket) => {
    let requestBytes = "";
    socket.on("data", (chunk) => {
      requestBytes += chunk.toString("utf8");
      if (!requestBytes.includes("\n")) return;
      const response = handler(requestBytes);
      if (response !== null) socket.end(`${response}\n`);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  await chmod(socketPath, 0o600);
  return { root, socketPath };
}

function transport(socketPath: string, timeoutMs = 1_000): UnixQualificationBrokerTransport {
  return new UnixQualificationBrokerTransport({
    socketPath,
    expectedUid: process.getuid!(),
    expectedGid: process.getgid!(),
    expectedMode: 0o600,
    timeoutMs,
  });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("qualification broker Unix transport", () => {
  it("uses one bounded newline frame over an identity-checked Unix socket", async () => {
    let received: unknown;
    const { socketPath } = await listen((payload) => {
      received = JSON.parse(payload.trim());
      return JSON.stringify({ ok: true });
    });
    await expect(transport(socketPath).exchange(request())).resolves.toEqual({ ok: true });
    expect(received).toEqual(request());
  });

  it("refuses a regular file at the configured socket path", async () => {
    const root = await mkdtemp(join(tmpdir(), "ltx-qbroker-file-"));
    roots.push(root);
    const path = join(root, "broker.sock");
    await writeFile(path, "not a socket");
    await chmod(path, 0o600);
    expect(() => transport(path).exchange(request())).toThrow(/type, owner, group, or mode mismatch/);
  });

  it("times out fail-closed when the writer never acknowledges", async () => {
    const { socketPath } = await listen(() => null);
    await expect(transport(socketPath, 50).exchange(request())).rejects.toThrow(/timed out/);
  });

  it("rejects multiple response frames", async () => {
    const { socketPath } = await listen(() => "{\"ok\":true}\n{\"ok\":false}");
    await expect(transport(socketPath).exchange(request())).rejects.toThrow(/more than one response frame/);
  });
});
