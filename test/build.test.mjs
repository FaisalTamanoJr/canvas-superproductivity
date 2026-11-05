// Run with: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderSite, readPluginTemplate, PLUGIN_FILES } from '../build.mjs';
import { buildPluginZip, parseCanvasHost } from '../src/shared.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let hasUnzip = true;
try {
  execFileSync('unzip', ['-v'], { stdio: 'ignore' });
} catch {
  hasUnzip = false;
}

function unzipAll(bytes) {
  const dir = mkdtempSync(join(tmpdir(), 'canvas-sync-zip-'));
  try {
    const zipPath = join(dir, 'p.zip');
    writeFileSync(zipPath, bytes);
    execFileSync('unzip', ['-tq', zipPath]); // throws on a corrupt zip
    const names = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' })
      .trim()
      .split('\n');
    const files = {};
    for (const n of names) files[n] = execFileSync('unzip', ['-p', zipPath, n], { encoding: 'utf8' });
    return files;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('parseCanvasHost accepts feed links, page links and bare addresses', () => {
  assert.equal(
    parseCanvasHost('https://Canvas.MySchool.edu/feeds/calendars/user_abc.ics'),
    'canvas.myschool.edu',
  );
  assert.equal(parseCanvasHost('webcal://school.instructure.com/feeds/calendars/x.ics'), 'school.instructure.com');
  assert.equal(parseCanvasHost('  canvas.myschool.edu/courses/12  '), 'canvas.myschool.edu');
  assert.throws(() => parseCanvasHost(''), /Paste/);
  assert.throws(() => parseCanvasHost('hello'), /Canvas address/);
  assert.throws(() => parseCanvasHost('https://localhost/x'), /Canvas address/);
});

test('docs/index.html is up to date with the plugin source', () => {
  const current = readFileSync(join(root, 'docs', 'index.html'), 'utf8');
  assert.equal(current, renderSite(), 'run: node build.mjs site');
});

test('zip maker page builds a valid plugin zip for any school', { skip: !hasUnzip && 'unzip not installed' }, () => {
  const html = renderSite();
  const core = /<script id="core">([\s\S]*?)<\/script>/.exec(html)[1];
  const makePluginZip = new Function(`${core}\nreturn makePluginZip;`)();

  const zip = makePluginZip('https://canvas.someschool.edu/feeds/calendars/user_Secret123.ics');
  assert.equal(zip.host, 'canvas.someschool.edu');
  assert.equal(zip.filename, 'canvas-assignment-sync-canvas.someschool.edu.zip');

  const files = unzipAll(zip.bytes);
  assert.deepEqual(Object.keys(files).sort(), [...PLUGIN_FILES].sort());
  const manifest = JSON.parse(files['manifest.json']);
  assert.deepEqual(manifest.allowedHosts, ['canvas.someschool.edu']);
  for (const [name, text] of Object.entries(files)) {
    assert.ok(!text.includes('__CANVAS_HOST__'), `${name} still has the placeholder`);
    assert.ok(!text.includes('Secret123'), 'the feed link is never written into the plugin');
  }
  assert.ok(files['plugin.js'].includes("const CANVAS_HOST = 'canvas.someschool.edu';"));

  // Same bytes as the command-line build.
  const cli = buildPluginZip(readPluginTemplate(), 'canvas.someschool.edu');
  assert.deepEqual(Buffer.from(zip.bytes), Buffer.from(cli));
});
