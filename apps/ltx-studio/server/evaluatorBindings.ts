import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  type BigIntStats,
} from "node:fs";
import { createHash } from "node:crypto";

export type PinnedPathRevision = {
  path: string;
  kind: "file" | "directory";
  device: string;
  inode: string;
  size: string;
  modifiedAtNs: string;
  changedAtNs: string;
};

type OpenPinnedPath = {
  descriptor: number;
  revision: PinnedPathRevision;
};

function revisionFromStat(
  path: string,
  kind: PinnedPathRevision["kind"],
  details: BigIntStats,
): PinnedPathRevision {
  return {
    path,
    kind,
    device: details.dev.toString(),
    inode: details.ino.toString(),
    size: details.size.toString(),
    modifiedAtNs: details.mtimeNs.toString(),
    changedAtNs: details.ctimeNs.toString(),
  };
}

function sameRevision(left: PinnedPathRevision, right: PinnedPathRevision): boolean {
  return left.path === right.path
    && left.kind === right.kind
    && left.device === right.device
    && left.inode === right.inode
    && left.size === right.size
    && left.modifiedAtNs === right.modifiedAtNs
    && left.changedAtNs === right.changedAtNs;
}

function validatePath(path: string): void {
  if (!path.startsWith("/") || path.includes("\n") || path.includes(":")) {
    throw new Error(`Evaluator-Bindepfad ist nicht zulässig: ${path}`);
  }
}

export function capturePinnedPathRevision(
  path: string,
  kind: PinnedPathRevision["kind"],
): PinnedPathRevision {
  validatePath(path);
  const descriptor = openSync(
    path,
    constants.O_RDONLY
      | constants.O_NOFOLLOW
      | (kind === "directory" ? constants.O_DIRECTORY : 0),
  );
  try {
    const details = fstatSync(descriptor, { bigint: true });
    if ((kind === "file" && !details.isFile())
      || (kind === "directory" && !details.isDirectory())) {
      throw new Error(`Evaluator-Bindepfad hat den falschen Typ: ${path}`);
    }
    const pathDetails = lstatSync(path, { bigint: true });
    const opened = revisionFromStat(path, kind, details);
    const fromPath = revisionFromStat(path, kind, pathDetails);
    if (!sameRevision(opened, fromPath)) {
      throw new Error(`Evaluator-Bindepfad wurde während des Öffnens ausgetauscht: ${path}`);
    }
    return opened;
  } finally {
    closeSync(descriptor);
  }
}

export function openPinnedPaths(expected: PinnedPathRevision[]): {
  bindReadOnlyProperty: (path: string) => string;
  sourcePath: (path: string) => string;
  sha256: (path: string, maximumBytes: number) => string;
  verifyUnchanged: () => void;
  close: () => void;
} {
  const opened = new Map<string, OpenPinnedPath>();
  try {
    for (const revision of expected) {
      validatePath(revision.path);
      if (opened.has(revision.path)) {
        throw new Error(`Evaluator-Bindepfad ist doppelt: ${revision.path}`);
      }
      const descriptor = openSync(
        revision.path,
        constants.O_RDONLY
          | constants.O_NOFOLLOW
          | (revision.kind === "directory" ? constants.O_DIRECTORY : 0),
      );
      try {
        const details = fstatSync(descriptor, { bigint: true });
        if ((revision.kind === "file" && !details.isFile())
          || (revision.kind === "directory" && !details.isDirectory())) {
          throw new Error(`Evaluator-Bindepfad hat den falschen Typ: ${revision.path}`);
        }
        const actual = revisionFromStat(revision.path, revision.kind, details);
        if (!sameRevision(actual, revision)) {
          throw new Error(`Evaluator-Bindepfad stimmt nicht mehr mit der geprüften Revision überein: ${revision.path}`);
        }
        opened.set(revision.path, { descriptor, revision });
      } catch (error) {
        closeSync(descriptor);
        throw error;
      }
    }
  } catch (error) {
    for (const entry of opened.values()) closeSync(entry.descriptor);
    throw error;
  }

  let closed = false;
  const entryFor = (path: string): OpenPinnedPath => {
    if (closed) throw new Error("Evaluator-Bindedeskriptoren sind bereits geschlossen.");
    const entry = opened.get(path);
    if (!entry) throw new Error(`Evaluator-Bindepfad wurde nicht geöffnet: ${path}`);
    return entry;
  };
  return {
    sourcePath: (path) => {
      const entry = entryFor(path);
      return `/proc/${process.pid}/fd/${entry.descriptor}`;
    },
    bindReadOnlyProperty: (path) => {
      const entry = entryFor(path);
      return `--property=BindReadOnlyPaths=/proc/${process.pid}/fd/${entry.descriptor}:${path}`;
    },
    sha256: (path, maximumBytes) => {
      const entry = entryFor(path);
      const details = fstatSync(entry.descriptor, { bigint: true });
      if (!details.isFile() || details.size <= 0n || details.size > BigInt(maximumBytes)) {
        throw new Error(`Evaluator-Bindedatei liegt außerhalb des Hash-Limits: ${path}`);
      }
      const digest = createHash("sha256");
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let offset = 0;
      while (true) {
        const bytes = readSync(entry.descriptor, buffer, 0, buffer.length, offset);
        if (bytes === 0) break;
        digest.update(bytes === buffer.length ? buffer : buffer.subarray(0, bytes));
        offset += bytes;
      }
      const after = revisionFromStat(
        entry.revision.path,
        entry.revision.kind,
        fstatSync(entry.descriptor, { bigint: true }),
      );
      if (!sameRevision(after, entry.revision)) {
        throw new Error(`Evaluator-Bindedatei wurde während des Hashings verändert: ${path}`);
      }
      return digest.digest("hex");
    },
    verifyUnchanged: () => {
      for (const entry of opened.values()) {
        const details = fstatSync(entry.descriptor, { bigint: true });
        const actual = revisionFromStat(entry.revision.path, entry.revision.kind, details);
        if (!sameRevision(actual, entry.revision)) {
          throw new Error(`Gebundener Evaluator-Inode wurde während der Messung verändert: ${entry.revision.path}`);
        }
      }
    },
    close: () => {
      if (closed) return;
      closed = true;
      for (const entry of opened.values()) closeSync(entry.descriptor);
      opened.clear();
    },
  };
}
