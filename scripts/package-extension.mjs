import { cp, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const output = fileURLToPath(new URL('release/extension/', root));
await mkdir(output, { recursive: true });
await cp(fileURLToPath(new URL('dist/extension/', root)), output, { recursive: true });
await writeFile(fileURLToPath(new URL('release/INSTALL.txt', root)),
  'DESKTOP APP: Run the AI Quick Answer Setup installer or portable EXE.\r\n' +
  'BROWSER EXTENSION: In chrome://extensions or edge://extensions enable Developer mode, choose Load unpacked, and select the extension folder beside this file.\r\n' +
  'The win-unpacked folder is the desktop app, not a browser extension.\r\n' +
  'Start the desktop app, then pair the extension using the token in desktop Settings.\r\n');
console.log('Packaged browser extension → release/extension (select this folder in Load unpacked)');
