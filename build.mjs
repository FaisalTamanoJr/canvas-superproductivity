#!/usr/bin/env node
// Build commands:
//
//   node build.mjs site               Regenerate the zip-maker page (docs/index.html,
//                                     served by GitHub Pages) and a copy for the release
//                                     (dist/canvas-plugin-maker.html).
//   node build.mjs site --check       Fail if docs/index.html is out of date.
//   node build.mjs <canvas-address>   Build one plugin zip, e.g. canvas.myschool.edu
//                                     (a pasted Calendar Feed link works too; only its
//                                     hostname is used).
//
// Super Productivity only lets a plugin contact the exact hosts in its manifest
// (no wildcards), so every school needs its own zip.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildPluginZip, parseCanvasHost } from './src/shared.mjs';

const root = dirname(fileURLToPath(import.meta.url));
export const PLUGIN_FILES = ['manifest.json', 'plugin.js', 'index.html', 'icon.svg'];

export function readPluginTemplate() {
  return PLUGIN_FILES.map((name) => ({
    name,
    text: readFileSync(join(root, 'plugin', name), 'utf8'),
  }));
}

export function renderSite() {
  const template = readFileSync(join(root, 'site', 'maker.html'), 'utf8');
  const shared = readFileSync(join(root, 'src', 'shared.mjs'), 'utf8').replace(
    /^export /gm,
    '',
  );
  const files = readPluginTemplate();
  const version = JSON.parse(files.find((f) => f.name === 'manifest.json').text).version;
  // Escape "<" so embedded HTML (e.g. "</script>") cannot end the script block.
  const filesJs =
    'const PLUGIN_FILES = ' + JSON.stringify(files).replace(/</g, '\\u003c') + ';';
  const out = template
    .replace('/*__SHARED_CODE__*/', () => shared.trim())
    .replace('/*__PLUGIN_FILES__*/', () => filesJs)
    .split('__PLUGIN_VERSION__')
    .join(version);
  if (out.includes('/*__')) throw new Error('Unfilled placeholder in site template');
  return out;
}

function main(args) {
  const [command, flag] = args;
  if (!command) {
    console.error('Usage: node build.mjs site | node build.mjs <canvas-address>');
    process.exit(1);
  }

  if (command === 'site') {
    const html = renderSite();
    const docsPath = join(root, 'docs', 'index.html');
    if (flag === '--check') {
      let current = '';
      try {
        current = readFileSync(docsPath, 'utf8');
      } catch {}
      if (current !== html) {
        console.error('docs/index.html is out of date. Run: node build.mjs site');
        process.exit(1);
      }
      console.log('docs/index.html is up to date.');
      return;
    }
    mkdirSync(join(root, 'docs'), { recursive: true });
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(docsPath, html);
    writeFileSync(join(root, 'dist', 'canvas-plugin-maker.html'), html);
    console.log('Wrote docs/index.html and dist/canvas-plugin-maker.html');
    return;
  }

  let host;
  try {
    host = parseCanvasHost(command);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  const zip = buildPluginZip(readPluginTemplate(), host);
  mkdirSync(join(root, 'dist'), { recursive: true });
  const zipPath = join(root, 'dist', `canvas-assignment-sync-${host}.zip`);
  writeFileSync(zipPath, zip);
  console.log(`Built for ${host}: ${zipPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
