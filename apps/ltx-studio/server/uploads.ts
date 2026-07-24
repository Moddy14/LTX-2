import { closeSync, openSync, readSync } from "node:fs";
import { extname } from "node:path";

function startsWith(bytes: Buffer, signature: readonly number[], offset = 0): boolean {
  return signature.every((value, index) => bytes[offset + index] === value);
}

export function matchesUploadSignature(path: string): boolean {
  const descriptor = openSync(path, "r");
  const header = Buffer.alloc(16);
  let length = 0;
  try {
    length = readSync(descriptor, header, 0, header.length, 0);
  } finally {
    closeSync(descriptor);
  }
  if (length < 4) return false;
  const extension = extname(path).toLowerCase();
  if (extension === ".png") return startsWith(header, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if ([".jpg", ".jpeg"].includes(extension)) return startsWith(header, [0xff, 0xd8, 0xff]);
  if (extension === ".webp") return header.toString("ascii", 0, 4) === "RIFF" && header.toString("ascii", 8, 12) === "WEBP";
  if (extension === ".wav") return header.toString("ascii", 0, 4) === "RIFF" && header.toString("ascii", 8, 12) === "WAVE";
  if (extension === ".flac") return header.toString("ascii", 0, 4) === "fLaC";
  if (extension === ".ogg") return header.toString("ascii", 0, 4) === "OggS";
  if (extension === ".mp3") {
    return header.toString("ascii", 0, 3) === "ID3"
      || (header[0] === 0xff && (header[1] & 0xe0) === 0xe0);
  }
  if ([".mp4", ".mov", ".m4a"].includes(extension)) return header.toString("ascii", 4, 8) === "ftyp";
  if ([".webm", ".mkv"].includes(extension)) return startsWith(header, [0x1a, 0x45, 0xdf, 0xa3]);
  return false;
}
