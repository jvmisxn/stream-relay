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
let nvencAvailable = null; // Cache NVENC detection

// Detect if NVENC hardware encoder is available by actually testing it
async function detectNvenc() {
  if (nvencAvailable !== null) return nvencAvailable;

  return new Promise((resolve) => {
    // Try to initialize NVENC with a simple test - this will fail if no GPU
    const proc = spawn('ffmpeg', [
      '-hide_banner',
      '-f', 'lavfi',
      '-i', 'nullsrc=s=256x256:d=0.1',
      '-c:v', 'h264_nvenc',
      '-f', 'null',
      '-'
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    let stderr = '';

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      // NVENC works if exit code is 0 and no "Cannot load" or "No NVENC capable" errors
      const hasError = stderr.includes('Cannot load') ||
                       stderr.includes('No NVENC capable') ||
                       stderr.includes('CUDA');
      nvencAvailable = code === 0 && !hasError;
      console.log(`NVENC hardware encoder: ${nvencAvailable ? 'available' : 'not available (no GPU)'}`);
      resolve(nvencAvailable);
    });

    proc.on('error', () => {
      nvencAvailable = false;
      resolve(false);
    });

    // Timeout after 10 seconds
    setTimeout(() => {
      if (nvencAvailable === null) {
        proc.kill();
        nvencAvailable = false;
        resolve(false);
      }
    }, 10000);
  });
}

// Check RTMP input status by querying nginx stat page
async function checkRtmpInput() {
  try {
    const res = await fetch('http://127.0.0.1/stat');
    if (!res.ok) return { available: false, startTime: null };

    const xml = await res.text();
    // Check if there's an active stream in the "live" application
    // Look for a publishing stream (has <publishing/> tag inside <stream>)
    // The XML structure is: <application><name>live</name><live><stream>...<publishing/>...</stream></live></application>
    const hasLiveApp = xml.includes('<name>live</name>');
    const hasPublishingStream = xml.includes('<publishing/>') && xml.includes('<stream>');
    const hasStream = hasLiveApp && hasPublishingStream;

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
    console.error('Failed to check RTMP input:', error.message);
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
  const hasNvenc = await detectNvenc();
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    relayActive,
    streamCount: relayProcesses.size,
    inputAvailable: input.available,
    nvencAvailable: hasNvenc,
    encoder: hasNvenc ? 'nvenc' : 'cpu'
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

// Map CPU presets to NVENC presets
const nvencPresetMap = {
  'ultrafast': 'p1',
  'superfast': 'p2',
  'veryfast': 'p3',
  'faster': 'p4',
  'fast': 'p5',
  'medium': 'p5',
  'slow': 'p6',
  'slower': 'p7'
};

// Build FFmpeg args for a platform
function buildFFmpegArgs(platform, inputUrl, useNvenc = false) {
  const fullRtmpUrl = platform.rtmpUrl + '/' + platform.streamKey;

  // Base args
  const args = [
    '-hide_banner',
    '-loglevel', 'warning'
  ];

  // Add hardware acceleration input if using NVENC
  if (useNvenc) {
    args.push('-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda');
  }

  args.push('-i', inputUrl);

  // Check if platform has custom encoding settings
  if (platform.encoding && !platform.encoding.usePassthrough) {
    const bitrate = platform.encoding.bitrate || 4500;
    const maxBitrate = platform.encoding.maxBitrate || bitrate;
    const audioBitrate = platform.encoding.audioBitrate || 160;
    const cpuPreset = platform.encoding.preset || 'veryfast';

    if (useNvenc) {
      // Use NVENC hardware encoder
      const nvencPreset = nvencPresetMap[cpuPreset] || 'p4';
      args.push(
        '-c:v', 'h264_nvenc',
        '-preset', nvencPreset,
        '-rc', 'cbr',
        '-b:v', bitrate + 'k',
        '-maxrate', maxBitrate + 'k',
        '-bufsize', (bitrate * 2) + 'k',
        '-g', String(platform.encoding.keyframeInterval || 60),
        '-profile:v', 'high',
        '-c:a', 'aac',
        '-b:a', audioBitrate + 'k',
        '-ar', '44100'
      );

      // Resolution scaling with CUDA
      if (platform.encoding.resolution) {
        args.push('-vf', `scale_cuda=${platform.encoding.resolution}`);
      }
    } else {
      // Use CPU encoder (libx264)
      args.push(
        '-c:v', 'libx264',
        '-preset', cpuPreset,
        '-b:v', bitrate + 'k',
        '-maxrate', maxBitrate + 'k',
        '-bufsize', (bitrate * 2) + 'k',
        '-g', String(platform.encoding.keyframeInterval || 60),
        '-c:a', 'aac',
        '-b:a', audioBitrate + 'k',
        '-ar', '44100'
      );

      // Resolution scaling with CPU
      if (platform.encoding.resolution) {
        args.push('-vf', `scale=${platform.encoding.resolution}`);
      }
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

    // Detect NVENC availability
    const useNvenc = await detectNvenc();
    console.log(`Using encoder: ${useNvenc ? 'NVENC (GPU)' : 'libx264 (CPU)'}`);

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
      const ffmpegArgs = buildFFmpegArgs(platform, inputUrl, useNvenc);

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
