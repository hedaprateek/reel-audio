// The actual "link in, audio file out" logic. Shared by the web UI and the CLI.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { ROOT, BIN_DIR, ensureBins, ytdlpPath } from './bins.js';

export const DEFAULT_OUT_DIR = path.join(os.homedir(), 'Music', 'Reel Audio');
export const COOKIES_FILE = path.join(ROOT, 'cookies.txt');

export const FORMATS = ['mp3', 'm4a', 'wav', 'flac', 'original'];

const PROGRESS_RE = /\[download\]\s+([\d.]+)%/;
const DEST_RE = /\[download\] Destination: (.+)/;

/**
 * Runs yt-dlp for one URL.
 * @param {object} opts
 * @param {(update: {stage?: string, pct?: number, title?: string, line?: string}) => void} opts.onUpdate
 * @returns {Promise<{file: string, title: string}>}
 */
export async function extractAudio({
  url,
  outDir = DEFAULT_OUT_DIR,
  format = 'mp3',
  browser = '',
  embedThumbnail = true,
  allowPlaylist = false,
  onUpdate = () => {},
}) {
  await ensureBins();
  fs.mkdirSync(outDir, { recursive: true });

  // yt-dlp writes the final path here after any post-processing, which is the
  // only reliable way to learn the real filename (it changes during conversion).
  const pathFile = path.join(
    os.tmpdir(),
    `reel-audio-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
  );

  const args = [
    url,
    '--extract-audio',
    '--audio-quality', '0',
    '--no-warnings',
    '--newline',
    '--no-simulate',
    '--ffmpeg-location', BIN_DIR,
    '--paths', outDir,
    '--output', '%(title).80B [%(id)s].%(ext)s',
    '--embed-metadata',
    '--print-to-file', 'after_move:%(filepath)s', pathFile,
    '--print-to-file', 'before_dl:%(title)s', `${pathFile}.title`,
  ];

  if (format !== 'original') args.push('--audio-format', format);
  if (embedThumbnail) args.push('--embed-thumbnail');
  args.push(allowPlaylist ? '--yes-playlist' : '--no-playlist');

  // Instagram in particular usually needs a logged-in session.
  if (fs.existsSync(COOKIES_FILE)) args.push('--cookies', COOKIES_FILE);
  else if (browser) args.push('--cookies-from-browser', browser);

  return new Promise((resolve, reject) => {
    const child = spawn(ytdlpPath, args, { windowsHide: true });
    let title = '';
    const errLines = [];

    const handleLine = (line) => {
      if (!line.trim()) return;
      onUpdate({ line });

      const progress = line.match(PROGRESS_RE);
      if (progress) {
        onUpdate({ stage: 'downloading', pct: Math.min(99, Number(progress[1])) });
        return;
      }
      const dest = line.match(DEST_RE);
      if (dest && !title) {
        title = path.basename(dest[1]).replace(/\.[^.]+$/, '');
        onUpdate({ title });
      }
      if (line.includes('[ExtractAudio]')) onUpdate({ stage: 'converting', pct: 99 });
      else if (line.includes('[Metadata]') || line.includes('[ThumbnailsConvertor]')) {
        onUpdate({ stage: 'tagging', pct: 99 });
      }
    };

    const lineReader = (stream, isErr) => {
      let buf = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        buf += chunk;
        const lines = buf.split(/\r?\n/);
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (isErr) errLines.push(line);
          handleLine(line);
        }
      });
      stream.on('end', () => {
        if (buf) {
          if (isErr) errLines.push(buf);
          handleLine(buf);
        }
      });
    };

    lineReader(child.stdout, false);
    lineReader(child.stderr, true);

    child.on('error', (err) => reject(new Error(`Could not run yt-dlp: ${err.message}`)));

    child.on('close', (code) => {
      const read = (p) => {
        try {
          return fs.readFileSync(p, 'utf8').trim();
        } catch {
          return '';
        }
      };
      const finalPath = read(pathFile).split(/\r?\n/).filter(Boolean).pop() || '';
      const printedTitle = read(`${pathFile}.title`).split(/\r?\n/).filter(Boolean).pop() || '';
      fs.rmSync(pathFile, { force: true });
      fs.rmSync(`${pathFile}.title`, { force: true });

      if (code === 0 && finalPath && fs.existsSync(finalPath)) {
        resolve({ file: finalPath, title: printedTitle || title || path.basename(finalPath) });
        return;
      }
      reject(new Error(summariseError(errLines, code)));
    });
  });
}

/** Turns yt-dlp's noisy stderr into one line worth showing a human. */
function summariseError(errLines, code) {
  const raw = errLines.filter((l) => l.includes('ERROR') || l.includes('Unsupported'));
  const first = (raw[0] || errLines[errLines.length - 1] || '').replace(/^ERROR:\s*/, '').trim();

  if (/login|rate-limit|429|cookies|not available|private|restricted/i.test(first)) {
    return `${first}\nThis one needs a logged-in session — pick a browser under "Use my browser login", or drop a cookies.txt next to the app.`;
  }
  if (/Unsupported URL/i.test(first)) return `${first}\nThat link type isn't supported.`;
  if (/ffmpeg|ffprobe/i.test(first)) return `${first}\nTry running: npm run setup`;
  if (!first) return `yt-dlp exited with code ${code}.`;
  return first;
}
