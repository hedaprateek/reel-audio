// Fetches the two binaries this app needs (yt-dlp + ffmpeg) into ./bin.
// Nothing is installed system-wide; delete the bin folder to start over.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const BIN_DIR = path.join(ROOT, 'bin');

const IS_WIN = os.platform() === 'win32';
const EXE = IS_WIN ? '.exe' : '';

const YTDLP_ASSET = IS_WIN
  ? 'yt-dlp.exe'
  : os.platform() === 'darwin'
    ? 'yt-dlp_macos'
    : 'yt-dlp';
const YTDLP_URL = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${YTDLP_ASSET}`;
const FFMPEG_ZIP_URL =
  'https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip';

export const ytdlpPath = path.join(BIN_DIR, `yt-dlp${EXE}`);
export const ffmpegPath = path.join(BIN_DIR, `ffmpeg${EXE}`);

const log = (msg) => process.stdout.write(`${msg}\n`);

async function downloadTo(url, dest, label) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`${label}: HTTP ${res.status}`);

  const total = Number(res.headers.get('content-length') || 0);
  let seen = 0;
  let lastShown = -1;
  const tmp = `${dest}.part`;

  async function* count(source) {
    for await (const chunk of source) {
      seen += chunk.length;
      const pct = total ? Math.floor((seen / total) * 100) : -1;
      if (pct !== lastShown && pct % 5 === 0) {
        lastShown = pct;
        process.stdout.write(`\r  ${label}: ${pct}%   `);
      }
      yield chunk;
    }
  }

  await pipeline(Readable.fromWeb(res.body), count, fs.createWriteStream(tmp));
  fs.renameSync(tmp, dest);
  process.stdout.write(`\r  ${label}: done          \n`);
}

async function installYtdlp() {
  log('Downloading yt-dlp (~17 MB)...');
  await downloadTo(YTDLP_URL, ytdlpPath, 'yt-dlp');
  if (!IS_WIN) fs.chmodSync(ytdlpPath, 0o755);
}

async function installFfmpeg() {
  if (!IS_WIN) {
    throw new Error(
      'Automatic ffmpeg download is Windows-only. Install ffmpeg yourself and put it on PATH.',
    );
  }
  const zip = path.join(BIN_DIR, 'ffmpeg.zip');
  const stage = path.join(BIN_DIR, '_ffmpeg_stage');

  if (!fs.existsSync(zip)) {
    log('Downloading ffmpeg (~45 MB, one time)...');
    await downloadTo(FFMPEG_ZIP_URL, zip, 'ffmpeg');
  }

  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  // Windows 10+ ships bsdtar, which reads zips — but a Git/MSYS "tar" earlier on
  // PATH is GNU tar, which cannot. Address System32 directly. Paths stay relative
  // to cwd because bsdtar treats "C:\..." as a remote host and refuses it.
  log('Unpacking ffmpeg...');
  const systemTar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  const tarExe = fs.existsSync(systemTar) ? systemTar : 'tar';
  await execFileAsync(tarExe, ['-xf', 'ffmpeg.zip', '-C', '_ffmpeg_stage'], { cwd: BIN_DIR });

  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/^(ffmpeg|ffprobe)\.exe$/i.test(entry.name)) found.push(full);
    }
  };
  walk(stage);
  if (!found.some((f) => /ffmpeg\.exe$/i.test(f))) {
    throw new Error('ffmpeg.exe was not found inside the downloaded archive.');
  }
  for (const src of found) fs.copyFileSync(src, path.join(BIN_DIR, path.basename(src)));

  fs.rmSync(stage, { recursive: true, force: true });
  fs.rmSync(zip, { force: true });
}

/** Makes sure both binaries exist locally; downloads whatever is missing. */
export async function ensureBins() {
  fs.mkdirSync(BIN_DIR, { recursive: true });
  if (!fs.existsSync(ytdlpPath)) await installYtdlp();
  if (!fs.existsSync(ffmpegPath)) await installFfmpeg();
  return { ytdlpPath, ffmpegPath, ffmpegDir: BIN_DIR };
}

/** yt-dlp breaks whenever Instagram/YouTube change things, so keep it updatable. */
export async function updateYtdlp() {
  await ensureBins();
  const { stdout, stderr } = await execFileAsync(ytdlpPath, ['-U'], { timeout: 120_000 });
  return `${stdout}${stderr}`.trim() || 'yt-dlp is already up to date.';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  ensureBins()
    .then(() => log('\nReady. Binaries are in ./bin'))
    .catch((err) => {
      console.error(`\nSetup failed: ${err.message}`);
      process.exit(1);
    });
}
