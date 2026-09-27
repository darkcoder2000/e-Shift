/* Regenerates js/fallback-config.js from soundconfig.json.
 *
 * soundconfig.json is the source of truth, but fetch() is blocked on file://,
 * so index.html also ships a baked-in copy for people who just double-click it.
 * Run this after editing the JSON:
 *
 *     node tools/build-fallback.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'soundconfig.json');
const dst = join(root, 'js', 'fallback-config.js');

const json = JSON.parse(readFileSync(src, 'utf8'));
const body = [
  '/* AUTO-GENERATED from soundconfig.json by tools/build-fallback.mjs - do not edit. */',
  '/* Used only when soundconfig.json cannot be fetched (i.e. opened via file://). */',
  '(function (ES) {',
  '  ES.FALLBACK_CONFIG = ' + JSON.stringify(json, null, 2).replace(/\n/g, '\n  ') + ';',
  '})(window.ES = window.ES || {});',
  ''
].join('\n');

writeFileSync(dst, body);
console.log('wrote ' + dst + ' (' + body.length + ' bytes)');
