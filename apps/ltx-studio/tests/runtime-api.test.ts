import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildAdmissionRequests,
  submitConditionalQueueSuccessor,
} from "../server/admission.js";
import { runtimeApiJson } from "../server/runtimeApi.js";
import { validRequest } from "./fixtures.js";

const servers: Server[] = [];

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectPromise);
      resolvePromise();
    });
  });
  return (server.address() as AddressInfo).port;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map(async (server) => {
    server.closeAllConnections();
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  }));
});

describe("DGX Runtime API transport", () => {
  it("sends the field-closed conditional successor body to the predecessor-bound endpoint", async () => {
    const predecessorJobId = "dgx-job-20260828-120000-111111111111";
    const successorToken = "a".repeat(64);
    const [admissionRequest] = buildAdmissionRequests(
      validRequest(),
      58,
      "11111111-1111-4111-8111-111111111111",
    );
    let observed: {
      method?: string;
      url?: string;
      body?: unknown;
    } = {};
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        observed = {
          method: request.method,
          url: request.url,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        };
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          schema_version: "dgx-conditional-successor-result.v0",
          successor_token: successorToken,
          predecessor_job_id: predecessorJobId,
          successor_job_id: "dgx-job-20260828-120001-222222222222",
          request_sha256: "b".repeat(64),
          created: false,
          outcome: "replayed",
          job: {},
          admission: {},
          terminal_evidence: null,
        }));
      });
    });
    servers.push(server);
    const port = await listen(server);
    vi.stubEnv("DGX_RUNTIME_API_BASE_URL", `http://127.0.0.1:${port}`);
    vi.stubEnv("DGX_RUNTIME_API_TOKEN", "t".repeat(32));

    await submitConditionalQueueSuccessor(
      predecessorJobId,
      successorToken,
      admissionRequest,
    );

    expect(observed).toEqual({
      method: "POST",
      url: `/dgx/queue/successor/${predecessorJobId}`,
      body: {
        schema_version: "dgx-conditional-successor-submit.v0",
        successor_token: successorToken,
        request: admissionRequest,
      },
    });
    expect(Object.keys(observed.body as Record<string, unknown>).sort()).toEqual([
      "request",
      "schema_version",
      "successor_token",
    ]);
  });

  it("enforces timeoutMs as a wall-clock deadline while the server keeps dripping bytes", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.write('{"value":"');
      const drip = setInterval(() => response.write("x"), 10);
      const eventualEnd = setTimeout(() => response.end('"}'), 2_000);
      response.once("close", () => {
        clearInterval(drip);
        clearTimeout(eventualEnd);
      });
    });
    servers.push(server);
    const port = await listen(server);
    vi.stubEnv("DGX_RUNTIME_API_BASE_URL", `http://127.0.0.1:${port}`);
    vi.stubEnv("DGX_RUNTIME_API_TOKEN", "t".repeat(32));
    const startedAt = Date.now();

    const request = runtimeApiJson("GET", "/drip", undefined, { timeoutMs: 100 });

    await expect(request).rejects.toMatchObject({
      name: "RuntimeApiError",
      message: "DGX Runtime API Timeout.",
      statusCode: null,
    });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});
