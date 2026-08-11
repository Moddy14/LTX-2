import { rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const appRoot = resolve(import.meta.dirname, "..");
const buildRoot = join(appRoot, "build");
const releaseRoot = join(buildRoot, "release-root");

if (basename(releaseRoot) !== "release-root" || dirname(releaseRoot) !== buildRoot) {
  throw new Error(`Refusing to clean unexpected release root: ${releaseRoot}`);
}
rmSync(releaseRoot, { recursive: true, force: true });
process.stdout.write(`${releaseRoot}\n`);
