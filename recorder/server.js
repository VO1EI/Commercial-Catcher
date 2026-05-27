const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const http = require('http');
const https = require('https');

const app = express();
app.use(cors());
app.use(express.json());

const RECORDINGS_DIR = '/recordings';
const LOGOS_DIR = '/recordings/logos';
const STATIONS_FILE = '/recordings/stations.json';
let monitors = {};

function loadStationsData() {
  try { return JSON.parse(fs.readFileSync(STATIONS_FILE, 'utf8')); }
  catch(_) { return []; }
}

function saveStationsData(stations) {
  fs.writeFileSync(STATIONS_FILE, JSON.stringify(stations, null, 2));
}

// Ensure logos dir exists
if (!fs.existsSync(LOGOS_DIR)) fs.mkdirSync(LOGOS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, LOGOS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.png';
    cb(null, req.params.station.replace(/[^a-zA-Z0-9_-]/g, '_') + ext);
  }
});
const upload = multer({ storage, limits: { fileSize: 2 * 1024 * 1024 } });

function ts() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

// ── JSON now-playing API fetch ────────────────────────────────────────────────
// Handles endpoints like https://player.avrnetwork.com/CKENFM/nowplaying
// which return { artist, title, albumart }

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const bust = `${url.includes('?') ? '&' : '?'}_=${Date.now()}`;
    const req = lib.get(url + bust, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
      timeout: 6000,
    }, (res) => {
      let body = '';
      res.on('data', d => body += d.toString());
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (_) { reject(new Error('not json')); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ── ICY stream metadata fetch ─────────────────────────────────────────────────
// Reads inline ICY metadata from a Shoutcast/Icecast stream

function fetchIcyMetadata(url) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: { 'Icy-MetaData': '1', 'User-Agent': 'Mozilla/5.0' },
      timeout: 8000,
    }, (res) => {
      const metaInt = parseInt(res.headers['icy-metaint'] || '0');
      const stationName = res.headers['icy-name'] || '';
      const streamTitle = res.headers['icy-description'] || '';

      if (!metaInt) {
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
            if (metaLen === 0) { inMeta = false; continue; }
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
              return resolve({ title: match ? match[1].trim() : null, station: stationName, raw: metaStr });
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

// ── Unified metadata fetch ────────────────────────────────────────────────────
// Auto-detects JSON API vs ICY stream

async function fetchMetadata(url) {
  // Try JSON first
  try {
    const data = await fetchJson(url);
    if (data && (data.title || data.artist || data.song || data.track)) {
      const artist = data.artist || data.artistName || '';
      const title  = data.title  || data.song || data.track || data.songTitle || '';
      const combined = artist && title ? `${artist} - ${title}` : (title || artist || null);
      return {
        title: combined,
        artist,
        songTitle: title,
        station: data.station || data.name || null,
        albumart: data.albumart || data.artwork || null,
        raw: JSON.stringify(data),
        isJson: true,
      };
    }
  } catch (_) {}

  // Fall back to ICY
  return fetchIcyMetadata(url);
}

// ── Ad detection ──────────────────────────────────────────────────────────────

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
  return title.includes(' - ') || title.length > 5;
}

// ── Monitor ───────────────────────────────────────────────────────────────────

function startMonitor(id, url, options = {}) {
  const {
    pollInterval = 10,
    stallThreshold = 60,
    metadataUrl = null,
    stationName = '',
    triggerMode = 'stall',       // 'stall' or 'keyword'
    triggerKeywords = '',        // comma-separated keywords; blank = trigger on empty title
  } = options;

  const state = {
    id, url,
    status: 'listening',
    currentTitle: null,
    currentArtist: null,
    currentSongTitle: null,
    currentAlbumart: null,
    lastTitle: null,
    lastTitleChange: Date.now(),
    station: null,
    recordingFile: null,
    recordingStart: null,
    ffmpegRec: null,
    startTime: new Date(),
    interval: null,
    options: { pollInterval, stallThreshold, metadataUrl, stationName, triggerMode, triggerKeywords },
    titleHistory: [],
  };

  monitors[id] = state;

  async function poll() {
    if (!monitors[id]) return;
    try {
      const pollUrl = state.options.metadataUrl || url;
      const meta = await fetchMetadata(pollUrl);
      if (!monitors[id]) return;

      state.station = meta.station || state.station;
      state.currentAlbumart = meta.albumart || state.currentAlbumart;
      state.currentArtist = meta.artist || null;
      state.currentSongTitle = meta.songTitle || null;

      const title = meta.title;
      state.currentTitle = title;

      const isMusic = titleIsMusic(title);
      const now = Date.now();

      if (title !== state.lastTitle) {
        state.lastTitle = title;
        state.lastTitleChange = now;
        state.titleHistory.unshift({
          title,
          artist: meta.artist || null,
          songTitle: meta.songTitle || null,
          albumart: meta.albumart || null,
          time: new Date(),
        });
        if (state.titleHistory.length > 20) state.titleHistory.pop();
      }

      // Determine if currently in an ad break based on trigger mode
      let isAd = false;
      if (state.options.triggerMode === 'keyword') {
        const keywords = state.options.triggerKeywords
          .split(',')
          .map(k => k.trim().toLowerCase())
          .filter(k => k.length > 0);
        const t = (title || '').toLowerCase();
        const isBlank = !title || title.trim() === '';
        if (keywords.length === 0) {
          // No keywords = trigger only on blank title
          isAd = isBlank;
        } else {
          isAd = isBlank || keywords.some(k => t.includes(k));
        }
      } else {
        // Stall mode
        const stalled = (now - state.lastTitleChange) > (stallThreshold * 1000);
        isAd = !isMusic || stalled;
      }

      if (isAd && state.status === 'listening') {
        beginRecording(state);
      } else if (!isAd && state.status === 'recording') {
        endRecording(state);
      }
    } catch (e) {}
  }

  poll();
  state.interval = setInterval(poll, pollInterval * 1000);
}

function beginRecording(state) {
  const slug = state.options.stationName
    ? state.options.stationName.trim().replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_')
    : 'commercial';
  const filename = `${slug}-${ts()}.mp3`;
  const outPath = path.join(RECORDINGS_DIR, filename);
  state.recordingFile = filename;
  state.recordingStart = new Date();
  state.status = 'recording';

  const rec = spawn('ffmpeg', [
    '-i', state.url,
    '-vn', '-acodec', 'libmp3lame', '-q:a', '2',
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
    currentArtist: m.currentArtist,
    currentSongTitle: m.currentSongTitle,
    currentAlbumart: m.currentAlbumart,
    station: m.station,
    recordingFile: m.recordingFile,
    recordingStart: m.recordingStart,
    startTime: m.startTime,
    lastTitleChange: m.lastTitleChange,
    titleHistory: m.titleHistory.slice(0, 5),
    options: m.options,
    metadataSource: m.options.metadataUrl ? 'json' : 'stream',
  }));
  res.json({ active });
});

app.post('/api/monitor/start', (req, res) => {
  const { url, pollInterval, stallThreshold, metadataUrl, stationName, triggerMode, triggerKeywords } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });
  const id = Date.now().toString();
  startMonitor(id, url, { pollInterval, stallThreshold, metadataUrl: metadataUrl || null, stationName: stationName || '', triggerMode: triggerMode || 'stall', triggerKeywords: triggerKeywords || '' });
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

// Upload station logo
app.post('/api/logos/:station', upload.single('logo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ filename: req.file.filename, url: '/api/logos/img/' + req.file.filename });
});

// Serve logo image
app.get('/api/logos/img/:filename', (req, res) => {
  const filePath = path.join(LOGOS_DIR, req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
  res.sendFile(filePath);
});

// List all logos
app.get('/api/logos', (req, res) => {
  try {
    const files = fs.existsSync(LOGOS_DIR)
      ? fs.readdirSync(LOGOS_DIR).filter(f => /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(f))
      : [];
    res.json(files.map(f => ({ station: f.replace(/\.[^.]+$/, ''), filename: f, url: '/api/logos/img/' + f })));
  } catch(e) { res.json([]); }
});

// Delete logo
app.delete('/api/logos/:station', (req, res) => {
  const files = fs.existsSync(LOGOS_DIR) ? fs.readdirSync(LOGOS_DIR) : [];
  const match = files.find(f => f.startsWith(req.params.station + '.') || f === req.params.station);
  if (!match) return res.status(404).json({ error: 'Not found' });
  fs.unlinkSync(path.join(LOGOS_DIR, match));
  res.json({ message: 'Deleted' });
});

// ── Station config CRUD ───────────────────────────────────────────────────────

app.get('/api/stations', (req, res) => {
  res.json(loadStationsData());
});

app.post('/api/stations', (req, res) => {
  const { name, streamUrl, metadataUrl, pollInterval, stallThreshold, triggerMode, triggerKeywords } = req.body;
  if (!name || !streamUrl) return res.status(400).json({ error: 'name and streamUrl required' });
  const stations = loadStationsData();
  const existing = stations.findIndex(s => s.name === name);
  const station = { name, streamUrl, metadataUrl: metadataUrl || '', pollInterval: pollInterval || 10, stallThreshold: stallThreshold || 60, triggerMode: triggerMode || 'stall', triggerKeywords: triggerKeywords || '' };
  if (existing >= 0) stations[existing] = station;
  else stations.push(station);
  saveStationsData(stations);
  res.json({ message: 'Saved', station });
});

app.delete('/api/stations/:name', (req, res) => {
  const stations = loadStationsData().filter(s => s.name !== req.params.name);
  saveStationsData(stations);
  res.json({ message: 'Deleted' });
});

app.listen(3000, () => console.log('Ad Recorder API on :3000'));
