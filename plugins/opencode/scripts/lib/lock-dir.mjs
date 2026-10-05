// Directory locks shared by the state lock and the server lock (issue #68).
//
// A lock is a directory holding owner.json ({pid, token, createdAt}). Every
// change to the lock path is a single rename:
// - a lock is created aside, with its owner, and renamed into place, so no
//   process ever sees a lock without its owner;
// - releasing or stealing moves the lock aside first and then checks whose it
//   is. A lock that turns out to be someone else's (it was released and taken
//   again after we looked) is put back instead of deleted.
// Checking first and then deleting by path, as before, could remove a lock
// another process had just taken: that process crashed writing its owner
// file (ENOENT), or two processes held the lock at once.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

export const LOCK_INFO_FILE = "owner.json";

// What renaming onto an existing lock reports: POSIX refuses a non-empty
// target, Windows refuses any existing directory.
const LOCK_HELD_CODES = new Set(["EEXIST", "ENOTEMPTY", "EPERM", "EACCES", "EBUSY"]);

function asidePath(lockDir, label) {
  return `${lockDir}.${label}-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
}

function removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best effort: an aside directory is never the lock itself.
  }
}

export function readLockOwner(lockDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(lockDir, LOCK_INFO_FILE), "utf8"));
  } catch {
    return {};
  }
}

function processIsDead(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error?.code !== "EPERM";
  }
}

function lockAgeMs(lockDir, owner) {
  const created = Date.parse(owner?.createdAt ?? "");
  if (Number.isFinite(created)) {
    return Date.now() - created;
  }
  try {
    return Date.now() - fs.statSync(lockDir).mtimeMs;
  } catch {
    return 0;
  }
}

// Stale when gone, when its owner process is dead, or, as a backstop for
// reused PIDs, when it is older than staleMs. `owner` is what the caller read,
// so a later steal can check it still has that same lock.
export function lockIsStale(lockDir, owner, staleMs) {
  if (!fs.existsSync(lockDir)) {
    return true;
  }
  if (processIsDead(Number(owner?.pid))) {
    return true;
  }
  return lockAgeMs(lockDir, owner) > staleMs;
}

// Returns true when this process now holds the lock.
export function tryCreateLock(lockDir, token) {
  const pending = asidePath(lockDir, "pending");
  fs.mkdirSync(pending);
  try {
    fs.writeFileSync(
      path.join(pending, LOCK_INFO_FILE),
      `${JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }, null, 2)}\n`,
      "utf8"
    );
    fs.renameSync(pending, lockDir);
    return true;
  } catch (error) {
    removeDir(pending);
    if (LOCK_HELD_CODES.has(error?.code)) {
      return false;
    }
    throw error;
  }
}

// Moves the lock at lockDir aside and keeps it there only if its owner token
// is `expectedToken`; otherwise puts it back. Returns the aside path, or null.
function takeLockIfOwnedBy(lockDir, expectedToken, label) {
  const aside = asidePath(lockDir, label);
  try {
    fs.renameSync(lockDir, aside);
  } catch {
    // Already gone, or another process moved it first.
    return null;
  }
  if (readLockOwner(aside).token === expectedToken) {
    return aside;
  }
  try {
    fs.renameSync(aside, lockDir);
  } catch {
    // A new lock was taken in the meantime; the one we moved can't go back.
    removeDir(aside);
  }
  return null;
}

// Removes a lock judged stale, but only if it is still the lock that was
// judged: `staleToken` is the owner token read when it was judged. A holder
// that released normally and then exited also has a dead PID by now, and the
// lock at the path may already be the next holder's: re-read first, so only
// a lock whose owner can no longer release it is ever moved.
export function stealStaleLock(lockDir, staleToken) {
  if (readLockOwner(lockDir).token !== staleToken) {
    return false;
  }
  const aside = takeLockIfOwnedBy(lockDir, staleToken, "stale");
  if (aside) {
    removeDir(aside);
  }
  return Boolean(aside);
}

export function releaseLock(lockDir, token) {
  if (readLockOwner(lockDir).token !== token) {
    // Not ours any more: it was taken over as stale and may be someone else's.
    return;
  }
  const aside = takeLockIfOwnedBy(lockDir, token, "released");
  if (aside) {
    removeDir(aside);
  }
}
