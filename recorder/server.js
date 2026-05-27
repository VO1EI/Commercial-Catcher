const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const http = require('http');
const https = require('https');

const app = express();
app.use(cors());
app.use(express.json());

const RECORDINGS_DIR = '/recordings';
let monitors = {};

function ts() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

// ── Fetch Icecast/Shoutcast metadata ─────────────────────────────────────────
// Shoutcast/Icecast streams expose current track in the ICY metadata protocol.
// We request the stream with Icy-MetaData: 1 header and parse the response.

function fetchMetadata(url) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: {
        'Icy-MetaData': '1',
        'User-Agent': 'Mozilla/5.0',
      },
      timeout: 8000,
    }, (res) => {
      const metaInt = parseInt(res.headers['icy-metaint'] || '0');
      const stationName = res.headers['icy-name'] || '';
      const streamTitle = res.headers['icy-description'] || '';

      if (!metaInt) {
        // No inline metadata — try icy headers only
        req.destroy();
        return resolve({ title: streamTitle || null, station: stationName, raw: '' });
      }

      let bytesRead = 0;
      let metaBuffer = Buffer.alloc(0);
      let inMeta = false;
      let metaLen = 0;
      let metaBytesRead = 0;

      res.on('data', (chunk) => {
        let offset = 0;
        while (offset < chunk.length) {
          if (!inMeta) {
            const remaining = metaInt - bytesRead;
            const audioBytes = Math.min(remaining, chunk.length - offset);
            bytesRead += audioBytes;
            offset += audioBytes;

            if (bytesRead >= metaInt) {
              bytesRead = 0;
              inMeta = true;
              if (offset < chunk.length) {
                metaLen = chunk[offset] * 16;
                offset++;
                metaBytesRead = 0;
                metaBuffer = Buffer.alloc(0);
              }
            }
          } else {
            if (metaLen === 0) {
              inMeta = false;
              continue;
            }
            const needed = metaLen - metaBytesRead;
            const available = chunk.length - offset;
            const take = Math.min(needed, available);
            metaBuffer = Buffer.concat([metaBuffer, chunk.slice(offset, offset + take)]);
            metaBytesRead += take;
            offset += take;

            if (metaBytesRead >= metaLen) {
              const metaStr = metaBuffer.toString('utf8').replace(/\0/g, '');
              const match = metaStr.match(/StreamTitle='([^']*)'/);
              req.destroy();
              return resolve({
                title: match ? match[1].trim() : null,
                station: stationName,
                raw: metaStr,
              });
            }
          }
        }
      });

      res.on('error', () => resolve({ title: null, station: stationName, raw: '' }));
      setTimeout(() => { req.destroy(); resolve({ title: null, station: stationName, raw: '' }); }, 6000);
    });

    req.on('error', () => resolve({ title: null, station: null, raw: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ title: null, station: null, raw: '' }); });
  });
}

// ── Ad detection from title ───────────────────────────────────────────────────
// A title is "music" if it looks like "Artist - Song"
// A title is "ad/unknown" if it's blank, hasn't changed for too long, or matches ad keywords

const AD_KEYWORDS = [
  'advertisement', 'advert', 'commercial', 'sponsor', 'promo',
  'break', 'ad:', 'spot:', 'paid', 'presented by',
];

function titleIsMusic(title) {
  if (!title || title.trim() === '') return false;
  const lower = title.toLowerCase();
  for (const kw of AD_KEYWORDS) {
    if (lower.includes(kw)) return false;
  }
  // Looks like a song if it has " - " separator (Artist - Title)
  // or is reasonably long
  return title.includes(' - ') || title.length > 5;
}

// ── Monitor ───────────────────────────────────────────────────────────────────

function startMonitor(id, url, options = {}) {
  const {
    pollInterval = 10,     // seconds between metadata checks
    stallThreshold = 60,   // seconds with no title change = likely ad
  } = options;

  const state = {
    id, url,
    status: 'listening',
    currentTitle: null,
    lastTitle: null,
    lastTitleChange: Date.now(),
    station: null,
    recordingFile: null,
    recordingStart: null,
    ffmpegRec: null,
    startTime: new Date(),
    interval: null,
    options: { pollInterval, stallThreshold },
    titleHistory: [],
  };

  monitors[id] = state;

  async function poll() {
    if (!monitors[id]) return;
    try {
      const meta = await fetchMetadata(url);
      if (!monitors[id]) return;

      state.station = meta.station || state.station;
      const title = meta.title;
      state.currentTitle = title;

      const isMusic = titleIsMusic(title);
      const now = Date.now();

      // Track title changes
      if (title !== state.lastTitle) {
        state.lastTitle = title;
        state.lastTitleChange = now;
        state.titleHistory.unshift({ title, time: new Date() });
        if (state.titleHistory.length > 20) state.titleHistory.pop();
      }

      // Stall detection: title hasn't changed in stallThreshold seconds
      const stalled = (now - state.lastTitleChange) > (stallThreshold * 1000);

      const isAd = !isMusic || stalled;

      if (isAd && state.status === 'listening') {
        beginRecording(state);
      } else if (!isAd && state.status === 'recording') {
        endRecording(state);
      }
    } catch (e) {}
  }

  // Poll immediately then on interval
  poll();
  state.interval = setInterval(poll, pollInterval * 1000);
}

function beginRecording(state) {
  const filename = `commercial-${ts()}.mp3`;
  const outPath = path.join(RECORDINGS_DIR, filename);
  state.recordingFile = filename;
  state.recordingStart = new Date();
  state.status = 'recording';

  const rec = spawn('ffmpeg', [
    '-i', state.url,
    '-vn',
    '-acodec', 'libmp3lame',
    '-q:a', '2',
    outPath
  ]);
  state.ffmpegRec = rec;
  rec.stderr.on('data', () => {});
  rec.on('close', () => {
    if (state.status === 'recording') {
      state.status = 'listening';
      state.recordingFile = null;
      state.recordingStart = null;
    }
  });
}

function endRecording(state) {
  if (state.ffmpegRec) {
    state.ffmpegRec.kill('SIGTERM');
    state.ffmpegRec = null;
  }
  state.status = 'listening';
  state.recordingFile = null;
  state.recordingStart = null;
}

// ── API ───────────────────────────────────────────────────────────────────────

app.get('/api/status', (req, res) => {
  const active = Object.values(monitors).map(m => ({
    id: m.id,
    url: m.url,
    status: m.status,
    currentTitle: m.currentTitle,
    station: m.station,
    recordingFile: m.recordingFile,
    recordingStart: m.recordingStart,
    startTime: m.startTime,
    lastTitleChange: m.lastTitleChange,
    titleHistory: m.titleHistory.slice(0, 5),
    options: m.options,
  }));
  res.json({ active });
});

app.post('/api/monitor/start', (req, res) => {
  const { url, pollInterval, stallThreshold } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });
  const id = Date.now().toString();
  startMonitor(id, url, { pollInterval, stallThreshold });
  res.json({ id, message: 'Monitoring started' });
});

app.post('/api/monitor/stop/:id', (req, res) => {
  const m = monitors[req.params.id];
  if (!m) return res.status(404).json({ error: 'Not found' });
  clearInterval(m.interval);
  if (m.ffmpegRec) m.ffmpegRec.kill('SIGTERM');
  delete monitors[req.params.id];
  res.json({ message: 'Stopped' });
});

app.post('/api/monitor/stopall', (req, res) => {
  Object.values(monitors).forEach(m => {
    clearInterval(m.interval);
    if (m.ffmpegRec) m.ffmpegRec.kill('SIGTERM');
  });
  monitors = {};
  res.json({ message: 'All stopped' });
});

app.get('/api/recordings', (req, res) => {
  try {
    const files = fs.readdirSync(RECORDINGS_DIR)
      .filter(f => f.endsWith('.mp3') || f.endsWith('.aac') || f.endsWith('.ogg'))
      .map(f => {
        const stat = fs.statSync(path.join(RECORDINGS_DIR, f));
        return { name: f, size: stat.size, modified: stat.mtime };
      })
      .sort((a, b) => new Date(b.modified) - new Date(a.modified));
    res.json(files);
  } catch (e) { res.json([]); }
});

app.get('/api/recordings/download/:name', (req, res) => {
  const filePath = path.join(RECORDINGS_DIR, req.params.name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  res.download(filePath, req.params.name);
});

app.delete('/api/recordings/:name', (req, res) => {
  const filePath = path.join(RECORDINGS_DIR, req.params.name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  fs.unlinkSync(filePath);
  res.json({ message: 'Deleted' });
});

app.listen(3000, () => console.log('Ad Recorder API on :3000'));
