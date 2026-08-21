import { execFileSync } from "node:child_process";
import {
  chmodSync,
  chownSync,
  cpSync,
  existsSync,
  lchownSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

const appRoot = resolve(import.meta.dirname, "..");
if (process.getuid?.() !== 0) {
  throw new Error("Release installation must run as root so installed artifacts cannot remain user-owned");
}
const sourceRoot = join(appRoot, "build", "release-root");
const digest = readFileSync(join(sourceRoot, "release-manifest.sha256"), "utf8").split(/\s+/)[0];
if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error("Source release digest is invalid");

const destinationIndex = process.argv.indexOf("--destination");
const destinationArgument = destinationIndex === -1 ? undefined : process.argv[destinationIndex + 1];
if (!destinationArgument || destinationArgument.startsWith("--")) {
  throw new Error("--destination /absolute/releases/<release_digest> is required");
}
const destination = resolve(destinationArgument);
if (basename(destination) !== digest || destination === "/" || destination === resolve("/opt")) {
  throw new Error(`Destination must end in the exact release digest ${digest}`);
}
if (existsSync(destination)) throw new Error(`Release destination already exists: ${destination}`);
const parent = dirname(destination);
if (!existsSync(parent)) throw new Error(`Release parent does not exist: ${parent}`);
const releaseEnvironment = {
  ...process.env,
  HF_HUB_OFFLINE: "1",
  PYTHONNOUSERSITE: "1",
  TRANSFORMERS_OFFLINE: "1",
};
delete releaseEnvironment.VIRTUAL_ENV;

function run(executable, args, cwd = destination) {
  execFileSync(executable, args, { cwd, env: releaseEnvironment, stdio: "inherit" });
}

function makeReadOnly(path) {
  const details = lstatSync(path);
  if (details.isSymbolicLink()) return;
  if (details.isDirectory()) {
    for (const child of readdirSync(path)) makeReadOnly(join(path, child));
    chmodSync(path, 0o555);
  } else if (details.isFile()) {
    chmodSync(path, details.mode & 0o111 ? 0o555 : 0o444);
  } else {
    throw new Error(`Unsupported installed artifact: ${path}`);
  }
}

function makeRootOwned(path) {
  const details = lstatSync(path);
  if (details.isSymbolicLink()) {
    lchownSync(path, 0, 0);
    return;
  }
  if (details.isDirectory()) {
    for (const child of readdirSync(path)) makeRootOwned(join(path, child));
    chownSync(path, 0, 0);
    return;
  }
  if (details.isFile()) {
    chownSync(path, 0, 0);
    return;
  }
  throw new Error(`Unsupported installed artifact: ${path}`);
}

function makeWritable(path) {
  const details = lstatSync(path);
  if (details.isSymbolicLink()) return;
  if (details.isDirectory()) {
    chmodSync(path, 0o755);
    for (const child of readdirSync(path)) makeWritable(join(path, child));
  } else if (details.isFile()) {
    chmodSync(path, details.mode & 0o111 ? 0o755 : 0o644);
  }
}

let created = false;
try {
  mkdirSync(destination, { mode: 0o755 });
  created = true;
  cpSync(sourceRoot, destination, {
    recursive: true,
    preserveTimestamps: false,
    filter: (source) => {
      const path = relative(sourceRoot, source);
      return path !== join("apps", "ltx-studio", "runtime", ".venv")
        && !path.startsWith(`${join("apps", "ltx-studio", "runtime", ".venv")}${sep}`);
    },
  });
  const runtimeRoot = join(destination, "apps", "ltx-studio", "runtime");
  run("uv", [
    "sync", "--project", runtimeRoot, "--locked", "--no-dev", "--no-editable", "--compile-bytecode",
    "--no-config",
  ]);
  const python = join(runtimeRoot, ".venv", "bin", "python");
  run(python, ["-I", join(runtimeRoot, "normalize_cusparselt_wheel.py")]);
  run(python, ["-I", join(runtimeRoot, "normalize_torch_cudnn_requirement.py")]);
  run("uv", ["pip", "check", "--python", python]);
  run(python, ["-I", join(runtimeRoot, "verify_runtime.py")]);
  run(process.execPath, [
    join(destination, "apps", "ltx-studio", "scripts", "verify-release-manifest.mjs"),
    "--root", destination,
  ]);
  makeRootOwned(destination);
  makeReadOnly(destination);
  run(process.execPath, [
    join(destination, "apps", "ltx-studio", "scripts", "verify-release-manifest.mjs"),
    "--root", destination,
  ]);
  process.stdout.write(`${JSON.stringify({ releaseDigest: digest, destination, verdict: "installed-read-only" })}\n`);
} catch (error) {
  if (created && existsSync(destination)) {
    makeWritable(destination);
    rmSync(destination, { recursive: true, force: true });
  }
  throw error;
}
