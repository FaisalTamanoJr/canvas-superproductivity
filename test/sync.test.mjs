// Run with: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The plugin schedules its periodic sync with setInterval; record instead of
// running so the test process can exit.
const scheduledIntervals = [];
globalThis.setInterval = (fn, ms) => {
  scheduledIntervals.push(ms);
  return scheduledIntervals.length;
};
globalThis.clearInterval = () => {};

const HOST = 'canvas.example.edu';
const FEED_URL = `https://${HOST}/feeds/calendars/user_AbCdEf123456.ics`;
const DAY = 86400000;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pluginCode = readFileSync(join(root, 'plugin', 'plugin.js'), 'utf8').split(
  '__CANVAS_HOST__',
).join(HOST);

// ---------------------------------------------------------------------------
// Mock of the Super Productivity v19.3.0 plugin API (behaviour checked against
// plugin-bridge.service.ts): addTask accepts only PluginCreateTaskData keys,
// updateTask rejects relational fields, and short-syntax parsing runs on new
// titles and title-only updates — which the plugin must avoid.
// ---------------------------------------------------------------------------
const CREATE_KEYS = new Set([
  'title', 'projectId', 'tagIds', 'notes', 'timeEstimate', 'parentId', 'isDone', 'dueDay',
]);

function createMockApi({ feed }) {
  let nextId = 1;
  const api = {
    feed,
    feedRequests: [],
    secrets: {},
    synced: {},
    projects: [{ id: 'INBOX_PROJECT', title: 'Inbox', isArchived: false }],
    tasks: new Map(),
    archived: new Map(),
    snacks: [],
    updates: [],
    shortSyntaxViolations: [],
    __test: {},
    log: { warn() {}, err() {}, log() {}, info() {} },
    onReady() {}, // never start timers in tests
    onUnload() {},
    onMessage(fn) {
      api.messageHandler = fn;
    },
    formatDate: (ms) => new Date(ms).toISOString(),
    showSnack: (cfg) => api.snacks.push(cfg),
    async getSecret(k) {
      return api.secrets[k] ?? null;
    },
    async setSecret(k, v) {
      api.secrets[k] = v;
    },
    async deleteSecret(k) {
      delete api.secrets[k];
    },
    async persistDataSynced(data, key) {
      api.synced[key] = data;
    },
    async loadSyncedData(key) {
      return api.synced[key] ?? null;
    },
    async request(url, opts) {
      api.feedRequests.push({ url, opts });
      if (new URL(url).hostname !== HOST) throw new Error('host not allowed');
      return api.feed;
    },
    async getAllProjects() {
      return api.projects.filter((p) => !p.isArchived).map((p) => ({ ...p }));
    },
    async addProject(data) {
      const id = 'p' + nextId++;
      api.projects.push({ isArchived: false, ...data, id });
      return id;
    },
    async getTasks() {
      return [...api.tasks.values()].map((t) => ({ ...t }));
    },
    async getArchivedTasks() {
      return [...api.archived.values()].map((t) => ({ ...t }));
    },
    async addTask(data) {
      for (const k of Object.keys(data)) {
        if (!CREATE_KEYS.has(k)) throw new Error('addTask: unsupported field ' + k);
      }
      if (data.projectId && !api.projects.some((p) => p.id === data.projectId)) {
        throw new Error('project not found');
      }
      if (/[#+@]/.test(data.title)) api.shortSyntaxViolations.push(data.title);
      const id = 't' + nextId++;
      api.tasks.set(id, {
        id, title: data.title, notes: data.notes || '', projectId: data.projectId,
        isDone: false, tagIds: [], subTaskIds: [],
      });
      return id;
    },
    async updateTask(id, changes) {
      if ('parentId' in changes || 'subTaskIds' in changes) throw new Error('rejected field');
      const keys = Object.keys(changes);
      if (keys.length === 1 && keys[0] === 'title') api.shortSyntaxViolations.push(changes.title);
      const t = api.tasks.get(id);
      if (!t) throw new Error('Task not found');
      api.updates.push({ id, changes });
      Object.assign(t, changes);
    },
  };
  new Function('plugin', 'PluginAPI', `'use strict';\n${pluginCode}`)(api, api);
  api.x = api.__test.exports;
  api.send = (message) => api.messageHandler(message);
  return api;
}

// ---------------------------------------------------------------------------
// ICS fixtures (shape of a real Canvas Calendar Feed)
// ---------------------------------------------------------------------------
const icsDate = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

function vevent({ uid, summary, dtstart, url, description = '' }) {
  return [
    'BEGIN:VEVENT',
    `DTEND${dtstart}`,
    `DTSTART${dtstart}`,
    `SUMMARY:${summary}`,
    `UID:${uid}`,
    url ? `URL;VALUE=URI:${url}` : null,
    description ? `DESCRIPTION:${description}` : null,
    'END:VEVENT',
  ]
    .filter(Boolean)
    .join('\r\n');
}

function feedOf(...events) {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Instructure//Canvas//EN',
    'X-WR-CALNAME:Student Calendar (Canvas)',
    ...events,
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

const assignmentUrl = (courseId, id) =>
  `https://${HOST}/calendar?include_contexts=course_${courseId}&month=11&year=2026#assignment_${id}`;

function assignment(id, courseId, courseLabel, title, dueMs, extra = {}) {
  return vevent({
    uid: `event-assignment-${id}`,
    summary: `${title} [${courseLabel}]`,
    dtstart: `:${icsDate(dueMs)}`,
    url: assignmentUrl(courseId, id),
    ...extra,
  });
}

async function setUp(feed) {
  const api = createMockApi({ feed });
  await api.send({ type: 'saveSettings', settings: {}, feedUrl: FEED_URL });
  return api;
}

const taskByTitle = (api, title) => [...api.tasks.values()].find((t) => t.title === title);

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test('parses folded lines, escapes, UTC, TZID and date-only values', () => {
  const api = createMockApi({ feed: '' });
  const { parseIcs, toAssignment } = api.x;
  const text = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'DTSTART;TZID=America/New_York:20261110T235900',
    'SUMMARY:Lab #3: Circuits\\, part 1 [PHYS 2',
    ' 01-02]',
    'UID:event-assignment-501',
    'URL;VALUE=URI:' + assignmentUrl(77, 501),
    'DESCRIPTION:Line one\\nLine two',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'DTSTART;VALUE=DATE:20261112',
    'SUMMARY:Essay [ENGL 101]',
    'UID:event-assignment-502',
    'URL;VALUE=URI:' + assignmentUrl(78, 502),
    'END:VEVENT',
    'BEGIN:VEVENT',
    'DTSTART:20261113T150000Z',
    'SUMMARY:Lecture [PHYS 201-02]',
    'UID:event-calendar-event-900',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  const events = parseIcs(text);
  assert.equal(events.length, 3);
  const [a, b, c] = events.map((e) => toAssignment(e, HOST));

  assert.equal(a.title, 'Lab #3: Circuits, part 1');
  assert.equal(a.courseLabel, 'PHYS 201-02');
  assert.equal(a.courseKey, 'course_77');
  assert.equal(a.assignmentId, '501');
  assert.equal(a.dueMs, Date.UTC(2026, 10, 11, 4, 59, 0)); // 23:59 EST = 04:59Z next day
  assert.equal(a.link, `https://${HOST}/courses/77/assignments/501`);
  assert.equal(a.description, 'Line one\nLine two');

  assert.equal(b.isAllDay, true);
  assert.equal(b.dueMs, new Date(2026, 10, 12, 23, 59).getTime());

  assert.equal(c, null, 'calendar events are not assignments');
});

test('reminder is N calendar days before the deadline', () => {
  const api = createMockApi({ feed: '' });
  const { computeRemindAt, sanitizeSettings } = api.x;
  const s = sanitizeSettings({});
  const now = new Date(2026, 10, 1, 12).getTime();
  const due = new Date(2026, 10, 20, 23, 59).getTime();
  assert.equal(computeRemindAt(due, s, now, false), new Date(2026, 10, 17, 23, 59).getTime());

  const soon = now + 2 * DAY;
  assert.equal(computeRemindAt(soon, s, now, false), null);
  assert.equal(computeRemindAt(soon, s, now, true), now + 60000);
  assert.equal(computeRemindAt(due, { ...s, remindersEnabled: false }, now, true), null);
});

test('rejects feed links for other hosts or non-feed pages', async () => {
  const api = createMockApi({ feed: '' });
  assert.throws(() => api.x.normalizeFeedUrl('https://other.edu/feeds/calendars/user_x.ics'), /Plugin Maker/);
  assert.throws(() => api.x.normalizeFeedUrl(`https://${HOST}/calendar`), /Calendar Feed/);
  assert.equal(
    api.x.normalizeFeedUrl(`webcal://${HOST}/feeds/calendars/user_x.ics`),
    `https://${HOST}/feeds/calendars/user_x.ics`,
  );
  await assert.rejects(
    api.send({ type: 'saveSettings', feedUrl: 'https://evil.com/feeds/calendars/user_x.ics' }),
    /was made for/,
  );
  assert.equal(api.secrets.feedUrl, undefined);
});

// ---------------------------------------------------------------------------
// Sync behaviour
// ---------------------------------------------------------------------------

test('first sync: one project per course, one task per assignment, deadline + reminder', async () => {
  const now = Date.now();
  const dueA = now + 10 * DAY;
  const dueB = now + 5 * DAY;
  const dueSoon = now + 1 * DAY;
  const feed = feedOf(
    assignment(1, 11, 'MATH 101', 'Homework #1 +extra @home 30m', dueA),
    assignment(2, 11, 'MATH 101', 'Quiz 2', dueB),
    assignment(3, 22, 'HIST 210', 'Reading response', dueSoon),
    assignment(4, 22, 'HIST 210', 'Old essay', now - 3 * DAY),
    vevent({ uid: 'event-calendar-event-9', summary: 'Office hours [HIST 210]', dtstart: `:${icsDate(dueA)}` }),
  );
  const api = await setUp(feed);

  const titles = api.projects.map((p) => p.title).sort();
  assert.deepEqual(titles, ['HIST 210', 'Inbox', 'MATH 101']);
  assert.equal(api.tasks.size, 3, 'past-due assignment and calendar event are skipped');
  assert.deepEqual(api.shortSyntaxViolations, [], 'titles never go through short syntax');

  const hw = taskByTitle(api, 'Homework #1 +extra @home 30m');
  assert.ok(hw, 'title kept literally');
  const math = api.projects.find((p) => p.title === 'MATH 101');
  assert.equal(hw.projectId, math.id);
  assert.equal(hw.deadlineWithTime, Math.floor(dueA / 1000) * 1000);
  assert.equal(hw.deadlineDay, null);
  const expectedRemind = new Date(hw.deadlineWithTime);
  expectedRemind.setDate(expectedRemind.getDate() - 3);
  assert.equal(hw.deadlineRemindAt, expectedRemind.getTime());
  assert.match(hw.notes, /\[Open in Canvas\]\(https:\/\/canvas\.example\.edu\/courses\/11\/assignments\/1\)/);

  const reading = taskByTitle(api, 'Reading response');
  assert.equal(reading.deadlineRemindAt, null, 'no instant reminders on the very first sync');

  const status = await api.send({ type: 'getStatus' });
  assert.equal(status.lastSync.ok, true);
  assert.equal(status.courses.length, 2);
  assert.match(status.feedUrlMasked, /••••3456\.ics$/);
  assert.ok(!JSON.stringify(api.synced).includes('AbCdEf'), 'feed link never lands in synced data');
});

test('second sync is idempotent', async () => {
  const due = Date.now() + 10 * DAY;
  const api = await setUp(feedOf(assignment(1, 11, 'MATH 101', 'HW 1', due)));
  const updatesBefore = api.updates.length;
  await api.send({ type: 'syncNow' });
  await api.send({ type: 'syncNow' });
  assert.equal(api.tasks.size, 1);
  assert.equal(api.projects.length, 2);
  assert.equal(api.updates.length, updatesBefore, 'nothing to change');
});

test('moved due date re-plans deadline and reminder; new late assignment reminds now', async () => {
  const now = Date.now();
  const api = await setUp(feedOf(assignment(1, 11, 'MATH 101', 'HW 1', now + 10 * DAY)));
  const newDue = now + 20 * DAY;
  api.feed = feedOf(
    assignment(1, 11, 'MATH 101', 'HW 1', newDue),
    assignment(2, 11, 'MATH 101', 'Pop quiz', now + DAY),
  );
  await api.send({ type: 'syncNow' });

  const hw = taskByTitle(api, 'HW 1');
  assert.equal(hw.deadlineWithTime, Math.floor(newDue / 1000) * 1000);
  const r = new Date(hw.deadlineWithTime);
  r.setDate(r.getDate() - 3);
  assert.equal(hw.deadlineRemindAt, r.getTime());

  const quiz = taskByTitle(api, 'Pop quiz');
  assert.ok(quiz.deadlineRemindAt > now && quiz.deadlineRemindAt <= Date.now() + 61000);
});

test('done, deleted, renamed and snoozed tasks are left alone', async () => {
  const now = Date.now();
  const api = await setUp(
    feedOf(
      assignment(1, 11, 'MATH 101', 'Done one', now + 10 * DAY),
      assignment(2, 11, 'MATH 101', 'Deleted one', now + 10 * DAY),
      assignment(3, 11, 'MATH 101', 'Renamed one', now + 10 * DAY),
      assignment(4, 11, 'MATH 101', 'Snoozed one', now + 10 * DAY),
    ),
  );
  const done = taskByTitle(api, 'Done one');
  done.isDone = true;
  api.tasks.delete(taskByTitle(api, 'Deleted one').id);
  const renamed = taskByTitle(api, 'Renamed one');
  renamed.title = 'My own name';
  renamed.notes = 'my notes';
  const snoozed = taskByTitle(api, 'Snoozed one');
  snoozed.deadlineRemindAt = now + 9 * DAY;

  api.feed = feedOf(
    assignment(1, 11, 'MATH 101', 'Done one', now + 12 * DAY),
    assignment(2, 11, 'MATH 101', 'Deleted one', now + 12 * DAY),
    assignment(3, 11, 'MATH 101', 'Renamed one (v2)', now + 10 * DAY),
    assignment(4, 11, 'MATH 101', 'Snoozed one', now + 10 * DAY),
  );
  await api.send({ type: 'saveSettings', settings: { reminderDaysBefore: 2 } });
  await api.send({ type: 'syncNow' });

  assert.equal(done.isDone, true);
  assert.equal(done.deadlineWithTime, Math.floor((now + 10 * DAY) / 1000) * 1000, 'done task untouched');
  assert.equal(api.tasks.size, 3, 'deleted task not recreated');
  assert.equal(renamed.title, 'My own name');
  assert.equal(renamed.notes, 'my notes');
  assert.equal(snoozed.deadlineRemindAt, now + 9 * DAY, 'user-changed reminder kept');
  assert.deepEqual(api.shortSyntaxViolations, []);
});

test('reminder setting change applies to untouched open tasks', async () => {
  const now = Date.now();
  const api = await setUp(feedOf(assignment(1, 11, 'MATH 101', 'HW', now + 10 * DAY)));
  await api.send({ type: 'saveSettings', settings: { reminderDaysBefore: 1 } });
  await api.send({ type: 'syncNow' });
  const hw = taskByTitle(api, 'HW');
  const r = new Date(hw.deadlineWithTime);
  r.setDate(r.getDate() - 1);
  assert.equal(hw.deadlineRemindAt, r.getTime());

  await api.send({ type: 'saveSettings', settings: { remindersEnabled: false } });
  await api.send({ type: 'syncNow' });
  assert.equal(hw.deadlineRemindAt, null);
});

test('Canvas title change updates an untouched task without title-only updates', async () => {
  const now = Date.now();
  const api = await setUp(feedOf(assignment(1, 11, 'MATH 101', 'HW', now + 10 * DAY)));
  api.feed = feedOf(assignment(1, 11, 'MATH 101', 'HW #2 (revised)', now + 10 * DAY));
  await api.send({ type: 'syncNow' });
  assert.ok(taskByTitle(api, 'HW #2 (revised)'));
  assert.deepEqual(api.shortSyntaxViolations, []);
});

test('archived course project pauses the course; resume creates a fresh project', async () => {
  const now = Date.now();
  const api = await setUp(feedOf(assignment(1, 11, 'MATH 101', 'HW', now + 10 * DAY)));
  const math = api.projects.find((p) => p.title === 'MATH 101');
  math.isArchived = true;
  api.feed = feedOf(
    assignment(1, 11, 'MATH 101', 'HW', now + 10 * DAY),
    assignment(2, 11, 'MATH 101', 'HW 2', now + 11 * DAY),
  );
  await api.send({ type: 'syncNow' });
  assert.equal(api.tasks.size, 1, 'no new tasks for a paused course');
  let status = await api.send({ type: 'getStatus' });
  assert.equal(status.courses[0].status, 'ignored');

  status = await api.send({ type: 'setCourseStatus', key: 'course_11', status: 'active' });
  await api.send({ type: 'syncNow' });
  const fresh = api.projects.filter((p) => p.title === 'MATH 101' && !p.isArchived);
  assert.equal(fresh.length, 1);
  assert.equal(taskByTitle(api, 'HW 2').projectId, fresh[0].id);
});

test('lost sync state adopts existing tasks and projects instead of duplicating', async () => {
  const now = Date.now();
  const feed = feedOf(assignment(1, 11, 'MATH 101', 'HW', now + 10 * DAY));
  const api = await setUp(feed);
  delete api.synced.state;
  await api.send({ type: 'syncNow' });
  assert.equal(api.tasks.size, 1);
  assert.equal(api.projects.filter((p) => p.title === 'MATH 101').length, 1);
});

test('a non-calendar response reports an error without touching tasks', async () => {
  const api = await setUp('<html>Login</html>');
  const status = await api.send({ type: 'getStatus' });
  assert.equal(status.lastSync.ok, false);
  assert.match(status.lastSync.message, /did not return a calendar/);
  assert.equal(api.tasks.size, 0);
  assert.ok(api.snacks.some((s) => s.type === 'ERROR'));
});
