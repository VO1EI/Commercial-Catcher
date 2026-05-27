# Stream Recorder

Records audio webstreams (Shoutcast, Icecast, HTTP streams) to files via a web UI.

## Quick Start

```bash
docker compose up -d --build
```

Then open **http://localhost:8090** in your browser.

## Usage

1. Paste a stream URL (e.g. `http://stream.example.com:8000/radio`)
2. Optionally set a filename and format (MP3, AAC, OGG, M4A)
3. Optionally set a duration in seconds (leave blank to record until stopped)
4. Click **Start Recording**

Recordings are saved to the `./recordings/` folder.

## Supported Stream Types

- Shoutcast / Icecast HTTP streams
- HLS streams (`.m3u8`)
- Most HTTP audio streams

## Ports

| Service  | Port |
|----------|------|
| Web UI   | 8090 |

Change the port in `docker-compose.yml` if needed.
