// src/io/activity.ts
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync as closeSync2,
  fstatSync,
  fsyncSync as fsyncSync2,
  linkSync,
  openSync as openSync2,
  readdirSync,
  readFileSync,
  unlinkSync as unlinkSync2,
  writeFileSync
} from "node:fs";
import { join as join2 } from "node:path";

// src/io/atomicWrite.ts
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { dirname, join } from "node:path";
var counter = 0;
function tmpPath(target) {
  counter += 1;
  return join(dirname(target), `.tmp.${process.pid}.${counter}.${target.length}`);
}
function writeFileAtomic(target, data) {
  mkdirSync(dirname(target), { recursive: true });
  const tmp = tmpPath(target);
  const fd = openSync(tmp, "wx");
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } catch (err) {
    closeSync(fd);
    try {
      unlinkSync(tmp);
    } catch {
    }
    throw err;
  }
  closeSync(fd);
  try {
    renameSync(tmp, target);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
    }
    throw err;
  }
}
function writeJsonAtomic(target, value) {
  writeFileAtomic(target, `${JSON.stringify(value, null, 2)}
`);
}

// src/io/heartbeat.ts
import { spawn } from "node:child_process";
var DEFAULT_BEAT_MS = 15e3;
var CHILD_SOURCE = `
const fs = require('node:fs');
const [filePath, field, valueFormat, guardRaw, indentRaw, intervalRaw, parentRaw, pauseReady, pauseResume, pauseDone] = process.argv.slice(1);
const indent = Number(indentRaw);
const interval = Number(intervalRaw);
const parentPid = Number(parentRaw);
let guard;
try { guard = JSON.parse(guardRaw); } catch { process.exit(0); }
function beat() {
  if (process.ppid !== parentPid) process.exit(0);
  try { process.kill(parentPid, 0); } catch { process.exit(0); }
  let fd;
  try { fd = fs.openSync(filePath, 'r+'); } catch { process.exit(0); }
  try {
    let stored;
    try { stored = JSON.parse(fs.readFileSync(fd, 'utf8')); } catch { process.exit(0); }
    if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) process.exit(0);
    for (const [key, value] of Object.entries(guard)) {
      if (!Object.prototype.hasOwnProperty.call(stored, key) || stored[key] !== value) process.exit(0);
    }
    if (pauseReady) {
      try {
        fs.writeFileSync(pauseReady, 'ready');
        while (!fs.existsSync(pauseResume)) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      } catch { process.exit(0); }
    }
    stored[field] = valueFormat === 'iso' ? new Date().toISOString() : Date.now();
    const data = Buffer.from(JSON.stringify(stored, null, indent) + '\\n');
    let offset = 0;
    while (offset < data.length) {
      const written = fs.writeSync(fd, data, offset, data.length - offset, offset);
      if (written === 0) process.exit(0);
      offset += written;
    }
    fs.ftruncateSync(fd, data.length);
    if (pauseDone) {
      try { fs.writeFileSync(pauseDone, 'done'); } catch { process.exit(0); }
    }
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
}
beat();
setInterval(beat, interval);
`;
function startJsonHeartbeat(filePath, options) {
  const intervalMs = options.intervalMs ?? DEFAULT_BEAT_MS;
  const child = spawn(
    process.execPath,
    [
      "-e",
      CHILD_SOURCE,
      filePath,
      options.field,
      options.valueFormat,
      JSON.stringify(options.guard),
      String(options.indent ?? 0),
      String(intervalMs),
      String(process.pid),
      options.testPauseAfterRead?.readyPath ?? "",
      options.testPauseAfterRead?.resumePath ?? "",
      options.testPauseAfterRead?.donePath ?? ""
    ],
    { detached: true, stdio: "ignore" }
  );
  let stopped = false;
  let pid = child.pid ?? null;
  const started = new Promise((resolve) => {
    child.once("spawn", () => {
      pid = child.pid ?? null;
      if (pid === null) {
        resolve({ ok: false, error: new Error("heartbeat child started without a pid") });
        return;
      }
      if (stopped) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
        }
      }
      resolve({ ok: true, pid });
    });
    child.once("error", (error) => {
      pid = null;
      resolve({ ok: false, error });
    });
  });
  child.unref();
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (pid === null) return;
    try {
      process.kill(pid, "SIGTERM");
    } catch {
    }
  };
  return {
    stop,
    get pid() {
      return pid;
    },
    started
  };
}

// src/io/lock.ts
var DEFAULT_STALE_MS = 9e4;

// src/io/activity.ts
var OUTCOMES = /* @__PURE__ */ new Set(["ok", "failed", "timed_out", "stalled"]);
var MAX_PID = 2147483647;
var MAX_FUTURE_BEAT_SKEW_MS = 5e3;
var RECLAIM_LEASE_MS = 3e4;
var activityTestHook;
function setActivityTestHookForTesting(hook) {
  activityTestHook = hook;
}
function reachActivityTestPoint(point) {
  activityTestHook?.(point);
}
var ActivityAlreadyExistsError = class extends Error {
  activity;
  path;
  constructor(label, path, activity) {
    const owner = activity === null ? "an unreadable existing activity" : `pid ${activity.pid}, started ${activity.started_at}`;
    super(`activity '${label}' is already claimed by ${owner} (${path})`);
    this.name = "ActivityAlreadyExistsError";
    this.activity = activity;
    this.path = path;
  }
};
function finiteDate(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
function validPid(value) {
  return Number.isInteger(value) && value > 0 && value <= MAX_PID;
}
function parseActivity(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const object = value;
  if (typeof object.label !== "string" || object.label.length === 0) return null;
  if (typeof object.owner_token !== "string" || object.owner_token.length === 0) return null;
  if (!validPid(object.pid)) return null;
  if (!finiteDate(object.started_at) || !finiteDate(object.beat_at)) return null;
  if (object.ended_at !== void 0 && !finiteDate(object.ended_at)) return null;
  if (object.outcome !== void 0 && !OUTCOMES.has(object.outcome)) return null;
  if (object.status_path !== void 0 && typeof object.status_path !== "string") return null;
  const record = {
    label: object.label,
    owner_token: object.owner_token,
    pid: object.pid,
    started_at: object.started_at,
    beat_at: object.beat_at
  };
  if (typeof object.ended_at === "string") record.ended_at = object.ended_at;
  if (typeof object.outcome === "string") record.outcome = object.outcome;
  if (typeof object.status_path === "string") record.status_path = object.status_path;
  return record;
}
function activityKey(label) {
  if (label.length === 0) throw new Error("activity label must not be empty");
  return createHash("sha256").update(label).digest("hex");
}
function writeActivity(path, activity) {
  const candidate = Object.prototype.hasOwnProperty.call(activity, "owner_token") ? activity : { ...activity, owner_token: randomUUID() };
  const parsed = parseActivity(candidate);
  if (parsed === null) throw new Error(`cannot write invalid activity to ${path}`);
  if (parsed.ended_at !== void 0) {
    try {
      unlinkSync2(path);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    return parsed;
  }
  writeJsonAtomic(path, parsed);
  return parsed;
}
function readActivity(path) {
  try {
    return parseActivity(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}
function errorCode(error) {
  return error.code;
}
function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}
function fileSnapshot(path) {
  let fd;
  try {
    fd = openSync2(path, "r");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
  try {
    const stat = fstatSync(fd, { bigint: true });
    return {
      text: readFileSync(fd, "utf8"),
      identity: { dev: stat.dev, ino: stat.ino },
      mtimeMs: Number(stat.mtimeNs / 1000000n)
    };
  } finally {
    closeSync2(fd);
  }
}
function activitySnapshot(path) {
  try {
    const snapshot = fileSnapshot(path);
    if (snapshot === null) return null;
    const record = parseActivity(JSON.parse(snapshot.text));
    return record === null ? null : { ...snapshot, record };
  } catch {
    return null;
  }
}
function sameSnapshot(left, right) {
  return left.text === right.text && sameIdentity(left.identity, right.identity);
}
function stillTheSameFile(path, expected) {
  const current = fileSnapshot(path);
  return current !== null && sameSnapshot(current, expected);
}
function parseReclaimer(text) {
  try {
    const value = JSON.parse(text);
    if (!validPid(value.pid)) return null;
    if (typeof value.beatAtMs !== "number" || !Number.isFinite(value.beatAtMs)) return null;
    if (typeof value.token !== "string" || value.token.length === 0) return null;
    return { pid: value.pid, beatAtMs: value.beatAtMs, token: value.token };
  } catch {
    return null;
  }
}
function reclaimerText(token) {
  return `${JSON.stringify({ pid: process.pid, beatAtMs: Date.now(), token })}
`;
}
function pidIsGone(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return errorCode(error) === "ESRCH";
  }
}
function installReclaimer(path, token) {
  const staging = `${path}.${process.pid}.${token}.tmp`;
  try {
    writeFileSync(staging, reclaimerText(token), { flag: "w" });
    const fd = openSync2(staging, "r+");
    try {
      fsyncSync2(fd);
    } finally {
      closeSync2(fd);
    }
    linkSync(staging, path);
    return true;
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false;
    throw new Error(`cannot install activity reclaimer for ${path}: ${error.message}`);
  } finally {
    try {
      unlinkSync2(staging);
    } catch {
    }
  }
}
function clearDeadReclaimer(path) {
  const snapshot = fileSnapshot(path);
  if (snapshot === null) return true;
  const held = parseReclaimer(snapshot.text);
  const dead = held === null ? Date.now() - snapshot.mtimeMs > RECLAIM_LEASE_MS : pidIsGone(held.pid) || Date.now() - held.beatAtMs > RECLAIM_LEASE_MS;
  if (!dead || !stillTheSameFile(path, snapshot)) return false;
  try {
    unlinkSync2(path);
  } catch {
  }
  return true;
}
function stillReclaiming(path, token) {
  try {
    const snapshot = fileSnapshot(path);
    return snapshot !== null && parseReclaimer(snapshot.text)?.token === token;
  } catch {
    return false;
  }
}
function releaseReclaimer(path, token) {
  if (!stillReclaiming(path, token)) return;
  try {
    unlinkSync2(path);
  } catch {
  }
}
function reclaimDisconnectedActivity(path, expected, candidate) {
  const reclaimPath = `${path}.reclaim`;
  const token = randomUUID();
  if (!installReclaimer(reclaimPath, token)) {
    return clearDeadReclaimer(reclaimPath) ? "recovered" : "busy";
  }
  try {
    reachActivityTestPoint("reclaim-guard-established");
    const held = activitySnapshot(path);
    if (held === null || !sameSnapshot(held, expected)) return "retry";
    if (activityState(held.record) !== "disconnected") return "retry";
    reachActivityTestPoint("reclaim-liveness-confirmed");
    reachActivityTestPoint("reclaim-before-unlink");
    if (!stillReclaiming(reclaimPath, token)) return "retry";
    const confirmed = activitySnapshot(path);
    if (confirmed === null || !sameSnapshot(confirmed, held) || activityState(confirmed.record) !== "disconnected") {
      return "retry";
    }
    try {
      unlinkSync2(path);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return "retry";
      throw error;
    }
    reachActivityTestPoint("reclaim-before-install");
    if (!stillReclaiming(reclaimPath, token)) return "retry";
    try {
      linkSync(candidate, path);
      return "installed";
    } catch (error) {
      if (errorCode(error) === "EEXIST") return "retry";
      throw error;
    }
  } finally {
    releaseReclaimer(reclaimPath, token);
  }
}
function claimActivity(paths, label, options = {}) {
  const path = paths.activity(activityKey(label));
  const candidate = `${path}.claim.${process.pid}.${randomUUID()}`;
  const startedAt = (/* @__PURE__ */ new Date()).toISOString();
  const record = writeActivity(candidate, {
    label,
    pid: process.pid,
    started_at: startedAt,
    beat_at: startedAt,
    ...options.statusPath !== void 0 ? { status_path: options.statusPath } : {}
  });
  try {
    let recoveries = 0;
    for (; ; ) {
      const reclaimPath = `${path}.reclaim`;
      try {
        if (fileSnapshot(reclaimPath) !== null) {
          if (recoveries === 0 && clearDeadReclaimer(reclaimPath)) {
            recoveries += 1;
            continue;
          }
          throw new ActivityAlreadyExistsError(label, path, readActivity(path));
        }
      } catch (error) {
        if (error instanceof ActivityAlreadyExistsError) throw error;
        throw new Error(`cannot inspect activity reclaimer for ${path}: ${error.message}`);
      }
      try {
        linkSync(candidate, path);
        break;
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
        const existing = activitySnapshot(path);
        if (existing === null || activityState(existing.record) !== "disconnected") {
          throw new ActivityAlreadyExistsError(label, path, existing?.record ?? null);
        }
        const outcome = reclaimDisconnectedActivity(path, existing, candidate);
        if (outcome === "installed") break;
        if (outcome === "recovered" && recoveries === 0) {
          recoveries += 1;
          continue;
        }
        if (outcome === "busy" || outcome === "recovered") {
          throw new ActivityAlreadyExistsError(label, path, readActivity(path));
        }
      }
    }
  } finally {
    try {
      unlinkSync2(candidate);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
  const installed = activitySnapshot(path);
  if (installed === null || installed.record.owner_token !== record.owner_token) {
    throw new Error(`could not confirm ownership of activity '${label}' at ${path}`);
  }
  return { path, record, identity: installed.identity };
}
function retryPause(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function finishActivity(claimed, outcome, diagnostics, endedAt = (/* @__PURE__ */ new Date()).toISOString(), options = {}) {
  const attempts = Math.max(1, Math.floor(options.attempts ?? 1));
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 0);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const current = activitySnapshot(claimed.path);
    if (current === null || current.record.owner_token !== claimed.record.owner_token || !sameIdentity(current.identity, claimed.identity)) {
      diagnostics.push(`could not remove activity ${claimed.path}: ownership or file identity changed`);
      return;
    }
    reachActivityTestPoint("finish-snapshot");
    try {
      const finished = parseActivity({ ...claimed.record, ended_at: endedAt, outcome });
      if (finished === null) throw new Error(`cannot write invalid activity to ${claimed.path}`);
      const confirmed = activitySnapshot(claimed.path);
      if (confirmed === null || confirmed.record.owner_token !== claimed.record.owner_token || !sameIdentity(confirmed.identity, claimed.identity)) {
        diagnostics.push(
          `could not remove activity ${claimed.path}: ownership or file identity changed`
        );
        return;
      }
      unlinkSync2(claimed.path);
      return;
    } catch (error) {
      if (attempt === attempts) {
        diagnostics.push(`could not remove activity ${claimed.path}: ${error.message}`);
        return;
      }
      retryPause(retryDelayMs);
    }
  }
}
function scanActivities(directory, includeEnded) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const activities = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = join2(directory, entry.name);
    const record = readActivity(path);
    if (record !== null && (includeEnded || record.ended_at === void 0)) {
      activities.push({ path, record });
    }
  }
  return activities.sort(
    (left, right) => Date.parse(left.record.started_at) - Date.parse(right.record.started_at) || left.record.label.localeCompare(right.record.label)
  );
}
function readActivities(directory) {
  return scanActivities(directory, true);
}
function pidIsAlive(pid) {
  if (!validPid(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}
function activityState(activity, nowMs = Date.now(), staleMs = DEFAULT_STALE_MS) {
  if (activity === null || activity.ended_at !== void 0) return "idle";
  const beatAgeMs = nowMs - Date.parse(activity.beat_at);
  const fresh = beatAgeMs >= -MAX_FUTURE_BEAT_SKEW_MS && beatAgeMs <= staleMs;
  return pidIsAlive(activity.pid) && fresh ? "running" : "disconnected";
}
function observeActivities(directory, nowMs = Date.now(), staleMs = DEFAULT_STALE_MS) {
  const observed = [];
  for (const activity of scanActivities(directory, false)) {
    const state = activityState(activity.record, nowMs, staleMs);
    if (state === "idle") continue;
    observed.push({
      ...activity,
      state,
      beatAgeMs: Math.max(0, nowMs - Date.parse(activity.record.beat_at))
    });
  }
  return observed;
}
function startActivityHeartbeat(path, activity, intervalMs = DEFAULT_BEAT_MS) {
  return startJsonHeartbeat(path, {
    field: "beat_at",
    valueFormat: "iso",
    guard: { owner_token: activity.owner_token },
    // writeJsonAtomic pretty-prints with two spaces. Matching that shape makes a heartbeat only
    // replace fixed-width ISO timestamp bytes instead of changing the document's length.
    indent: 2,
    intervalMs
  });
}
export {
  ActivityAlreadyExistsError,
  activityKey,
  activityState,
  claimActivity,
  finishActivity,
  observeActivities,
  readActivities,
  readActivity,
  setActivityTestHookForTesting,
  startActivityHeartbeat,
  writeActivity
};
