import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

import {
  LOCK_INFO_FILE,
  lockIsStale,
  readLockOwner,
  releaseLock,
  stealStaleLock,
  tryCreateLock
} from "../plugins/opencode/scripts/lib/lock-dir.mjs";
import { makeTempDir } from "./helpers.mjs";

function lockPath() {
  return path.join(makeTempDir(), "state.lock");
}

// A PID that is certainly not running: a process that has already exited.
function deadPid() {
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  return Number(child.stdout);
}

function writeLock(lockDir, owner) {
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, LOCK_INFO_FILE), JSON.stringify(owner));
}

function siblings(lockDir) {
  return fs.readdirSync(path.dirname(lockDir)).filter((name) => name !== path.basename(lockDir));
}

test("a lock is created with its owner, and a held lock is not created twice", () => {
  const lockDir = lockPath();
  assert.equal(tryCreateLock(lockDir, "first"), true);
  assert.equal(readLockOwner(lockDir).token, "first");
  assert.equal(readLockOwner(lockDir).pid, process.pid);

  assert.equal(tryCreateLock(lockDir, "second"), false);
  assert.equal(readLockOwner(lockDir).token, "first");
  assert.deepEqual(siblings(lockDir), [], "no pending directories are left behind");
});

test("releasing removes only the caller's own lock", () => {
  const lockDir = lockPath();
  tryCreateLock(lockDir, "mine");
  releaseLock(lockDir, "someone-else");
  assert.equal(readLockOwner(lockDir).token, "mine");

  releaseLock(lockDir, "mine");
  assert.equal(fs.existsSync(lockDir), false);
  assert.deepEqual(siblings(lockDir), []);
});

test("a lock whose owner died is stale and can be taken over", () => {
  const lockDir = lockPath();
  writeLock(lockDir, { pid: deadPid(), token: "crashed", createdAt: new Date().toISOString() });

  const owner = readLockOwner(lockDir);
  assert.equal(lockIsStale(lockDir, owner, 30_000), true);
  assert.equal(stealStaleLock(lockDir, owner.token), true);
  assert.equal(fs.existsSync(lockDir), false);
  assert.equal(tryCreateLock(lockDir, "next"), true);
});

// Issue #68. A waiter read the owner of a lock whose holder then released it
// normally and exited; by the time the waiter acts, the next process holds a
// fresh lock. The old code judged "owner is dead" and removed that live lock.
test("a lock taken again after it was judged stale is never stolen", () => {
  const lockDir = lockPath();
  const judged = { pid: deadPid(), token: "released-and-exited", createdAt: new Date().toISOString() };
  writeLock(lockDir, judged);
  assert.equal(lockIsStale(lockDir, readLockOwner(lockDir), 30_000), true);

  // Meanwhile: the old lock is gone and the next process takes the lock.
  fs.rmSync(lockDir, { recursive: true, force: true });
  assert.equal(tryCreateLock(lockDir, "live-holder"), true);

  assert.equal(stealStaleLock(lockDir, judged.token), false);
  assert.equal(readLockOwner(lockDir).token, "live-holder", "the live holder keeps its lock");
  assert.deepEqual(siblings(lockDir), []);
});

test("a live owner's fresh lock is not stale; an old or missing one is", () => {
  const lockDir = lockPath();
  tryCreateLock(lockDir, "live");
  assert.equal(lockIsStale(lockDir, readLockOwner(lockDir), 30_000), false);

  const oldOwner = { ...readLockOwner(lockDir), createdAt: new Date(Date.now() - 60_000).toISOString() };
  assert.equal(lockIsStale(lockDir, oldOwner, 30_000), true, "age is the backstop for reused PIDs");

  releaseLock(lockDir, "live");
  assert.equal(lockIsStale(lockDir, {}, 30_000), true);
});

test("an ownerless lock left by an older plugin version is taken over once it is old", () => {
  const lockDir = lockPath();
  fs.mkdirSync(lockDir);
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lockDir, old, old);

  const owner = readLockOwner(lockDir);
  assert.deepEqual(owner, {});
  assert.equal(lockIsStale(lockDir, owner, 30_000), true);
  assert.equal(stealStaleLock(lockDir, owner.token), true);
  assert.equal(tryCreateLock(lockDir, "next"), true);
});
