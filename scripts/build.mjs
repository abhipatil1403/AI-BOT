import { build } from 'esbuild';
import { mkdir, cp } from 'node:fs/promises';
const root = new URL('../', import.meta.url);
// Use fileURLToPath for Windows paths containing spaces or non-ASCII characters.
const { fileURLToPath } = await import('node:url');
const absolute = relative => fileURLToPath(new URL(relative, root));
await mkdir(absolute('dist/desktop/renderer'), { recursive: true });
await mkdir(absolute('dist/extension'), { recursive: true });
await build({ entryPoints: [absolute('apps/desktop/main.ts'), absolute('apps/desktop/preload.ts')], outdir: absolute('dist/desktop'), outExtension: { '.js': '.cjs' }, bundle: true, platform: 'node', target: 'node22', external: ['electron', 'uiohook-napi'], format: 'cjs' });
await build({ entryPoints: [absolute('apps/desktop/renderer/settings.ts'), absolute('apps/desktop/renderer/widget.ts')], outdir: absolute('dist/desktop/renderer'), bundle: true, platform: 'browser', target: 'chrome140', format: 'iife' });
for (const name of ['settings.html', 'widget.html', 'settings.css', 'widget.css']) await cp(absolute(`apps/desktop/renderer/${name}`), absolute(`dist/desktop/renderer/${name}`));
for (const [entry, output] of [
  ['background/service-worker.ts', 'background/service-worker.js'], ['content/content-script.ts', 'content/content-script.js'],
  ['popup/popup.ts', 'popup/popup.js'], ['options/options.ts', 'options/options.js'], ['overlay/widget.ts', 'overlay/widget.js']
]) await build({ entryPoints: [absolute(`apps/extension/${entry}`)], outfile: absolute(`dist/extension/${output}`), bundle: true, platform: 'browser', target: 'chrome140', format: 'iife', minify: true });
for (const name of ['manifest.json', 'popup/index.html', 'popup/style.css', 'options/index.html', 'options/style.css', 'overlay/index.html', 'overlay/widget.css']) await cp(absolute(`apps/extension/${name}`), absolute(`dist/extension/${name}`));
console.log('Built desktop → dist/desktop; Chromium extension → dist/extension');
