import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
} from "node:fs";
import { join, resolve } from "node:path";

const DATA_ROOT_LOCK_FILE = ".ltx-studio-writer.lock";
const FLOCK_EXECUTABLE = "/usr/bin/flock";
const FLOCK_CONFLICT_EXIT_CODE = 73;

export class DataRootWriterLockError extends Error {
  constructor(
    message: string,
    readonly code: "unsafe-lock-file" | "lock-unavailable" | "lock-held",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DataRootWriterLockError";
  }
}

export type DataRootWriterLock = {
  readonly dataRoot: string;
  readonly lockPath: string;
  release(): void;
};

/**
 * Takes an exclusive Linux open-file-description lock for one Studio data root.
 *
 * `flock(2)` associates the lock with the open file description shared by the
 * short-lived `/usr/bin/flock` process and this process. After `flock` exits,
 * our descriptor keeps the lock alive until `release()` or process exit. The
 * lock file must never be unlinked: doing so could give a second writer a new
 * inode while the original inode is still locked.
 */
export function acquireDataRootWriterLock(dataRootPath: string): DataRootWriterLock {
  const dataRoot = resolve(dataRootPath);
  const lockPath = join(dataRoot, DATA_ROOT_LOCK_FILE);
  let descriptor: number | null = null;

  try {
    const rootDetails = lstatSync(dataRoot);
    const effectiveUid = process.geteuid?.();
    if (
      !rootDetails.isDirectory()
      || rootDetails.isSymbolicLink()
      || realpathSync(dataRoot) !== dataRoot
      || (rootDetails.mode & 0o022) !== 0
      || (effectiveUid !== undefined && rootDetails.uid !== effectiveUid)
    ) {
      throw new Error("data root is not a canonical, owner-controlled directory");
    }
    descriptor = openSync(
      lockPath,
      constants.O_CREAT
        | constants.O_RDWR
        | constants.O_NOFOLLOW,
      0o600,
    );
    const details = fstatSync(descriptor);
    if (
      !details.isFile()
      || details.nlink !== 1
      || (details.mode & 0o077) !== 0
      || (effectiveUid !== undefined && details.uid !== effectiveUid)
    ) {
      throw new Error("lock file is not a private, singly-linked regular file owned by this user");
    }
  } catch (error) {
    if (descriptor !== null) closeSync(descriptor);
    throw new DataRootWriterLockError(
      `LTX Studio cannot safely open its data-root writer lock: ${lockPath}`,
      "unsafe-lock-file",
      { cause: error },
    );
  }

  const acquisition = (() => {
    try {
      return spawnSync(
        FLOCK_EXECUTABLE,
        [
          "--exclusive",
          "--nonblock",
          "--conflict-exit-code",
          String(FLOCK_CONFLICT_EXIT_CODE),
          "3",
        ],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe", descriptor],
        },
      );
    } catch (error) {
      closeSync(descriptor);
      throw new DataRootWriterLockError(
        `LTX Studio could not invoke ${FLOCK_EXECUTABLE} for ${lockPath}`,
        "lock-unavailable",
        { cause: error },
      );
    }
  })();

  if (acquisition.status !== 0) {
    closeSync(descriptor);
    if (acquisition.status === FLOCK_CONFLICT_EXIT_CODE) {
      throw new DataRootWriterLockError(
        `LTX Studio data root is already owned by another server process: ${dataRoot}`,
        "lock-held",
      );
    }
    const detail = acquisition.error?.message
      ?? acquisition.stderr.trim()
      ?? `flock exited with status ${String(acquisition.status)}`;
    throw new DataRootWriterLockError(
      `LTX Studio could not acquire its data-root writer lock at ${lockPath}: ${detail}`,
      "lock-unavailable",
      acquisition.error === undefined ? undefined : { cause: acquisition.error },
    );
  }

  let released = false;
  return Object.freeze({
    dataRoot,
    lockPath,
    release(): void {
      if (released) return;
      released = true;
      closeSync(descriptor);
    },
  });
}
