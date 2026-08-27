import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { appRoot } from "../server/config.js";

describe("release service network policy", () => {
  it("denies public egress while retaining only Unix sockets and loopback IP", () => {
    const unit = readFileSync(join(appRoot, "deploy", "ltx-studio-session.service"), "utf8");

    expect(unit).toContain("User=moddy");
    expect(unit).toContain("Group=moddy");
    expect(unit).toContain("RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6");
    expect(unit).toContain("IPAddressDeny=any");
    expect(unit).toContain("IPAddressAllow=127.0.0.0/8");
    expect(unit).toContain("IPAddressAllow=::1/128");
    expect(unit).toContain("TimeoutStopSec=8min");
    expect(unit).toContain("WantedBy=multi-user.target");
  });

  it("keeps sealed core controls fixed before exec", () => {
    const unit = readFileSync(join(appRoot, "deploy", "ltx-studio-sealed@.service"), "utf8");

    expect(unit).not.toContain("EnvironmentFile=");
    expect(unit).toContain("Environment=LTX_STUDIO_SEALED_RELEASE=1");
    expect(unit).toContain("Environment=LTX_STUDIO_EXPECTED_RELEASE_DIGEST=%i");
    expect(unit).toContain("Environment=PATH=/usr/sbin:/usr/bin:/sbin:/bin");
    for (const variable of [
      "NODE_OPTIONS",
      "LD_PRELOAD",
      "LD_AUDIT",
      "LD_LIBRARY_PATH",
      "PYTHONHOME",
      "PYTHONPATH",
      "PYTHONSTARTUP",
    ]) {
      expect(unit.match(/^UnsetEnvironment=.*$/m)?.[0]).toContain(variable);
    }
    expect(unit).toContain("ExecStart=/opt/ltx-studio/releases/%i/apps/ltx-studio/runtime/.venv/bin/node");
    expect(unit).toContain("ExecCondition=/usr/libexec/ltx-studio/node-v24/bin/node /usr/libexec/ltx-studio/root-bootstrap-v1.mjs verify-start --release-digest %i");
    expect(unit).toContain("TimeoutStopSec=8min");
  });
});
