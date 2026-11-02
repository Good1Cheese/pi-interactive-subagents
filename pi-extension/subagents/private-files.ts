import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

/** Only use for directories owned by this extension, never a shared session root. */
export function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

/** Tighten existing files before appending; refuse symlinks and hardlinks. */
export function appendPrivateFile(path: string, content: string): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
  try {
    if (fstatSync(fd).nlink !== 1) throw new Error(`Refusing to append to hardlinked file: ${path}`);
    fchmodSync(fd, 0o600);
    writeFileSync(fd, content, "utf8");
  } finally { closeSync(fd); }
}

export function writePrivateFile(path: string, content: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) throw new Error(`Refusing to write through symlink: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const temp = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const fd = openSync(
    temp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fchmodSync(fd, 0o600);
    writeFileSync(fd, content, "utf8");
  } catch (error) {
    closeSync(fd);
    unlinkSync(temp);
    throw error;
  }
  closeSync(fd);
  try {
    renameSync(temp, path);
  } catch (error) {
    unlinkSync(temp);
    throw error;
  }
}
