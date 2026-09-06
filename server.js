// Tiny zero-dependency web app: paste links, get audio files.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureBins, updateYtdlp } from './bins.js';
import { extractAudio, DEFAULT_OUT_DIR, COOKIES_FILE, FORMATS } from './extract.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 5599);
const MAX_PARALLEL = 3;
const SETTINGS_FILE = path.join(ROOT, 'settings.json');

const settings = loadSettings();
const jobs = new Map();
const queue = [];
let running = 0;
let jobSeq = 0;

function loadSettings() {
  const defaults = {
    outDir: DEFAULT_OUT_DIR,
    format: 'mp3',
    browser: '',
    embedThumbnail: true,
    allowPlaylist: false,
  };
  try {
    return { ...defaults, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
  } catch {
    return defaults;
  }
}

function saveSettings() {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

function addJob(url) {
  const job = {
    id: String(++jobSeq),
    url,
    title: shortUrl(url),
    status: 'queued',
    stage: 'queued',
    pct: 0,
    file: null,
    error: null,
    addedAt: Date.now(),
  };
  jobs.set(job.id, job);
  queue.push(job.id);
  pump();
  return job;
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, '')}${u.pathname}`.slice(0, 70);
  } catch {
    return url.slice(0, 70);
  }
}

function pump() {
  while (running < MAX_PARALLEL && queue.length) {
    const job = jobs.get(queue.shift());
    if (!job || job.status !== 'queued') continue;
    running += 1;
    runJob(job).finally(() => {
      running -= 1;
      pump();
    });
  }
}

async function runJob(job) {
  job.status = 'running';
  job.stage = 'starting';
  try {
    const { file, title } = await extractAudio({
      url: job.url,
      outDir: settings.outDir,
      format: settings.format,
      browser: settings.browser,
      embedThumbnail: settings.embedThumbnail,
      allowPlaylist: settings.allowPlaylist,
      onUpdate: (u) => {
        if (u.stage) job.stage = u.stage;
        if (typeof u.pct === 'number') job.pct = u.pct;
        if (u.title) job.title = u.title;
      },
    });
    job.file = file;
    job.title = title;
    job.size = fs.statSync(file).size;
    job.pct = 100;
    job.stage = 'done';
    job.status = 'done';
  } catch (err) {
    job.status = 'error';
    job.stage = 'failed';
    job.error = err.message;
  }
}

// ---------------------------------------------------------------- HTTP layer

function json(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) reject(new Error('Request too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(err);
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const route = `${req.method} ${url.pathname}`;

  try {
    if (route === 'GET /') {
      const html = fs.readFileSync(path.join(ROOT, 'ui.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    if (route === 'GET /api/state') {
      json(res, 200, {
        settings,
        hasCookiesFile: fs.existsSync(COOKIES_FILE),
        formats: FORMATS,
        jobs: [...jobs.values()].sort((a, b) => b.addedAt - a.addedAt).slice(0, 100),
      });
      return;
    }

    if (route === 'POST /api/jobs') {
      const body = await readBody(req);
      const urls = String(body.urls || '')
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter((s) => /^https?:\/\//i.test(s));
      if (!urls.length) {
        json(res, 400, { error: 'No valid links found. Paste full https:// URLs, one per line.' });
        return;
      }
      json(res, 200, { added: urls.map(addJob).map((j) => j.id) });
      return;
    }

    if (route === 'POST /api/settings') {
      const body = await readBody(req);
      if (typeof body.outDir === 'string' && body.outDir.trim()) settings.outDir = body.outDir.trim();
      if (FORMATS.includes(body.format)) settings.format = body.format;
      if (typeof body.browser === 'string') settings.browser = body.browser;
      if (typeof body.embedThumbnail === 'boolean') settings.embedThumbnail = body.embedThumbnail;
      if (typeof body.allowPlaylist === 'boolean') settings.allowPlaylist = body.allowPlaylist;
      saveSettings();
      json(res, 200, { settings });
      return;
    }

    if (route === 'POST /api/clear') {
      for (const [id, job] of jobs) if (job.status === 'done' || job.status === 'error') jobs.delete(id);
      json(res, 200, { ok: true });
      return;
    }

    if (route === 'POST /api/update-ytdlp') {
      const message = await updateYtdlp();
      json(res, 200, { message });
      return;
    }

    if (route === 'GET /api/file') {
      const job = jobs.get(url.searchParams.get('id'));
      if (!job?.file || !fs.existsSync(job.file)) {
        json(res, 404, { error: 'File not found' });
        return;
      }
      const name = path.basename(job.file);
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': fs.statSync(job.file).size,
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      });
      fs.createReadStream(job.file).pipe(res);
      return;
    }

    if (route === 'POST /api/reveal') {
      const body = await readBody(req);
      const job = jobs.get(body.id);
      const target = job?.file && fs.existsSync(job.file) ? job.file : settings.outDir;
      if (process.platform === 'win32') {
        spawn('explorer', job?.file ? ['/select,', target] : [target], { detached: true }).unref();
      } else {
        spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [path.dirname(target)], {
          detached: true,
        }).unref();
      }
      json(res, 200, { ok: true });
      return;
    }

    json(res, 404, { error: 'Not found' });
  } catch (err) {
    const badInput = err instanceof SyntaxError || /Request too large/.test(err.message);
    json(res, badInput ? 400 : 500, { error: err.message });
  }
});

const banner = `
  Reel Audio  ->  http://localhost:${PORT}
  Saving to:  ${settings.outDir}
  Press Ctrl+C to stop.
`;

ensureBins()
  .then(() => {
    server.listen(PORT, '127.0.0.1', () => {
      console.log(banner);
      if (process.platform === 'win32' && !process.env.NO_OPEN) {
        spawn('cmd', ['/c', 'start', '', `http://localhost:${PORT}`], { detached: true }).unref();
      }
    });
  })
  .catch((err) => {
    console.error(`Setup failed: ${err.message}`);
    process.exit(1);
  });
