// Load environment variables from .env file (for local dev)
try {
  require('dotenv').config();
} catch (e) {
  // dotenv not available in production, env vars loaded by systemd
}

const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const os = require('os');

// CPU usage tracking
let lastCpuTimes = os.cpus().map(cpu => cpu.times);

function getCpuUsage() {
  const cpus = os.cpus();
  const currentTimes = cpus.map(cpu => cpu.times);

  let totalIdle = 0;
  let totalTick = 0;

  for (let i = 0; i < cpus.length; i++) {
    const lastTimes = lastCpuTimes[i];
    const currTimes = currentTimes[i];

    const idleDiff = currTimes.idle - lastTimes.idle;
    const totalDiff = (currTimes.user - lastTimes.user) +
                      (currTimes.nice - lastTimes.nice) +
                      (currTimes.sys - lastTimes.sys) +
                      (currTimes.irq - lastTimes.irq) +
                      idleDiff;

    totalIdle += idleDiff;
    totalTick += totalDiff;
  }

  lastCpuTimes = currentTimes;

  const cpuUsage = totalTick > 0 ? Math.round((1 - totalIdle / totalTick) * 100) : 0;
  return cpuUsage;
}

function getSystemStats() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  return {
    cpuUsage: getCpuUsage(),
    cpuCount: os.cpus().length,
    memoryUsage: Math.round((usedMem / totalMem) * 100),
    memoryTotal: Math.round(totalMem / 1024 / 1024), // MB
    memoryUsed: Math.round(usedMem / 1024 / 1024), // MB
    memoryFree: Math.round(freeMem / 1024 / 1024), // MB
    loadAvg: os.loadavg(),
  };
}

const app = express();

app.use(cors());
app.use(express.json());

// Configuration from environment
const API_SECRET = process.env.API_SECRET;
const DASHBOARD_URL = process.env.DASHBOARD_URL;
const RTMP_PORT = process.env.RTMP_PORT || 1935;
const SRT_PORT = process.env.SRT_PORT || 8890;
const PORT = process.env.PORT || 3001;
// For Docker: use container hostname. For standalone: use localhost
const NGINX_HOST = process.env.NGINX_HOST || 'mediamtx';
// MediaMTX API for input status checks
const MEDIAMTX_API = process.env.MEDIAMTX_API || 'http://mediamtx:9997';

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

// Stats tracking - stores bitrate history for each platform
// Structure: { platformId: { history: [{timestamp, bitrate, fps, speed}], current: {...} } }
let platformStats = new Map();
const MAX_STATS_HISTORY = 3600; // Keep 1 hour of per-second stats

// Parse FFmpeg progress output to extract stats
function parseFFmpegOutput(line) {
  const stats = {};

  // FFmpeg outputs progress like: frame= 1234 fps= 60 q=28.0 size=   12345kB time=00:00:41.23 bitrate=2468.5kbits/s speed=1.00x
  const bitrateMatch = line.match(/bitrate=\s*([\d.]+)kbits\/s/);
  if (bitrateMatch) {
    stats.bitrate = parseFloat(bitrateMatch[1]);
  }

  const fpsMatch = line.match(/fps=\s*([\d.]+)/);
  if (fpsMatch) {
    stats.fps = parseFloat(fpsMatch[1]);
  }

  const speedMatch = line.match(/speed=\s*([\d.]+)x/);
  if (speedMatch) {
    stats.speed = parseFloat(speedMatch[1]);
  }

  const frameMatch = line.match(/frame=\s*(\d+)/);
  if (frameMatch) {
    stats.frame = parseInt(frameMatch[1]);
  }

  const timeMatch = line.match(/time=(\d+):(\d+):([\d.]+)/);
  if (timeMatch) {
    const hours = parseInt(timeMatch[1]);
    const minutes = parseInt(timeMatch[2]);
    const seconds = parseFloat(timeMatch[3]);
    stats.time = hours * 3600 + minutes * 60 + seconds;
  }

  return Object.keys(stats).length > 0 ? stats : null;
}

// Update stats for a platform
function updatePlatformStats(platformId, stats) {
  if (!platformStats.has(platformId)) {
    platformStats.set(platformId, { history: [], current: null });
  }

  const platformData = platformStats.get(platformId);
  const now = Date.now();

  // Update current stats
  platformData.current = { ...stats, timestamp: now };

  // Add to history (only if we have bitrate data)
  if (stats.bitrate !== undefined) {
    platformData.history.push({
      timestamp: now,
      bitrate: stats.bitrate,
      fps: stats.fps,
      speed: stats.speed
    });

    // Trim history to max size
    if (platformData.history.length > MAX_STATS_HISTORY) {
      platformData.history = platformData.history.slice(-MAX_STATS_HISTORY);
    }
  }
}

// Clear stats for a platform
function clearPlatformStats(platformId) {
  platformStats.delete(platformId);
}

// Clear all stats
function clearAllStats() {
  platformStats.clear();
}

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

// Check input status via MediaMTX API (supports both RTMP and SRT)
async function checkInputStatus() {
  try {
    // Use paths/list endpoint and find our stream
    const res = await fetch(`${MEDIAMTX_API}/v3/paths/list`);
    if (!res.ok) {
      if (inputStartTime) inputStartTime = null;
      return { available: false, protocol: null, startTime: null };
    }

    const data = await res.json();

    // Find the live/stream path in the items
    const streamPath = data.items?.find(item => item.name === 'live/stream');

    if (!streamPath || !streamPath.ready) {
      if (inputStartTime) inputStartTime = null;
      return { available: false, protocol: null, startTime: null };
    }

    // Detect protocol from source type
    let protocol = null;
    if (streamPath.source?.type === 'srtConn') {
      protocol = 'srt';
    } else if (streamPath.source?.type === 'rtmpConn') {
      protocol = 'rtmp';
    }

    if (!inputStartTime) {
      inputStartTime = Date.now();
    }

    return {
      available: true,
      protocol,
      startTime: inputStartTime
    };
  } catch (error) {
    console.error('Failed to check input status:', error.message);
    return { available: false, protocol: null, startTime: null };
  }
}

// Backwards compatibility alias
async function checkRtmpInput() {
  return checkInputStatus();
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
  const input = await checkInputStatus();
  const hasNvenc = await detectNvenc();
  const systemStats = getSystemStats();
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    relayActive,
    streamCount: relayProcesses.size,
    input: {
      available: input.available,
      protocol: input.protocol,
      startTime: input.startTime
    },
    // Backwards compatibility
    inputAvailable: input.available,
    nvencAvailable: hasNvenc,
    encoder: hasNvenc ? 'nvenc' : 'cpu',
    system: systemStats,
  });
});

// Get input status (RTMP or SRT)
app.get('/input/status', async (req, res) => {
  const input = await checkInputStatus();
  res.json(input);
});

// Get relay status
app.get('/relay/status', (req, res) => {
  const streams = [];
  relayProcesses.forEach((proc, id) => {
    const stats = platformStats.get(id);
    // Detect output protocol from URL
    const protocol = proc.rtmpUrl?.startsWith('srt://') ? 'srt' : 'rtmp';
    streams.push({
      id,
      platform: proc.platform,
      rtmpUrl: proc.rtmpUrl,
      protocol,
      pid: proc.process?.pid,
      running: proc.process && !proc.process.killed,
      currentStats: stats?.current || null
    });
  });

  res.json({
    active: relayActive,
    streams,
    count: streams.length,
    startTime: streamStartTime
  });
});

// Get streaming stats for all platforms
app.get('/relay/stats', (req, res) => {
  const { since, limit } = req.query;
  const sinceTime = since ? parseInt(since) : 0;
  const maxPoints = limit ? parseInt(limit) : 300; // Default 5 minutes at 1/sec

  const stats = {};
  platformStats.forEach((data, platformId) => {
    // Filter history by time and limit points
    let history = data.history;
    if (sinceTime > 0) {
      history = history.filter(h => h.timestamp > sinceTime);
    }
    // Take last N points
    if (history.length > maxPoints) {
      history = history.slice(-maxPoints);
    }

    stats[platformId] = {
      platformName: data.platformName,
      current: data.current,
      history: history,
      ended: data.ended || false,
      endTime: data.endTime || null
    };
  });

  res.json({
    stats,
    streamStartTime,
    serverTime: Date.now()
  });
});

// Get stats for a single platform
app.get('/relay/stats/:platformId', (req, res) => {
  const { platformId } = req.params;
  const { since, limit } = req.query;
  const sinceTime = since ? parseInt(since) : 0;
  const maxPoints = limit ? parseInt(limit) : 300;

  const data = platformStats.get(platformId);
  if (!data) {
    return res.status(404).json({ error: 'Platform not found or no stats available' });
  }

  let history = data.history;
  if (sinceTime > 0) {
    history = history.filter(h => h.timestamp > sinceTime);
  }
  if (history.length > maxPoints) {
    history = history.slice(-maxPoints);
  }

  res.json({
    platformId,
    platformName: data.platformName,
    current: data.current,
    history: history,
    ended: data.ended || false,
    endTime: data.endTime || null,
    streamStartTime,
    serverTime: Date.now()
  });
});

// Clear stats (for starting fresh)
app.post('/relay/stats/clear', (req, res) => {
  clearAllStats();
  res.json({ success: true, message: 'Stats cleared' });
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
  // Detect if output is SRT or RTMP
  const isSrtOutput = platform.rtmpUrl.startsWith('srt://');

  // Build output URL based on protocol
  let outputUrl;
  if (isSrtOutput) {
    // SRT output: build URL with query parameters
    const srtParams = new URLSearchParams();

    // Stream ID (use stream key as identifier)
    if (platform.streamKey) {
      srtParams.set('streamid', platform.streamKey);
    }

    // SRT-specific settings from platform config
    if (platform.srtSettings) {
      if (platform.srtSettings.latency) {
        // Convert milliseconds to microseconds for SRT
        srtParams.set('latency', String(platform.srtSettings.latency * 1000));
      }
      if (platform.srtSettings.passphrase) {
        srtParams.set('passphrase', platform.srtSettings.passphrase);
      }
      if (platform.srtSettings.mode) {
        srtParams.set('mode', platform.srtSettings.mode);
      }
    } else {
      // Default SRT settings
      srtParams.set('latency', '200000'); // 200ms default
      srtParams.set('mode', 'caller');
    }

    outputUrl = platform.rtmpUrl + '?' + srtParams.toString();
  } else {
    // RTMP output: append stream key to path
    outputUrl = platform.rtmpUrl + '/' + platform.streamKey;
  }

  const fullRtmpUrl = isSrtOutput ? outputUrl : platform.rtmpUrl + '/' + platform.streamKey;

  // Base args - use 'info' level to get progress stats
  const args = [
    '-hide_banner',
    '-loglevel', 'info',
    '-stats'              // Enable progress stats output
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
    const bufsize = platform.encoding.bufsize || bitrate; // VBV buffer size
    const audioBitrate = platform.encoding.audioBitrate || 160;
    const cpuPreset = platform.encoding.preset || 'veryfast';
    const framerate = platform.encoding.framerate || 60;
    const useCbr = platform.encoding.cbr !== false; // Default to CBR for streaming
    const rcLookahead = platform.encoding.rcLookahead || framerate; // Default to 1 second
    // keyframeInterval is in seconds, -g expects frames
    const keyframeIntervalSec = platform.encoding.keyframeInterval || 2;
    const gopSize = keyframeIntervalSec * framerate; // e.g., 2 sec * 60 fps = 120 frames
    const profile = platform.encoding.profile || 'high';

    if (useNvenc) {
      // Use NVENC hardware encoder
      const nvencPreset = nvencPresetMap[cpuPreset] || 'p4';
      args.push(
        '-c:v', 'h264_nvenc',
        '-preset', nvencPreset,
        '-tune', 'll',           // Low-latency tuning for streaming
        '-rc', 'cbr',            // NVENC CBR mode
        '-b:v', bitrate + 'k',
        '-maxrate', maxBitrate + 'k',
        '-bufsize', bufsize + 'k',
        '-g', String(gopSize),
        '-keyint_min', String(gopSize), // Force consistent keyframe interval
        '-profile:v', profile,
        '-rc-lookahead', String(Math.min(rcLookahead, 32)), // NVENC max is 32
        '-c:a', 'aac',
        '-b:a', audioBitrate + 'k',
        '-ar', '48000'           // 48kHz is standard for streaming
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
        '-bufsize', bufsize + 'k',
        '-g', String(gopSize),
        '-keyint_min', String(gopSize), // Force consistent keyframe interval
        '-profile:v', profile,
        '-bf', '2'              // Use 2 B-frames (good for quality, Twitch compatible)
      );

      // Add CBR-specific x264 options for stable bitrate
      if (useCbr) {
        args.push('-x264-params', `nal-hrd=cbr:force-cfr=1:rc-lookahead=${Math.min(rcLookahead, 60)}`);
      } else if (rcLookahead > 0) {
        args.push('-x264-params', `rc-lookahead=${Math.min(rcLookahead, 60)}`);
      }

      args.push(
        '-c:a', 'aac',
        '-b:a', audioBitrate + 'k',
        '-ar', '48000'           // 48kHz is standard for streaming
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

  // Output format depends on protocol
  if (isSrtOutput) {
    // SRT uses MPEG-TS container
    args.push('-f', 'mpegts', outputUrl);
  } else {
    // RTMP uses FLV container
    args.push('-f', 'flv', fullRtmpUrl);
  }

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

    // Detect input protocol and build appropriate input URL
    const inputStatus = await checkInputStatus();
    let inputUrl;
    if (inputStatus.protocol === 'srt') {
      inputUrl = `srt://${NGINX_HOST}:${SRT_PORT}?streamid=read:live/stream&mode=caller`;
      console.log('Using SRT input');
    } else {
      inputUrl = `rtmp://${NGINX_HOST}:${RTMP_PORT}/live/stream`;
      console.log('Using RTMP input');
    }

    // Start FFmpeg relay for each platform
    for (const platform of platforms) {
      const ffmpegArgs = buildFFmpegArgs(platform, inputUrl, useNvenc);

      console.log(`Starting relay to ${platform.name}:`, ffmpegArgs.join(' ').substring(0, 100) + '...');

      const proc = spawn('ffmpeg', ffmpegArgs);

      // Initialize stats for this platform
      platformStats.set(platform.id, { history: [], current: null, platformName: platform.name });

      proc.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg) {
          // Parse FFmpeg progress output for stats
          const stats = parseFFmpegOutput(msg);
          if (stats) {
            updatePlatformStats(platform.id, stats);
          }
          // Only log non-progress messages (errors, warnings)
          if (!msg.includes('frame=') && !msg.includes('bitrate=')) {
            console.log(`[${platform.name}] ${msg.slice(0, 200)}`);
          }
        }
      });

      proc.on('error', (err) => {
        console.error(`[${platform.name}] FFmpeg error:`, err.message);
      });

      proc.on('close', (code) => {
        console.log(`[${platform.name}] FFmpeg exited with code ${code}`);
        relayProcesses.delete(platform.id);
        // Keep stats for viewing after stream ends, but mark as ended
        const stats = platformStats.get(platform.id);
        if (stats) {
          stats.ended = true;
          stats.endTime = Date.now();
        }

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

// Stop a single platform stream (by platform ID)
app.post('/relay/stop/:platformId', (req, res) => {
  const { platformId } = req.params;
  const proc = relayProcesses.get(platformId);

  if (!proc) {
    return res.status(404).json({ error: 'Platform stream not found', platformId });
  }

  console.log(`Stopping relay to ${proc.platform}...`);
  if (proc.process && !proc.process.killed) {
    proc.process.kill('SIGTERM');
  }
  relayProcesses.delete(platformId);

  // Update relay status
  if (relayProcesses.size === 0) {
    relayActive = false;
    streamStartTime = null;
  }

  res.json({ success: true, message: `Stopped relay to ${proc.platform}`, platformId });
});

// Start a single platform stream (by platform ID)
app.post('/relay/start/:platformId', async (req, res) => {
  const { platformId } = req.params;

  try {
    // Check if already running
    if (relayProcesses.has(platformId)) {
      return res.status(400).json({ error: 'Platform stream already running', platformId });
    }

    // Detect NVENC availability
    const useNvenc = await detectNvenc();

    // Fetch platform config from dashboard
    const platformsRes = await fetch(DASHBOARD_URL + '/api/vm/platforms', {
      headers: { 'Authorization': 'Bearer ' + API_SECRET }
    });

    if (!platformsRes.ok) {
      return res.status(500).json({ error: 'Failed to fetch platforms from dashboard' });
    }

    const { platforms } = await platformsRes.json();
    const platform = platforms.find(p => p.id === platformId);

    if (!platform) {
      return res.status(404).json({ error: 'Platform not found or not enabled', platformId });
    }

    // Detect input protocol and build appropriate input URL
    const inputStatus = await checkInputStatus();
    let inputUrl;
    if (inputStatus.protocol === 'srt') {
      inputUrl = `srt://${NGINX_HOST}:${SRT_PORT}?streamid=read:live/stream&mode=caller`;
    } else {
      inputUrl = `rtmp://${NGINX_HOST}:${RTMP_PORT}/live/stream`;
    }

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

    relayActive = true;
    if (!streamStartTime) {
      streamStartTime = new Date();
    }

    res.json({ success: true, message: `Started relay to ${platform.name}`, platformId });
  } catch (error) {
    console.error('Failed to start platform relay:', error);
    res.status(500).json({ error: error.message });
  }
});

// Restart a single platform stream (stop then start)
app.post('/relay/restart/:platformId', async (req, res) => {
  const { platformId } = req.params;

  try {
    // Stop if running
    const existingProc = relayProcesses.get(platformId);
    if (existingProc && existingProc.process && !existingProc.process.killed) {
      console.log(`Stopping relay to ${existingProc.platform} for restart...`);
      existingProc.process.kill('SIGTERM');
      relayProcesses.delete(platformId);
      // Brief delay to let process die
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    // Detect NVENC availability
    const useNvenc = await detectNvenc();

    // Fetch platform config from dashboard
    const platformsRes = await fetch(DASHBOARD_URL + '/api/vm/platforms', {
      headers: { 'Authorization': 'Bearer ' + API_SECRET }
    });

    if (!platformsRes.ok) {
      return res.status(500).json({ error: 'Failed to fetch platforms from dashboard' });
    }

    const { platforms } = await platformsRes.json();
    const platform = platforms.find(p => p.id === platformId);

    if (!platform) {
      return res.status(404).json({ error: 'Platform not found or not enabled', platformId });
    }

    // Detect input protocol and build appropriate input URL
    const inputStatus = await checkInputStatus();
    let inputUrl;
    if (inputStatus.protocol === 'srt') {
      inputUrl = `srt://${NGINX_HOST}:${SRT_PORT}?streamid=read:live/stream&mode=caller`;
    } else {
      inputUrl = `rtmp://${NGINX_HOST}:${RTMP_PORT}/live/stream`;
    }

    const ffmpegArgs = buildFFmpegArgs(platform, inputUrl, useNvenc);

    console.log(`Restarting relay to ${platform.name}:`, ffmpegArgs.join(' ').substring(0, 100) + '...');

    const newProc = spawn('ffmpeg', ffmpegArgs);

    newProc.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) {
        console.log(`[${platform.name}] ${msg.slice(0, 200)}`);
      }
    });

    newProc.on('error', (err) => {
      console.error(`[${platform.name}] FFmpeg error:`, err.message);
    });

    newProc.on('close', (code) => {
      console.log(`[${platform.name}] FFmpeg exited with code ${code}`);
      relayProcesses.delete(platform.id);

      if (relayProcesses.size === 0) {
        relayActive = false;
        streamStartTime = null;
      }
    });

    relayProcesses.set(platform.id, {
      process: newProc,
      platform: platform.name,
      rtmpUrl: platform.rtmpUrl,
      startTime: new Date()
    });

    relayActive = true;
    if (!streamStartTime) {
      streamStartTime = new Date();
    }

    res.json({ success: true, message: `Restarted relay to ${platform.name}`, platformId });
  } catch (error) {
    console.error('Failed to restart platform relay:', error);
    res.status(500).json({ error: error.message });
  }
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
  console.log(`RTMP Input: rtmp://${NGINX_HOST}:${RTMP_PORT}/live/stream`);
  console.log(`SRT Input: srt://${NGINX_HOST}:${SRT_PORT}?streamid=live/stream`);
  console.log(`MediaMTX API: ${MEDIAMTX_API}`);
});
