#!/usr/bin/env node
// Batch mode, for when you have a pile of links in a file:
//   node cli.js https://... https://...
//   node cli.js --file links.txt --format m4a
import fs from 'node:fs';
import { extractAudio, DEFAULT_OUT_DIR, FORMATS } from './extract.js';

const argv = process.argv.slice(2);
const opts = { format: 'mp3', outDir: DEFAULT_OUT_DIR, browser: '' };
const urls = [];

for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === '--file' || arg === '-f') {
    const list = fs.readFileSync(argv[++i], 'utf8').split(/\r?\n/);
    urls.push(...list.map((l) => l.trim()).filter((l) => /^https?:\/\//i.test(l)));
  } else if (arg === '--format') opts.format = argv[++i];
  else if (arg === '--out' || arg === '-o') opts.outDir = argv[++i];
  else if (arg === '--browser') opts.browser = argv[++i];
  else if (arg === '--help' || arg === '-h') usage(0);
  else if (/^https?:\/\//i.test(arg)) urls.push(arg);
  else usage(1, `Unknown argument: ${arg}`);
}

function usage(code, message) {
  if (message) console.error(`${message}\n`);
  console.log(`reel-audio — pull the audio out of reels, shorts and videos

  node cli.js <url> [url...]
  node cli.js --file links.txt

Options:
  --file, -f <path>   read links from a text file (one per line)
  --format <fmt>      ${FORMATS.join(' | ')}   (default: mp3)
  --out, -o <dir>     save folder (default: ${DEFAULT_OUT_DIR})
  --browser <name>    borrow a browser login: chrome | edge | firefox | brave
`);
  process.exit(code);
}

if (!urls.length) usage(1, 'No links given.');
if (!FORMATS.includes(opts.format)) usage(1, `Unknown format: ${opts.format}`);

let failures = 0;
for (const [i, url] of urls.entries()) {
  const tag = `[${i + 1}/${urls.length}]`;
  process.stdout.write(`${tag} ${url}\n`);
  try {
    let lastPct = -1;
    const { file } = await extractAudio({
      url,
      ...opts,
      onUpdate: ({ pct, stage }) => {
        if (stage === 'converting') process.stdout.write('\r      converting audio...      ');
        else if (typeof pct === 'number' && Math.floor(pct) !== lastPct) {
          lastPct = Math.floor(pct);
          process.stdout.write(`\r      ${lastPct}%      `);
        }
      },
    });
    process.stdout.write(`\r      -> ${file}\n`);
  } catch (err) {
    failures += 1;
    process.stdout.write(`\r      FAILED: ${err.message}\n`);
  }
}

console.log(`\nDone. ${urls.length - failures} succeeded, ${failures} failed.`);
process.exit(failures ? 1 : 0);
