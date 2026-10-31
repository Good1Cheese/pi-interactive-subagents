import { chmodSync, closeSync, constants, fchmodSync, ftruncateSync, mkdirSync, openSync, writeFileSync } from "node:fs";

/** Only use for directories owned by this extension, never a shared session root. */
export function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

/** Tighten existing files before truncating or writing; refuse symlinks. */
export function appendPrivateFile(path: string, content: string): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
  try { fchmodSync(fd, 0o600); writeFileSync(fd, content, "utf8"); }
  finally { closeSync(fd); }
}

export function writePrivateFile(path: string, content: string): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    fchmodSync(fd, 0o600);
    ftruncateSync(fd, 0);
    writeFileSync(fd, content, "utf8");
  } finally {
    closeSync(fd);
  }
}
