# Reel Audio

Paste links to Instagram reels, YouTube shorts, TikToks or regular videos. Get the audio
back as tagged MP3 files.

## Running it

Double-click **`Start Reel Audio.cmd`**. It opens <http://localhost:5599> in your browser.

Or from a terminal:

```
npm start
```

First run downloads `yt-dlp` and `ffmpeg` into `./bin` (about 60 MB, one time). Nothing is
installed system-wide — delete the folder and it's gone.

## Using it

Paste one link per line, hit **Extract audio**. Up to 3 run at once. Finished files are
saved to `C:\Users\<you>\Music\Reel Audio` and can also be downloaded straight from the
page. `Ctrl+Enter` in the box submits.

**Formats:** mp3 (default), m4a, wav, flac, or *original* — which pulls the source audio
stream out without re-encoding, so there's no second-generation quality loss. Cover art
and title/artist tags are embedded automatically.

## Batch mode

```
npm run cli -- "https://www.instagram.com/reel/..." "https://youtube.com/shorts/..."
npm run cli -- --file links.txt --format m4a
```

`node --use-system-ca cli.js --help` lists the rest.

## When a link fails

**"needs a logged-in session"** — Instagram in particular blocks logged-out requests.
Two options:

1. Under *Options*, set **Use my browser login** to the browser where you're signed in.
   Close that browser first; it locks its own cookie database. Recent Chrome versions
   encrypt cookies in a way that can defeat this, in which case use option 2.
2. Export cookies with a "Get cookies.txt" browser extension and save the file as
   `cookies.txt` next to `server.js`. If present it's used automatically and takes
   priority over the browser setting.

**Anything else** — sites change their internals constantly and `yt-dlp` ships fixes
within days. Hit **Update yt-dlp** in Options before assuming a link is unsupported.

## Notes

- `--use-system-ca` is passed to Node throughout so it trusts the Windows certificate
  store. Without it, downloads fail behind a TLS-inspecting corporate proxy.
- Settings persist to `settings.json`, written when you save options.
- The server binds to `127.0.0.1` only — nothing is exposed on your network.
- Keep the audio you pull for your own use; redistributing someone's music or video isn't
  yours to do.

## Layout

| File | Role |
| --- | --- |
| `server.js` | Local web server, job queue, settings |
| `ui.html` | The whole front end |
| `extract.js` | Wraps yt-dlp — the actual link-to-audio step |
| `bins.js` | Downloads/updates yt-dlp and ffmpeg |
| `cli.js` | Batch mode |
