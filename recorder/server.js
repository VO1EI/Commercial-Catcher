const express = require('express');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const RECORDINGS_DIR = '/recordings';
let monitors = {}; // active stream monitors

// ── helpers ──────────────────────────────────────────────────────────────────

function ts() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function classify(pcmBuffer) {
  // Write PCM to a temp wav, run python classifier, return label
  const tmpWav = `/tmp/classify_${Date.now()}.wav`;
  const tmpPcm = `/tmp/classify_${Date.now()}.pcm`;
  try {
    fs.writeFileSync(tmpPcm, pcmBuffer);
    execSync(
      `ffmpeg -y -f s16le -ar 16000 -ac 1 -i ${tmpPcm} ${tmpWav} 2>/dev/null`
    );
    const result = execSync(
      `python3 /app/classify.py ${tmpWav}`,
      { timeout: 8000 }
    ).toString().trim();
    return result; // "music" or "speech"
  } catch (e) {
    return 'unknown';
  } finally {
    try { fs.unlinkSync(tmpPcm); } catch(_) {}
    try { fs.unlinkSync(tmpWav); } catch(_) {}
  }
}

// ── monitor a stream ──────────────────────────────────────────────────────────

function startMonitor(id, url) {
  const state = {
    id, url,
    status: 'listening',   // listening | recording
    label: 'starting',
    recordingFile: null,
    recordingStart: null,
    ffmpegStream: null,    // stream reader process
    ffmpegRec: null,       // recorder process
    startTime: new Date(),
    chunks: [],
    chunkTimer: null,
  };

  monitors[id] = state;

  // Continuously pull raw PCM from stream for classification
  const reader = spawn('ffmpeg', [
    '-i', url,
    '-vn',
    '-acodec', 'pcm_s16le',
    '-ar', '16000',
    '-ac', '1',
    '-f', 's16le',
    'pipe:1'
  ]);

  state.ffmpegStream = reader;

  const CHUNK_BYTES = 16000 * 2 * 3; // 3 seconds of 16kHz mono s16le
  let buf = Buffer.alloc(0);

  reader.stdout.on('data', (data) => {
    buf = Buffer.concat([buf, data]);
    while (buf.length >= CHUNK_BYTES) {
      const chunk = buf.slice(0, CHUNK_BYTES);
      buf = buf.slice(CHUNK_BYTES);
      processChunk(state, chunk);
    }
  });

  reader.on('close', () => {
    if (monitors[id]) {
      monitors[id].status = 'stopped';
      monitors[id].label = 'stream ended';
    }
  });

  reader.stderr.on('data', () => {}); // suppress ffmpeg logs
}

function processChunk(state, chunk) {
  const label = classify(chunk);
  state.label = label;

  const isCommercial = label === 'speech';

  if (isCommercial && state.status === 'listening') {
    // Start recording
    state.status = 'recording';
    const filename = `commercial-${ts()}.mp3`;
    const outPath = path.join(RECORDINGS_DIR, filename);
    state.recordingFile = filename;
    state.recordingStart = new Date();

    const rec = spawn('ffmpeg', [
      '-i', state.url,
      '-vn',
      '-acodec', 'libmp3lame',
      '-q:a', '2',
      outPath
    ]);
    state.ffmpegRec = rec;
    rec.stderr.on('data', () => {});

  } else if (!isCommercial && state.status === 'recording') {
    // Stop recording — music resumed
    if (state.ffmpegRec) {
      state.ffmpegRec.stdin.write('q');
      state.ffmpegRec.kill('SIGTERM');
      state.ffmpegRec = null;
    }
    state.status = 'listening';
    state.recordingFile = null;
    state.recordingStart = null;
  }
}

// ── API ───────────────────────────────────────────────────────────────────────

app.get('/api/status', (req, res) => {
  const active = Object.values(monitors).map(m => ({
    id: m.id,
    url: m.url,
    status: m.status,
    label: m.label,
    recordingFile: m.recordingFile,
    recordingStart: m.recordingStart,
    startTime: m.startTime,
  }));
  res.json({ active });
});

app.post('/api/monitor/start', (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });
  const id = Date.now().toString();
  startMonitor(id, url);
  res.json({ id, message: 'Monitoring started' });
});

app.post('/api/monitor/stop/:id', (req, res) => {
  const m = monitors[req.params.id];
  if (!m) return res.status(404).json({ error: 'Not found' });
  if (m.ffmpegStream) m.ffmpegStream.kill('SIGTERM');
  if (m.ffmpegRec) m.ffmpegRec.kill('SIGTERM');
  delete monitors[req.params.id];
  res.json({ message: 'Stopped' });
});

app.post('/api/monitor/stopall', (req, res) => {
  Object.values(monitors).forEach(m => {
    if (m.ffmpegStream) m.ffmpegStream.kill('SIGTERM');
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

app.listen(3000, () => console.log('Recorder API on :3000'));
