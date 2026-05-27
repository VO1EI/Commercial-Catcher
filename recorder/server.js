const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const RECORDINGS_DIR = '/recordings';
let monitors = {};

function ts() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

// ── Volume monitor ────────────────────────────────────────────────────────────
// Uses ffmpeg astats filter to read mean volume every second.
// Commercials are louder than music on most broadcast streams.
// We track a rolling average and flag when current volume is significantly
// above baseline (ad) or a silence gap occurs (transition).

function startMonitor(id, url, options = {}) {
  const {
    silenceThreshold = -40,   // dB — below this = silence (transition gap)
    adBoostDb = 3,            // dB above rolling avg = likely ad
    silenceDuration = 0.5,    // seconds of silence to trigger transition
  } = options;

  const state = {
    id, url,
    status: 'listening',
    currentDb: null,
    baselineDb: null,
    dbHistory: [],
    recordingFile: null,
    recordingStart: null,
    ffmpegMonitor: null,
    ffmpegRec: null,
    startTime: new Date(),
    silenceStart: null,
    lastTransition: 0,
    options: { silenceThreshold, adBoostDb, silenceDuration },
  };

  monitors[id] = state;

  // ffmpeg reads stream, outputs volume stats to stderr every 0.5s
  const monitor = spawn('ffmpeg', [
    '-i', url,
    '-vn',
    '-af', `astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-`,
    '-f', 'null',
    '-'
  ]);

  state.ffmpegMonitor = monitor;

  let buf = '';
  monitor.stderr.on('data', d => { buf += d.toString(); });

  // Parse volume from stdout metadata output
  monitor.stdout.on('data', d => {
    const lines = (buf + d.toString()).split('\n');
    buf = '';
    for (const line of lines) {
      const m = line.match(/lavfi\.astats\.Overall\.RMS_level=(.+)/);
      if (m) {
        const db = parseFloat(m[1]);
        if (!isNaN(db) && isFinite(db)) {
          processVolume(state, db);
        }
      }
    }
  });

  monitor.on('close', () => {
    if (monitors[id]) {
      monitors[id].status = 'stopped';
    }
  });
}

function processVolume(state, db) {
  const now = Date.now();
  state.currentDb = db;

  // Build rolling baseline (median of last 30 readings ≈ 15 seconds)
  state.dbHistory.push(db);
  if (state.dbHistory.length > 30) state.dbHistory.shift();

  // Baseline = median of history (robust to outliers)
  const sorted = [...state.dbHistory].filter(v => v > -80).sort((a,b) => a-b);
  if (sorted.length > 5) {
    state.baselineDb = sorted[Math.floor(sorted.length / 2)];
  }

  const { silenceThreshold, adBoostDb, silenceDuration } = state.options;
  const COOLDOWN_MS = 8000; // min 8s between transitions

  const isSilence = db < silenceThreshold;
  const isLoud = state.baselineDb !== null && db > state.baselineDb + adBoostDb;

  // Silence gap detection (transition marker)
  if (isSilence) {
    if (!state.silenceStart) state.silenceStart = now;
    const silenceMs = now - state.silenceStart;

    if (silenceMs >= silenceDuration * 1000 && now - state.lastTransition > COOLDOWN_MS) {
      // Silence gap = transition between music and ad (or vice versa)
      state.lastTransition = now;
      if (state.status === 'listening') {
        startRecording(state);
      } else if (state.status === 'recording') {
        stopRecording(state);
      }
    }
  } else {
    state.silenceStart = null;

    // Volume spike = likely ad started (no silence gap on this stream)
    if (isLoud && state.status === 'listening' && now - state.lastTransition > COOLDOWN_MS) {
      state.lastTransition = now;
      startRecording(state);
    }

    // Volume back to normal = music resumed
    if (!isLoud && state.status === 'recording' &&
        state.baselineDb !== null &&
        db < state.baselineDb + (adBoostDb / 2) &&
        now - state.lastTransition > COOLDOWN_MS) {
      state.lastTransition = now;
      stopRecording(state);
    }
  }
}

function startRecording(state) {
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
}

function stopRecording(state) {
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
    currentDb: m.currentDb ? m.currentDb.toFixed(1) : null,
    baselineDb: m.baselineDb ? m.baselineDb.toFixed(1) : null,
    recordingFile: m.recordingFile,
    recordingStart: m.recordingStart,
    startTime: m.startTime,
    options: m.options,
  }));
  res.json({ active });
});

app.post('/api/monitor/start', (req, res) => {
  const { url, silenceThreshold, adBoostDb, silenceDuration } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });
  const id = Date.now().toString();
  startMonitor(id, url, { silenceThreshold, adBoostDb, silenceDuration });
  res.json({ id, message: 'Monitoring started' });
});

app.post('/api/monitor/stop/:id', (req, res) => {
  const m = monitors[req.params.id];
  if (!m) return res.status(404).json({ error: 'Not found' });
  if (m.ffmpegMonitor) m.ffmpegMonitor.kill('SIGTERM');
  if (m.ffmpegRec) m.ffmpegRec.kill('SIGTERM');
  delete monitors[req.params.id];
  res.json({ message: 'Stopped' });
});

app.post('/api/monitor/stopall', (req, res) => {
  Object.values(monitors).forEach(m => {
    if (m.ffmpegMonitor) m.ffmpegMonitor.kill('SIGTERM');
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
