// Load environment variables from .env file (for local dev)
try {
  require('dotenv').config();
} catch (e) {
  // dotenv not available in production, env vars loaded by systemd
}

const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');

const app = express();

app.use(cors());
app.use(express.json());

// Configuration from environment
const API_SECRET = process.env.API_SECRET;
const DASHBOARD_URL = process.env.DASHBOARD_URL;
const RTMP_PORT = process.env.RTMP_PORT || 1935;
const PORT = process.env.PORT || 3001;

if (!API_SECRET || !DASHBOARD_URL) {
  console.error('Missing required environment variables: API_SECRET and DASHBOARD_URL');
  process.exit(1);
}

// State
let relayProcesses = new Map();
let relayActive = false;
let streamStartTime = null;
let inputStartTime = null;

// Check RTMP input status by querying nginx stat page
async function checkRtmpInput() {
  try {
    const res = await fetch('http://127.0.0.1/stat');
    if (!res.ok) return { available: false, startTime: null };

    const xml = await res.text();
    // Check if there's an active stream in the "live" application
    // The nginx-rtmp stat page shows <stream><name>stream</name>...</stream> when active
    const hasStream = xml.includes('<application><name>live</name>') &&
                      xml.includes('<stream>') &&
                      xml.includes('<name>stream</name>');

    if (hasStream && !inputStartTime) {
      inputStartTime = Date.now();
    } else if (!hasStream) {
      inputStartTime = null;
    }

    return {
      available: hasStream,
      startTime: inputStartTime
    };
  } catch (error) {
    return { available: false, startTime: null };
  }
}

// Auth middleware
function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ') || auth.slice(7) !== API_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.use(authMiddleware);

// Health check
app.get('/health', async (req, res) => {
  const input = await checkRtmpInput();
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    relayActive,
    streamCount: relayProcesses.size,
    inputAvailable: input.available
  });
});

// Get RTMP input status
app.get('/input/status', async (req, res) => {
  const input = await checkRtmpInput();
  res.json(input);
});

// Get relay status
app.get('/relay/status', (req, res) => {
  const streams = [];
  relayProcesses.forEach((proc, id) => {
    streams.push({
      id,
      platform: proc.platform,
      rtmpUrl: proc.rtmpUrl,
      pid: proc.process?.pid,
      running: proc.process && !proc.process.killed
    });
  });

  res.json({
    active: relayActive,
    streams,
    count: streams.length,
    startTime: streamStartTime
  });
});

// Build FFmpeg args for a platform
function buildFFmpegArgs(platform, inputUrl) {
  const fullRtmpUrl = platform.rtmpUrl + '/' + platform.streamKey;

  // Base args
  const args = [
    '-hide_banner',
    '-loglevel', 'warning',
    '-i', inputUrl
  ];

  // Check if platform has custom encoding settings
  if (platform.encoding && !platform.encoding.usePassthrough) {
    // Re-encode with custom settings
    args.push(
      '-c:v', 'libx264',
      '-preset', platform.encoding.preset || 'veryfast',
      '-b:v', (platform.encoding.bitrate || 4500) + 'k',
      '-maxrate', (platform.encoding.maxBitrate || platform.encoding.bitrate || 4500) + 'k',
      '-bufsize', ((platform.encoding.bitrate || 4500) * 2) + 'k',
      '-g', String(platform.encoding.keyframeInterval || 60),
      '-c:a', 'aac',
      '-b:a', (platform.encoding.audioBitrate || 160) + 'k',
      '-ar', '44100'
    );

    // Resolution scaling if specified
    if (platform.encoding.resolution) {
      args.push('-vf', `scale=${platform.encoding.resolution}`);
    }
  } else {
    // Passthrough - copy streams without re-encoding
    args.push('-c', 'copy');
  }

  // Output
  args.push('-f', 'flv', fullRtmpUrl);

  return args;
}

// Start relay - fetches platforms from dashboard and starts FFmpeg processes
app.post('/relay/start', async (req, res) => {
  try {
    console.log('Starting relay...');

    // Fetch enabled platforms from dashboard
    const platformsRes = await fetch(DASHBOARD_URL + '/api/vm/platforms', {
      headers: { 'Authorization': 'Bearer ' + API_SECRET }
    });

    if (!platformsRes.ok) {
      const error = await platformsRes.text();
      console.error('Failed to fetch platforms:', error);
      return res.status(500).json({ error: 'Failed to fetch platforms from dashboard' });
    }

    const { platforms } = await platformsRes.json();

    if (!platforms || platforms.length === 0) {
      return res.status(400).json({ error: 'No enabled platforms configured' });
    }

    console.log(`Found ${platforms.length} platform(s) to relay to`);

    // Stop any existing relays
    stopAllRelays();

    const inputUrl = `rtmp://localhost:${RTMP_PORT}/live/stream`;

    // Start FFmpeg relay for each platform
    for (const platform of platforms) {
      const ffmpegArgs = buildFFmpegArgs(platform, inputUrl);

      console.log(`Starting relay to ${platform.name}:`, ffmpegArgs.join(' ').substring(0, 100) + '...');

      const proc = spawn('ffmpeg', ffmpegArgs);

      proc.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg) {
          console.log(`[${platform.name}] ${msg.slice(0, 200)}`);
        }
      });

      proc.on('error', (err) => {
        console.error(`[${platform.name}] FFmpeg error:`, err.message);
      });

      proc.on('close', (code) => {
        console.log(`[${platform.name}] FFmpeg exited with code ${code}`);
        relayProcesses.delete(platform.id);

        // If all processes exited, mark relay as inactive
        if (relayProcesses.size === 0) {
          relayActive = false;
          streamStartTime = null;
        }
      });

      relayProcesses.set(platform.id, {
        process: proc,
        platform: platform.name,
        rtmpUrl: platform.rtmpUrl,
        startTime: new Date()
      });
    }

    relayActive = true;
    streamStartTime = new Date();

    res.json({
      success: true,
      message: 'Relay started',
      count: platforms.length,
      platforms: platforms.map(p => p.name)
    });
  } catch (error) {
    console.error('Failed to start relay:', error);
    res.status(500).json({ error: error.message });
  }
});

// Stop all relay processes
function stopAllRelays() {
  relayProcesses.forEach((proc, id) => {
    if (proc.process && !proc.process.killed) {
      console.log(`Stopping relay to ${proc.platform}`);
      proc.process.kill('SIGTERM');
    }
  });
  relayProcesses.clear();
  relayActive = false;
  streamStartTime = null;
}

// Stop relay
app.post('/relay/stop', (req, res) => {
  console.log('Stopping relay...');
  stopAllRelays();
  res.json({ success: true, message: 'Relay stopped' });
});

// Refresh relay (re-fetch platforms and restart)
app.post('/relay/refresh', async (req, res) => {
  try {
    console.log('Refreshing relay...');
    stopAllRelays();

    // Small delay to ensure processes are stopped
    await new Promise(resolve => setTimeout(resolve, 500));

    // Forward to start
    const startRes = await fetch(`http://localhost:${PORT}/relay/start`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + API_SECRET }
    });

    const data = await startRes.json();
    res.json(data);
  } catch (error) {
    console.error('Failed to refresh relay:', error);
    res.status(500).json({ error: error.message });
  }
});

// Status endpoint (OBS-style status for compatibility)
app.get('/status', async (req, res) => {
  const input = await checkRtmpInput();
  res.json({
    mode: relayActive ? 'live' : 'idle',
    obsConnected: false,
    isStreaming: relayActive,
    streamStartTime: streamStartTime?.toISOString() || null,
    liveInput: input,
    platforms: relayProcesses.size
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down...');
  stopAllRelays();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down...');
  stopAllRelays();
  process.exit(0);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Stream Manager listening on port ${PORT}`);
  console.log(`Dashboard URL: ${DASHBOARD_URL}`);
  console.log(`RTMP Input: rtmp://localhost:${RTMP_PORT}/live/stream`);
});
