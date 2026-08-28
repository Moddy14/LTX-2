import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runtimeApiJson } from "../server/runtimeApi.js";

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
