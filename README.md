# Stream Relay - Self-Hosted

Multi-platform streaming relay with automatic public URL via Cloudflare Tunnel.

## Quick Start (2 commands)

```bash
# 1. Clone and enter directory
git clone https://github.com/yourusername/stream-relay.git && cd stream-relay

# 2. Start everything
chmod +x start.sh && ./start.sh
```

That's it! The script will:
- Generate an API secret automatically
- Start the relay and RTMP server
- Create a public HTTPS URL (no Cloudflare account needed)
- Display all the info you need for the dashboard

## Manual Setup

If you prefer to set things up manually:

```bash
# 1. Create your .env file
cp .env.example .env

# 2. Generate and add an API secret
echo "API_SECRET=$(openssl rand -hex 32)" > .env

# 3. Start the containers
docker-compose up -d

# 4. Get your public URL (wait ~10 seconds first)
docker-compose logs tunnel | grep trycloudflare
```

## Configuration

### Dashboard Settings

In your dashboard's Settings > Self-Hosted tab:

| Field | Value |
|-------|-------|
| **Relay URL** | Your tunnel URL (e.g., `https://abc-xyz.trycloudflare.com`) |
| **API Secret** | The value from your `.env` file |

### OBS Settings

| Field | Value |
|-------|-------|
| **Server** | `rtmp://YOUR-SERVER-IP:1935/live` |
| **Stream Key** | `stream` |

Replace `YOUR-SERVER-IP` with your server's local IP (e.g., `192.168.1.100`).

## How It Works

```
┌─────────────────────────────────────────────────────────────┐
│                     Your Server                              │
│  ┌─────────┐    ┌──────────────┐    ┌─────────────────────┐ │
│  │  OBS    │───▶│ RTMP Server  │───▶│   Stream Relay      │ │
│  │         │    │ (port 1935)  │    │   (port 3001)       │ │
│  └─────────┘    └──────────────┘    └──────────┬──────────┘ │
│                                                 │            │
│                                     ┌───────────┴──────────┐│
│                                     │  Cloudflare Tunnel   ││
│                                     └───────────┬──────────┘│
└─────────────────────────────────────────────────┼───────────┘
                                                  │
                                    ┌─────────────▼────────────┐
                                    │  Public HTTPS URL        │
                                    │  (trycloudflare.com)     │
                                    └─────────────┬────────────┘
                                                  │
┌─────────────────────────────────────────────────▼───────────┐
│                    Dashboard (Vercel)                        │
│  - Controls relay (start/stop/platforms)                    │
│  - Shows stream status                                      │
└─────────────────────────────────────────────────────────────┘
```

## Commands

| Command | Description |
|---------|-------------|
| `docker-compose up -d` | Start all services |
| `docker-compose down` | Stop all services |
| `docker-compose logs -f` | View live logs |
| `docker-compose logs tunnel` | See tunnel URL |
| `docker-compose restart` | Restart services |
| `docker-compose restart tunnel` | Get new tunnel URL |

## Troubleshooting

### Can't find tunnel URL?
```bash
# Wait 10-15 seconds after starting, then:
docker-compose logs tunnel 2>&1 | grep -o 'https://.*trycloudflare.com'
```

### Connection test fails in dashboard?
1. Make sure you're using the full tunnel URL including `https://`
2. Check that the API secret matches exactly
3. Verify containers are running: `docker-compose ps`

### RTMP not receiving stream?
1. Check your server's local IP: `hostname -I`
2. Make sure port 1935 is not blocked by firewall
3. In OBS, use `rtmp://YOUR-LOCAL-IP:1935/live` with key `stream`

### Tunnel URL changed?
The free tunnel URL changes on restart. Just check the logs again:
```bash
docker-compose logs tunnel | grep trycloudflare
```

## GPU Support (NVENC)

To enable hardware encoding with NVIDIA GPUs, edit `docker-compose.yml` and uncomment the GPU section under `stream-relay`.

## Requirements

- Docker & Docker Compose
- Port 1935 open for RTMP input
- ~1GB RAM minimum
