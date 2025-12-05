#!/bin/bash
# Stream Relay - Quick Start Script
# This script starts the relay and auto-registers with your dashboard

set -e

# Load environment variables
if [ -f .env ]; then
    export $(grep -v '^#' .env | xargs)
fi

# Check if .env exists
if [ ! -f .env ]; then
    echo "Creating .env file with random API secret..."
    API_SECRET=$(openssl rand -hex 32)
    cat > .env << EOF
# Stream Relay Environment Configuration
API_SECRET=$API_SECRET
DASHBOARD_URL=
RELAY_TOKEN=
EOF
    echo ""
    echo "Generated API Secret: $API_SECRET"
    echo "(Save this - you'll need it for the dashboard)"
    echo ""
    echo "IMPORTANT: Edit .env and add your DASHBOARD_URL and RELAY_TOKEN"
    echo "           Get these from your dashboard settings page"
    echo ""
fi

# Start the containers
echo "Starting Stream Relay..."
docker-compose up -d --build

# Wait for tunnel to initialize
echo ""
echo "Waiting for tunnel to connect..."
sleep 8

# Extract the tunnel URL
echo "Getting your public URL..."
TUNNEL_URL=$(docker-compose logs tunnel 2>&1 | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1)

echo ""
echo "============================================"
echo "  STREAM RELAY STARTED"
echo "============================================"
echo ""

if [ -n "$TUNNEL_URL" ]; then
    echo "Your Public URL: $TUNNEL_URL"
    echo ""

    # Auto-register with dashboard if configured
    if [ -n "$RELAY_TOKEN" ] && [ -n "$DASHBOARD_URL" ]; then
        echo "Registering with dashboard..."
        RESULT=$(curl -s -L -X POST "$DASHBOARD_URL/api/relay/register" \
            -H "Content-Type: application/json" \
            -d "{\"token\":\"$RELAY_TOKEN\",\"url\":\"$TUNNEL_URL\"}" 2>/dev/null || echo '{"error":"connection failed"}')

        if echo "$RESULT" | grep -q "success"; then
            echo "✓ Successfully registered with dashboard!"
            echo "  Your relay URL will auto-update on restart."
        else
            echo "⚠ Registration failed: $RESULT"
            echo "  Check your RELAY_TOKEN and DASHBOARD_URL in .env"
        fi
        echo ""
    else
        echo "Auto-registration not configured."
        echo "Add RELAY_TOKEN and DASHBOARD_URL to .env for automatic URL updates."
        echo ""
        echo "For manual setup, use these in your dashboard settings:"
        echo "  Relay URL: $TUNNEL_URL"
        echo "  API Secret: (check your .env file)"
        echo ""
    fi
else
    echo "Tunnel URL not ready yet. Run this to see it:"
    echo "  docker-compose logs tunnel | grep trycloudflare"
    echo ""
fi

# Show OBS settings
LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "your-server-ip")
echo "For OBS (RTMP):"
echo "  Server: rtmp://$LOCAL_IP:1935/live"
echo "  Stream Key: stream"
echo ""
echo "For OBS (SRT - recommended):"
echo "  Server: srt://$LOCAL_IP:8890"
echo "  Stream Key: streamid=publish:live/stream"
echo ""
echo "============================================"
echo ""
echo "Useful commands:"
echo "  View logs:    docker-compose logs -f"
echo "  Re-register:  ./start.sh"
echo "  Stop:         docker-compose down"
echo "  Restart:      docker-compose restart && ./start.sh"
echo ""
