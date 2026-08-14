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
    expect(unit).toContain("WantedBy=multi-user.target");
  });
});
