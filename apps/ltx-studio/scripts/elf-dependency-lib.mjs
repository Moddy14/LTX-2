import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { sha256Bytes } from "./release-manifest-lib.mjs";

const FIXED_LIBRARY_DIRECTORIES = Object.freeze({
  3: ["/lib/i386-linux-gnu", "/usr/lib/i386-linux-gnu", "/lib", "/usr/lib"],
  62: ["/lib/x86_64-linux-gnu", "/usr/lib/x86_64-linux-gnu", "/lib64", "/usr/lib64", "/lib", "/usr/lib"],
  183: ["/lib/aarch64-linux-gnu", "/usr/lib/aarch64-linux-gnu", "/lib64", "/usr/lib64", "/lib", "/usr/lib"],
});
const LD_CONFIG_PATH = "/usr/sbin/ldconfig";
const LD_CACHE_PATH = "/etc/ld.so.cache";
const LD_PRELOAD_PATH = "/etc/ld.so.preload";

function safeWord(bytes, offset, elfClass) {
  if (offset < 0 || offset + (elfClass === 2 ? 8 : 4) > bytes.length) {
    throw new Error("ELF integer read is out of bounds");
  }
  if (elfClass === 1) return bytes.readUInt32LE(offset);
  const value = bytes.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("ELF64 integer exceeds JavaScript's safe integer range");
  }
  return Number(value);
}

function safeSum(...values) {
  const result = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error("ELF offset arithmetic is unsafe");
  return result;
}

function exactLibrary(pathArgument, options = {}) {
  const canonical = realpathSync(pathArgument);
  if (!isAbsolute(canonical)) throw new Error(`ELF dependency is not absolute: ${pathArgument}`);
  const details = lstatSync(canonical);
  if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1
    || (options.requireRootOwnership !== false && (details.uid !== 0 || details.gid !== 0))
    || (details.mode & 0o022) !== 0) {
    throw new Error(`ELF dependency is not an immutable root-owned regular file: ${canonical}`);
  }
  const bytes = readFileSync(canonical);
  return { path: canonical, sizeBytes: bytes.length, mode: details.mode & 0o7777, sha256: sha256Bytes(bytes) };
}

function cString(bytes, offset, limit) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= bytes.length) {
    throw new Error("ELF string offset is invalid");
  }
  const endLimit = Math.min(bytes.length, safeSum(offset, limit));
  let end = offset;
  while (end < endLimit && bytes[end] !== 0) end += 1;
  if (end === endLimit) throw new Error("ELF string is unterminated");
  return bytes.subarray(offset, end).toString("utf8");
}

export function parseElfDynamic(pathArgument) {
  const path = realpathSync(pathArgument);
  const bytes = readFileSync(path);
  if (bytes.length < 64 || bytes[0] !== 0x7f || bytes.subarray(1, 4).toString("ascii") !== "ELF") {
    throw new Error(`Not an ELF executable: ${path}`);
  }
  const elfClass = bytes[4];
  if ((elfClass !== 1 && elfClass !== 2) || bytes[5] !== 1) {
    throw new Error(`Only little-endian ELF32/ELF64 is supported: ${path}`);
  }
  const u16 = (offset) => bytes.readUInt16LE(offset);
  const machine = u16(18);
  const word = (offset) => safeWord(bytes, offset, elfClass);
  const phoff = word(elfClass === 2 ? 32 : 28);
  const phentsize = u16(elfClass === 2 ? 54 : 42);
  const phnum = u16(elfClass === 2 ? 56 : 44);
  if (phnum < 1 || phnum > 4096 || phentsize < (elfClass === 2 ? 56 : 32)
    || safeSum(phoff, phentsize * phnum) > bytes.length) {
    throw new Error(`ELF program-header table is invalid: ${path}`);
  }
  const segments = [];
  for (let index = 0; index < phnum; index += 1) {
    const base = safeSum(phoff, index * phentsize);
    segments.push(elfClass === 2 ? {
      type: bytes.readUInt32LE(base),
      offset: word(base + 8),
      virtualAddress: word(base + 16),
      fileSize: word(base + 32),
      memorySize: word(base + 40),
    } : {
      type: bytes.readUInt32LE(base),
      offset: word(base + 4),
      virtualAddress: word(base + 8),
      fileSize: word(base + 16),
      memorySize: word(base + 20),
    });
  }
  const interpreterSegment = segments.find(({ type }) => type === 3);
  const interpreter = interpreterSegment
    ? cString(bytes, interpreterSegment.offset, interpreterSegment.fileSize)
    : null;
  const dynamic = segments.find(({ type }) => type === 2);
  if (!dynamic) return { path, machine, interpreter, needed: [], rpaths: [], runpaths: [] };
  const entrySize = elfClass === 2 ? 16 : 8;
  if (safeSum(dynamic.offset, dynamic.fileSize) > bytes.length || dynamic.fileSize % entrySize !== 0) {
    throw new Error(`ELF dynamic table is invalid: ${path}`);
  }
  const entries = [];
  for (let offset = dynamic.offset; offset < safeSum(dynamic.offset, dynamic.fileSize); offset += entrySize) {
    const tag = word(offset);
    const value = word(offset + (elfClass === 2 ? 8 : 4));
    entries.push({ tag, value });
    if (tag === 0) break;
  }
  const stringAddress = entries.find(({ tag }) => tag === 5)?.value;
  const stringSize = entries.find(({ tag }) => tag === 10)?.value;
  if (stringAddress === undefined || stringSize === undefined || stringSize < 1) {
    if (entries.some(({ tag }) => [1, 15, 29].includes(tag))) throw new Error(`ELF dynamic string table is absent: ${path}`);
    return { path, machine, interpreter, needed: [], rpaths: [], runpaths: [] };
  }
  const load = segments.find(({ type, virtualAddress, memorySize }) =>
    type === 1 && stringAddress >= virtualAddress && stringAddress < safeSum(virtualAddress, memorySize));
  if (!load) throw new Error(`ELF dynamic string table is outside loadable segments: ${path}`);
  const stringOffset = safeSum(load.offset, stringAddress - load.virtualAddress);
  if (safeSum(stringOffset, stringSize) > bytes.length) throw new Error(`ELF dynamic string table is truncated: ${path}`);
  const strings = (tag) => entries.filter((entry) => entry.tag === tag)
    .map(({ value }) => {
      if (!Number.isSafeInteger(value) || value < 0 || value >= stringSize) {
        throw new Error(`ELF dynamic string offset is outside its declared table: ${path}`);
      }
      return cString(bytes, safeSum(stringOffset, value), stringSize - value);
    });
  const needed = strings(1);
  const tokenValues = machine === 62
    ? { lib: "lib/x86_64-linux-gnu", platform: "x86_64" }
    : machine === 183
      ? { lib: "lib/aarch64-linux-gnu", platform: "aarch64" }
      : machine === 3
        ? { lib: "lib", platform: "i686" }
        : null;
  if (!tokenValues) throw new Error(`Unsupported ELF machine ${machine}: ${path}`);
  const expand = (value) => {
    const expanded = value
      .replaceAll("${ORIGIN}", dirname(path)).replaceAll("$ORIGIN", dirname(path))
      .replaceAll("${LIB}", tokenValues.lib).replaceAll("$LIB", tokenValues.lib)
      .replaceAll("${PLATFORM}", tokenValues.platform).replaceAll("$PLATFORM", tokenValues.platform);
    if (expanded.includes("$") || !isAbsolute(expanded)) {
      throw new Error(`ELF search path contains an unsupported token or relative path: ${path}`);
    }
    return resolve(expanded);
  };
  const paths = (tag) => strings(tag).flatMap((value) => value.split(":"))
    .filter(Boolean).map(expand);
  const rpaths = paths(15);
  const runpaths = paths(29);
  if (needed.some((name) => name.includes("/") || name.includes("\0"))) {
    throw new Error(`ELF DT_NEEDED contains an unsafe library name: ${path}`);
  }
  return { path, machine, interpreter, needed, rpaths, runpaths };
}

function recursiveHwcapsCandidates(directory, name, depth = 0) {
  const candidates = [join(directory, name)];
  if (depth >= 3 || !existsSync(directory)) return candidates;
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return candidates;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()
      || (depth === 0 && entry.name !== "glibc-hwcaps")) continue;
    candidates.push(...recursiveHwcapsCandidates(join(directory, entry.name), name, depth + 1));
  }
  return candidates;
}

export function captureLoaderResolutionPolicy(options = {}) {
  const execute = options.execute ?? execFileSync;
  const ldconfig = exactLibrary(LD_CONFIG_PATH);
  const cache = exactLibrary(LD_CACHE_PATH);
  const output = String(execute(ldconfig.path, ["-p", "-C", cache.path], {
    encoding: "utf8",
    env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C" },
    maxBuffer: 16 * 1024 * 1024,
  }));
  if (output.length > 16 * 1024 * 1024) throw new Error("ld.so cache inventory exceeds its fixed bound");
  const entries = new Map();
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\S+)\s+\([^)]*\)\s+=>\s+(\/\S+)\s*$/.exec(line);
    if (!match) continue;
    const path = realpathSync(match[2]);
    const paths = entries.get(match[1]) ?? [];
    paths.push(path);
    entries.set(match[1], paths);
  }
  let preload = { configuration: null, entries: [] };
  if (existsSync(LD_PRELOAD_PATH)) {
    const configuration = exactLibrary(LD_PRELOAD_PATH);
    const text = readFileSync(configuration.path, "utf8");
    const preloadEntries = text.split(/\r?\n/)
      .map((line) => line.replace(/#.*/, "").trim())
      .filter(Boolean)
      .flatMap((line) => line.split(/\s+/));
    if (preloadEntries.some((entry) => entry.includes("\0")
      || (entry.includes("/") && !isAbsolute(entry)))) {
      throw new Error("ld.so preload configuration contains an unsafe library path");
    }
    preload = { configuration, entries: [...new Set(preloadEntries)].sort() };
  }
  return {
    ldconfig,
    cache,
    outputSha256: sha256Bytes(Buffer.from(output)),
    preload,
    entries: Object.fromEntries([...entries.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, paths]) => [name, [...new Set(paths)].sort()])),
  };
}

function resolveNeeded(name, searchPaths, loaderPolicy, machine) {
  const fixedDirectories = FIXED_LIBRARY_DIRECTORIES[machine];
  if (!fixedDirectories) throw new Error(`Unsupported ELF machine ${machine} during dependency resolution`);
  const directories = [...new Set([...searchPaths, ...fixedDirectories])];
  const candidates = [
    ...(loaderPolicy.entries[name] ?? []),
    ...directories.flatMap((directory) => recursiveHwcapsCandidates(directory, name)),
  ];
  const present = [...new Set(candidates.filter((path) => existsSync(path)).map((path) => realpathSync(path)))]
    .filter((path) => {
      try {
        return parseElfDynamic(path).machine === machine;
      } catch {
        return false;
      }
    });
  if (present.length === 0) throw new Error(`ELF dependency cannot be resolved through the fixed loader policy: ${name}`);
  return present.sort();
}

export function captureElfDependencyClosure(executablePath, options = {}) {
  const entryPath = realpathSync(executablePath);
  const entryMachine = parseElfDynamic(entryPath).machine;
  const loaderPolicy = options.loaderPolicy ?? captureLoaderResolutionPolicy(options);
  const preloadPaths = (loaderPolicy.preload?.entries ?? []).flatMap((entry) =>
    entry.includes("/")
      ? [realpathSync(entry)]
      : resolveNeeded(entry, [], loaderPolicy, entryMachine));
  const queue = [
    { path: entryPath, inheritedRpaths: [] },
    ...preloadPaths.map((path) => ({ path, inheritedRpaths: [] })),
  ];
  const visitedContexts = new Set();
  const objects = new Map();
  let interpreter = null;
  while (queue.length > 0) {
    if (visitedContexts.size > 16_384) throw new Error("ELF dependency context graph exceeds its fixed bound");
    const { path, inheritedRpaths } = queue.shift();
    const contextKey = `${path}\0${[...inheritedRpaths].sort().join("\0")}`;
    if (visitedContexts.has(contextKey)) continue;
    visitedContexts.add(contextKey);
    const parsed = parseElfDynamic(path);
    if (parsed.machine !== entryMachine) {
      throw new Error(`ELF dependency architecture differs from the entry executable: ${path}`);
    }
    const file = exactLibrary(path, {
      requireRootOwnership: !(options.allowEntryNonRoot === true && path === entryPath),
    });
    const dynamicSearchPaths = parsed.runpaths.length > 0
      ? [...parsed.runpaths, ...inheritedRpaths]
      : [...parsed.rpaths, ...inheritedRpaths];
    const childInheritedRpaths = parsed.runpaths.length > 0
      ? inheritedRpaths
      : [...new Set([...parsed.rpaths, ...inheritedRpaths])];
    const directDependencies = parsed.needed.flatMap((name) =>
      resolveNeeded(name, dynamicSearchPaths, loaderPolicy, parsed.machine));
    if (parsed.interpreter) {
      const canonicalInterpreter = realpathSync(parsed.interpreter);
      if (path === realpathSync(executablePath)) interpreter = canonicalInterpreter;
      directDependencies.push(canonicalInterpreter);
    }
    const needed = [...new Set(directDependencies)].sort();
    const prior = objects.get(path);
    objects.set(path, {
      ...file,
      needed: [...new Set([...(prior?.needed ?? []), ...needed])].sort(),
    });
    queue.push(...needed.map((dependency) => ({
      path: dependency,
      inheritedRpaths: childInheritedRpaths,
    })));
  }
  if (!interpreter && options.requireInterpreter !== false) {
    throw new Error(`ELF executable has no pinned program interpreter: ${executablePath}`);
  }
  return {
    schemaVersion: "ltx-studio-elf-dependency-closure.v2",
    executable: realpathSync(executablePath),
    interpreter,
    loaderPolicy: {
      ldconfig: loaderPolicy.ldconfig,
      cache: loaderPolicy.cache,
      outputSha256: loaderPolicy.outputSha256,
      preload: loaderPolicy.preload,
    },
    objects: [...objects.values()].sort((left, right) => left.path.localeCompare(right.path)),
  };
}
