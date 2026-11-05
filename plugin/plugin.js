// Canvas Assignment Sync — Super Productivity plugin
//
// Reads the Canvas Calendar Feed (.ics) and mirrors every assignment into
// Super Productivity: one project per course, one task per assignment, with
// the Canvas due date as the task's deadline and a deadline reminder N days
// before it.
//
// Rules the sync follows so it never fights the user:
//   * A task you mark done, archive or delete is never reopened or recreated.
//   * A title or note you edit yourself is never overwritten.
//   * A reminder you snooze or dismiss is never reset — unless Canvas moves the
//     due date, in which case the deadline and its reminder are re-planned.
//   * A course whose project you archive or delete stops syncing (you can
//     resume it from the plugin page).

const CANVAS_HOST = '__CANVAS_HOST__';

const STATE_KEY = 'state';
const SETTINGS_KEY = 'settings';
const SECRET_FEED_URL = 'feedUrl';
// Tasks are created with a neutral title first and renamed in a multi-field
// update: Super Productivity parses "short syntax" (#tag, +project, @date, 30m)
// out of new task titles, which would mangle titles like "Lab #3".
const PLACEHOLDER_TITLE = 'Canvas assignment';
const LATE_REMINDER_DELAY_MS = 60 * 1000;
const MAX_DESCRIPTION_CHARS = 1500;

const DEFAULT_SETTINGS = {
  remindersEnabled: true,
  reminderDaysBefore: 3,
  syncIntervalMin: 60,
  skipPastDue: true,
};

// ---------------------------------------------------------------------------
// ICS parsing
// ---------------------------------------------------------------------------

const unfoldIcs = (text) =>
  String(text)
    .replace(/\r\n?/g, '\n')
    .replace(/\n[ \t]/g, '');

const unescapeIcsText = (value) =>
  value.replace(/\\([nN,;\\])/g, (_m, c) => (c === 'n' || c === 'N' ? '\n' : c));

/** Splits "NAME;P1=a;P2=\"x:y\":value" at the first colon outside quotes. */
const parseIcsLine = (line) => {
  let inQuotes = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ':' && !inQuotes) {
      colon = i;
      break;
    }
  }
  if (colon === -1) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const [rawName, ...rawParams] = head.split(';');
  const params = {};
  for (const p of rawParams) {
    const eq = p.indexOf('=');
    if (eq === -1) continue;
    params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: rawName.toUpperCase(), params, value };
};

const parseIcs = (text) => {
  const events = [];
  let current = null;
  let nestedDepth = 0; // VALARM etc. inside a VEVENT
  for (const line of unfoldIcs(text).split('\n')) {
    if (!line) continue;
    if (line === 'BEGIN:VEVENT') {
      current = {};
      nestedDepth = 0;
      continue;
    }
    if (line === 'END:VEVENT') {
      if (current) events.push(current);
      current = null;
      continue;
    }
    if (!current) continue;
    if (line.startsWith('BEGIN:')) {
      nestedDepth++;
      continue;
    }
    if (line.startsWith('END:')) {
      nestedDepth = Math.max(0, nestedDepth - 1);
      continue;
    }
    if (nestedDepth > 0) continue;
    const prop = parseIcsLine(line);
    if (prop && !(prop.name in current)) current[prop.name] = prop;
  }
  return events;
};

/** Offset (ms) of `timeZone` from UTC at instant `ts`. */
const getTzOffsetMs = (ts, timeZone) => {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = {};
  for (const { type, value } of dtf.formatToParts(new Date(ts))) parts[type] = value;
  const asUtc = Date.UTC(
    +parts.year,
    +parts.month - 1,
    +parts.day,
    +parts.hour,
    +parts.minute,
    +parts.second,
  );
  return asUtc - Math.floor(ts / 1000) * 1000;
};

const zonedTimeToUtc = (y, mo, d, h, mi, s, timeZone) => {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const off1 = getTzOffsetMs(guess, timeZone);
  const t = guess - off1;
  const off2 = getTzOffsetMs(t, timeZone);
  return off2 === off1 ? t : guess - off2;
};

/**
 * Returns { ms, isAllDay } for a DTSTART/DUE property, or null.
 * Canvas writes assignments due at 11:59 PM as all-day (date-only) events, so
 * a date-only value means "due at 23:59 local time on that day".
 */
const parseIcsDate = (prop) => {
  if (!prop || !prop.value) return null;
  const v = prop.value.trim();
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (dateOnly) {
    const [, y, mo, d] = dateOnly.map(Number);
    return { ms: new Date(y, mo - 1, d, 23, 59, 0, 0).getTime(), isAllDay: true };
  }
  const dt = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v);
  if (!dt) return null;
  const [y, mo, d, h, mi, s] = dt.slice(1, 7).map(Number);
  if (dt[7] === 'Z') return { ms: Date.UTC(y, mo - 1, d, h, mi, s), isAllDay: false };
  const tzid = prop.params && prop.params.TZID;
  if (tzid) {
    try {
      return { ms: zonedTimeToUtc(y, mo, d, h, mi, s, tzid), isAllDay: false };
    } catch (_e) {
      // Unknown time zone name: fall back to local time below.
    }
  }
  return { ms: new Date(y, mo - 1, d, h, mi, s).getTime(), isAllDay: false };
};

/** Maps one VEVENT to an assignment, or null for non-assignment events. */
const toAssignment = (ev, host) => {
  const uid = ev.UID ? ev.UID.value.trim() : '';
  const url = ev.URL ? ev.URL.value.trim() : '';
  const uidMatch = /^event-(?:sub-assignment|assignment-override|assignment)-(\d+)/.exec(uid);
  const urlMatch = /#assignment_(\d+)/.exec(url);
  if (!uid || (!uidMatch && !urlMatch)) return null;

  const due = parseIcsDate(ev.DTSTART) || parseIcsDate(ev.DUE) || parseIcsDate(ev.DTEND);
  if (!due) return null;

  const summary = ev.SUMMARY ? unescapeIcsText(ev.SUMMARY.value).trim() : '';
  const bracket = /^(.*?)\s*\[([^\[\]]+)\]\s*$/.exec(summary);
  const title = (bracket ? bracket[1] : summary).trim() || 'Untitled assignment';
  const courseLabel = bracket ? bracket[2].trim() : '';

  const courseIdMatch = /include_contexts=course_(\d+)/.exec(url);
  const courseId = courseIdMatch ? courseIdMatch[1] : null;
  const assignmentId = urlMatch ? urlMatch[1] : uidMatch[1];
  const courseKey = courseId
    ? `course_${courseId}`
    : courseLabel
      ? `label:${courseLabel.toLowerCase()}`
      : 'unknown';

  const link =
    courseId && assignmentId
      ? `https://${host}/courses/${courseId}/assignments/${assignmentId}`
      : url || null;

  let description = ev.DESCRIPTION ? unescapeIcsText(ev.DESCRIPTION.value).trim() : '';
  if (description.length > MAX_DESCRIPTION_CHARS) {
    description = description.slice(0, MAX_DESCRIPTION_CHARS).trimEnd() + '…';
  }

  return {
    uid,
    assignmentId,
    courseId,
    courseKey,
    courseLabel: courseLabel || 'Canvas',
    title,
    dueMs: due.ms,
    isAllDay: due.isAllDay,
    link,
    description,
  };
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const hashString = (str) => {
  let h = 5381;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
};

const clampInt = (value, min, max, fallback) => {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

const sanitizeSettings = (raw) => {
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    remindersEnabled:
      typeof s.remindersEnabled === 'boolean'
        ? s.remindersEnabled
        : DEFAULT_SETTINGS.remindersEnabled,
    reminderDaysBefore: clampInt(
      s.reminderDaysBefore,
      0,
      30,
      DEFAULT_SETTINGS.reminderDaysBefore,
    ),
    syncIntervalMin: clampInt(s.syncIntervalMin, 15, 1440, DEFAULT_SETTINGS.syncIntervalMin),
    skipPastDue:
      typeof s.skipPastDue === 'boolean' ? s.skipPastDue : DEFAULT_SETTINGS.skipPastDue,
  };
};

const reminderCfgKey = (settings) =>
  settings.remindersEnabled ? `d${settings.reminderDaysBefore}` : 'off';

/**
 * When the deadline reminder should fire. Past reminder times return null,
 * or "in a minute" when `allowLate` (an assignment that shows up, or moves,
 * inside the reminder window still gets a heads-up while it is not yet due).
 */
const computeRemindAt = (dueMs, settings, now, allowLate) => {
  if (!settings.remindersEnabled) return null;
  const d = new Date(dueMs);
  d.setDate(d.getDate() - settings.reminderDaysBefore); // calendar days, DST-safe
  const remindAt = d.getTime();
  if (remindAt > now) return remindAt;
  if (allowLate && dueMs > now) return now + LATE_REMINDER_DELAY_MS;
  return null;
};

const formatDue = (a) => {
  try {
    if (typeof PluginAPI.formatDate === 'function') {
      return PluginAPI.formatDate(a.dueMs, 'datetime');
    }
  } catch (_e) {
    // fall through
  }
  return new Date(a.dueMs).toLocaleString();
};

const buildNotes = (a) => {
  const lines = [`**Course:** ${a.courseLabel}`, `**Due:** ${formatDue(a)}`];
  if (a.link) lines.push(`[Open in Canvas](${a.link})`);
  if (a.description) lines.push('', '---', '', a.description);
  return lines.join('\n');
};

const normalizeTitle = (t) => String(t || '').trim().toLowerCase();

const errMsg = (e) => (e && e.message ? e.message : String(e));

/** Accepts https:// or webcal:// Canvas feed links on the host this build allows. */
const normalizeFeedUrl = (raw) => {
  let u;
  try {
    u = new URL(String(raw || '').trim().replace(/^webcals?:\/\//i, 'https://'));
  } catch (_e) {
    throw new Error('That is not a valid link. Paste the Calendar Feed link from Canvas.');
  }
  if (u.protocol !== 'https:') {
    throw new Error('The Calendar Feed link must start with https://');
  }
  if (!/\/feeds\/calendars\/[^/]+\.ics$/i.test(u.pathname)) {
    throw new Error(
      'That does not look like a Canvas Calendar Feed link (…/feeds/calendars/….ics). ' +
        'In Canvas open Calendar → "Calendar Feed" and copy that link.',
    );
  }
  if (u.hostname.toLowerCase() !== CANVAS_HOST.toLowerCase()) {
    throw new Error(
      `This plugin was made for ${CANVAS_HOST}, but your link is on ${u.hostname}. ` +
        `Make a new plugin with this link on the Canvas Plugin Maker page and install that one.`,
    );
  }
  return u.toString();
};

const maskFeedUrl = (url) => {
  try {
    const u = new URL(url);
    const file = u.pathname.split('/').pop() || '';
    const tail = file.replace(/\.ics$/i, '').slice(-4);
    return `https://${u.hostname}/feeds/calendars/••••${tail}.ics`;
  } catch (_e) {
    return '(saved)';
  }
};

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const loadJson = async (key, fallback) => {
  try {
    const raw = await PluginAPI.loadSyncedData(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (e) {
    PluginAPI.log.warn('[canvas-sync] Could not read stored data', key, errMsg(e));
    return fallback;
  }
};

const loadSettings = async () => sanitizeSettings(await loadJson(SETTINGS_KEY, {}));

const loadState = async () => {
  const s = await loadJson(STATE_KEY, {});
  return {
    version: 1,
    courses: s.courses && typeof s.courses === 'object' ? s.courses : {},
    assignments: s.assignments && typeof s.assignments === 'object' ? s.assignments : {},
    lastSync: s.lastSync || null,
    lastSuccessAt: s.lastSuccessAt || null,
  };
};

const saveState = (state) => PluginAPI.persistDataSynced(JSON.stringify(state), STATE_KEY);

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

const fetchFeed = async (feedUrl) => {
  let text;
  try {
    text = await PluginAPI.request(feedUrl, { responseType: 'text', timeout: 30000 });
  } catch (e) {
    const msg = errMsg(e);
    if (/redirect/i.test(msg)) {
      throw new Error(
        'Canvas redirected the feed request, which plugins may not follow. ' +
          'Open the feed link in your browser and paste the final address. (' +
          msg +
          ')',
      );
    }
    throw new Error('Could not download the Calendar Feed: ' + msg);
  }
  if (typeof text !== 'string' || !text.includes('BEGIN:VCALENDAR')) {
    throw new Error(
      'Canvas did not return a calendar. The feed link may have been reset — copy it again from Canvas.',
    );
  }
  return text;
};

const deadlineChanges = (dueMs, remindAt) => ({
  deadlineWithTime: dueMs,
  deadlineDay: null,
  deadlineRemindAt: remindAt,
});

const runSync = async () => {
  const settings = await loadSettings();
  const state = await loadState();
  const now = Date.now();
  const counts = {
    found: 0,
    created: 0,
    updated: 0,
    skippedPastDue: 0,
    projectsCreated: 0,
    errors: 0,
  };

  const finish = async (ok, message) => {
    state.lastSync = { at: Date.now(), ok, message, counts };
    if (ok) state.lastSuccessAt = state.lastSync.at;
    await saveState(state);
    return state.lastSync;
  };

  const feedUrl = await PluginAPI.getSecret(SECRET_FEED_URL);
  if (!feedUrl) {
    return finish(false, 'Not set up yet: paste your Canvas Calendar Feed link.');
  }

  let assignments;
  try {
    const normalized = normalizeFeedUrl(feedUrl);
    const host = new URL(normalized).hostname;
    const text = await fetchFeed(normalized);
    const seen = new Set();
    assignments = parseIcs(text)
      .map((ev) => toAssignment(ev, host))
      .filter((a) => a && !seen.has(a.uid) && seen.add(a.uid));
  } catch (e) {
    return finish(false, errMsg(e));
  }
  counts.found = assignments.length;

  const isInitialSync = !state.lastSuccessAt;
  const remindCfg = reminderCfgKey(settings);

  const [projects, activeTasks, archivedTasks] = await Promise.all([
    PluginAPI.getAllProjects(),
    PluginAPI.getTasks(),
    PluginAPI.getArchivedTasks().catch(() => []),
  ]);
  const projectById = new Map(projects.filter((p) => !p.isArchived).map((p) => [p.id, p]));
  const taskById = new Map();
  for (const t of activeTasks) taskById.set(t.id, t);
  const archivedIds = new Set();
  for (const t of archivedTasks) {
    archivedIds.add(t.id);
    if (!taskById.has(t.id)) taskById.set(t.id, t);
  }
  const linkedTaskIds = new Set(
    Object.values(state.assignments)
      .filter((r) => r && r.taskId)
      .map((r) => r.taskId),
  );

  const resolveProjectId = async (a) => {
    const course = state.courses[a.courseKey];
    if (course && course.status === 'ignored') return null;
    if (course && course.projectId) {
      if (projectById.has(course.projectId)) {
        course.label = a.courseLabel;
        return course.projectId;
      }
      // The project was archived or deleted: treat that as "stop syncing".
      course.status = 'ignored';
      course.reason = 'project-removed';
      return null;
    }
    const existing = [...projectById.values()].find(
      (p) => normalizeTitle(p.title) === normalizeTitle(a.courseLabel),
    );
    let projectId;
    if (existing) {
      projectId = existing.id;
    } else {
      projectId = await PluginAPI.addProject({ title: a.courseLabel, icon: 'school' });
      projectById.set(projectId, { id: projectId, title: a.courseLabel });
      counts.projectsCreated++;
    }
    state.courses[a.courseKey] = { projectId, label: a.courseLabel, status: 'active' };
    return projectId;
  };

  const findTaskByMarker = (a) => {
    if (!a.assignmentId) return null;
    const marker = new RegExp(`/assignments/${a.assignmentId}(?!\\d)`);
    for (const t of taskById.values()) {
      if (!linkedTaskIds.has(t.id) && t.notes && marker.test(t.notes)) return t;
    }
    return null;
  };

  const updateLinked = async (a, rec) => {
    const task = taskById.get(rec.taskId);
    if (!task) {
      rec.status = 'deleted'; // the user deleted it: never recreate
      return;
    }
    if (task.isDone || archivedIds.has(task.id)) return;

    const changes = {};
    const currentRemindAt = task.deadlineRemindAt ?? null;
    const isDueChanged = a.dueMs !== rec.dueMs;
    if (isDueChanged) {
      Object.assign(changes, deadlineChanges(a.dueMs, computeRemindAt(a.dueMs, settings, now, true)));
    } else if (rec.remindCfg !== remindCfg && currentRemindAt === (rec.remindAt ?? null)) {
      // Reminder settings changed and the user has not touched this reminder.
      const next = computeRemindAt(a.dueMs, settings, now, false);
      if (next !== currentRemindAt) changes.deadlineRemindAt = next;
    }
    if (a.title !== rec.title && task.title === rec.title) changes.title = a.title;
    const notes = buildNotes(a);
    if (hashString(notes) !== rec.notesHash && hashString(task.notes || '') === rec.notesHash) {
      changes.notes = notes;
    }
    // Never send a title-only change: that would trigger short-syntax parsing.
    if (Object.keys(changes).length === 1 && 'title' in changes) {
      changes.notes = task.notes || '';
    }

    if (Object.keys(changes).length > 0) {
      await PluginAPI.updateTask(task.id, changes);
      counts.updated++;
      if ('deadlineRemindAt' in changes) rec.remindAt = changes.deadlineRemindAt;
      if ('title' in changes) rec.title = changes.title;
      if (changes.notes === notes) rec.notesHash = hashString(notes);
    }
    rec.dueMs = a.dueMs;
    rec.remindCfg = remindCfg;
  };

  const createTask = async (a, projectId) => {
    const notes = buildNotes(a);
    const taskId = await PluginAPI.addTask({ title: PLACEHOLDER_TITLE, projectId, notes });
    // Recorded before the rename so a failure below is repaired by the next sync.
    const rec = {
      status: 'linked',
      taskId,
      title: PLACEHOLDER_TITLE,
      dueMs: null,
      notesHash: hashString(notes),
      remindAt: null,
      remindCfg,
    };
    state.assignments[a.uid] = rec;
    linkedTaskIds.add(taskId);
    const remindAt = computeRemindAt(a.dueMs, settings, now, !isInitialSync);
    await PluginAPI.updateTask(taskId, { title: a.title, ...deadlineChanges(a.dueMs, remindAt) });
    rec.title = a.title;
    rec.dueMs = a.dueMs;
    rec.remindAt = remindAt;
    counts.created++;
  };

  // Latest due first: new tasks are added to the top of a project, so the
  // assignment due soonest ends up first in the list.
  assignments.sort((x, y) => y.dueMs - x.dueMs);

  let firstError = null;
  for (const a of assignments) {
    try {
      const rec = state.assignments[a.uid];
      if (rec && rec.status === 'deleted') continue;
      const projectId = await resolveProjectId(a);
      if (!projectId) continue;

      if (rec && rec.status === 'linked') {
        await updateLinked(a, rec);
        continue;
      }

      const existing = findTaskByMarker(a);
      if (existing) {
        // Sync data was lost (or another device created it): adopt, don't
        // duplicate. Title and notes count as the user's own from here on.
        state.assignments[a.uid] = {
          status: 'linked',
          taskId: existing.id,
          title: a.title,
          dueMs: existing.deadlineWithTime ?? null,
          notesHash: hashString(buildNotes(a)),
          remindAt: existing.deadlineRemindAt ?? null,
          remindCfg,
        };
        linkedTaskIds.add(existing.id);
        await updateLinked(a, state.assignments[a.uid]);
        continue;
      }

      if (settings.skipPastDue && a.dueMs < now) {
        state.assignments[a.uid] = { status: 'skipped', dueMs: a.dueMs };
        counts.skippedPastDue++;
        continue;
      }

      await createTask(a, projectId);
    } catch (e) {
      counts.errors++;
      if (!firstError) firstError = `"${a.title}": ${errMsg(e)}`;
      PluginAPI.log.err('[canvas-sync] Failed to sync assignment', a.uid, errMsg(e));
    }
  }

  const parts = [`${counts.found} assignments in feed`];
  if (counts.created) parts.push(`${counts.created} added`);
  if (counts.updated) parts.push(`${counts.updated} updated`);
  if (counts.projectsCreated) parts.push(`${counts.projectsCreated} course projects created`);
  if (counts.skippedPastDue) parts.push(`${counts.skippedPastDue} past-due skipped`);
  if (counts.errors) parts.push(`${counts.errors} failed (first: ${firstError})`);
  return finish(counts.errors === 0, parts.join(', '));
};

let syncPromise = null;
const sync = async ({ isManual = false } = {}) => {
  if (!syncPromise) {
    syncPromise = runSync()
      .catch((e) => ({ at: Date.now(), ok: false, message: errMsg(e) }))
      .finally(() => {
        syncPromise = null;
      });
  }
  const result = await syncPromise;
  const c = result.counts || {};
  if (isManual || !result.ok || c.created || c.updated) {
    PluginAPI.showSnack({
      msg: `Canvas sync: ${result.message}`,
      type: result.ok ? 'SUCCESS' : 'ERROR',
    });
  }
  return result;
};

// ---------------------------------------------------------------------------
// Scheduling, UI messages, lifecycle
// ---------------------------------------------------------------------------

let intervalId = null;
let startupTimeoutId = null;

const schedule = (settings) => {
  if (intervalId) clearInterval(intervalId);
  intervalId = setInterval(() => {
    sync().catch((e) => PluginAPI.log.err('[canvas-sync] Scheduled sync failed', errMsg(e)));
  }, settings.syncIntervalMin * 60 * 1000);
};

const getStatus = async () => {
  const [settings, state, feedUrl, projects] = await Promise.all([
    loadSettings(),
    loadState(),
    PluginAPI.getSecret(SECRET_FEED_URL),
    PluginAPI.getAllProjects(),
  ]);
  const titleById = new Map(projects.map((p) => [p.id, p.title]));
  const courses = Object.entries(state.courses)
    .map(([key, c]) => ({
      key,
      label: c.label,
      status: c.status,
      reason: c.reason || null,
      projectTitle: (c.projectId && titleById.get(c.projectId)) || null,
    }))
    .sort((x, y) => String(x.label).localeCompare(String(y.label)));
  return {
    host: CANVAS_HOST,
    hasFeedUrl: !!feedUrl,
    feedUrlMasked: feedUrl ? maskFeedUrl(feedUrl) : null,
    settings,
    lastSync: state.lastSync,
    isSyncing: !!syncPromise,
    courses,
  };
};

const handleMessage = async (message) => {
  const msg = message && typeof message === 'object' ? message : {};
  switch (msg.type) {
    case 'getStatus':
      return getStatus();

    case 'saveSettings': {
      const settings = sanitizeSettings({ ...(await loadSettings()), ...(msg.settings || {}) });
      let isNewFeedUrl = false;
      if (typeof msg.feedUrl === 'string' && msg.feedUrl.trim()) {
        await PluginAPI.setSecret(SECRET_FEED_URL, normalizeFeedUrl(msg.feedUrl));
        isNewFeedUrl = true;
      }
      await PluginAPI.persistDataSynced(JSON.stringify(settings), SETTINGS_KEY);
      schedule(settings);
      if (isNewFeedUrl) await sync({ isManual: true });
      return getStatus();
    }

    case 'forgetFeedUrl':
      await PluginAPI.deleteSecret(SECRET_FEED_URL);
      return getStatus();

    case 'syncNow':
      await sync({ isManual: true });
      return getStatus();

    case 'setCourseStatus': {
      const state = await loadState();
      const course = state.courses[msg.key];
      if (!course) throw new Error('Unknown course');
      if (msg.status === 'active') {
        course.status = 'active';
        if (course.reason === 'project-removed') delete course.projectId; // make a new one
        delete course.reason;
      } else {
        course.status = 'ignored';
        course.reason = 'user';
      }
      await saveState(state);
      return getStatus();
    }

    default:
      throw new Error('Unknown message type: ' + msg.type);
  }
};

PluginAPI.onMessage(handleMessage);

const start = async () => {
  const settings = await loadSettings();
  schedule(settings);
  startupTimeoutId = setTimeout(() => {
    startupTimeoutId = null;
    sync().catch((e) => PluginAPI.log.err('[canvas-sync] Startup sync failed', errMsg(e)));
  }, 5000);
};

if (typeof PluginAPI.onUnload === 'function') {
  PluginAPI.onUnload(() => {
    if (intervalId) clearInterval(intervalId);
    if (startupTimeoutId) clearTimeout(startupTimeoutId);
    intervalId = null;
    startupTimeoutId = null;
  });
}

if (typeof PluginAPI.onReady === 'function') {
  PluginAPI.onReady(start);
} else {
  start();
}

// Test hook: the real PluginAPI has no __test property.
if (PluginAPI.__test && typeof PluginAPI.__test === 'object') {
  PluginAPI.__test.exports = {
    parseIcs,
    parseIcsDate,
    toAssignment,
    computeRemindAt,
    normalizeFeedUrl,
    sanitizeSettings,
    sync,
    handleMessage,
  };
}
