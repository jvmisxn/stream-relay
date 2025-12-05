# Stream Relay Docker Image
# For self-hosted multi-platform streaming relay

FROM node:20-slim

# Install FFmpeg and required dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (production only)
RUN npm install --only=production

# Copy application code
COPY index.js ./

# Expose API port and RTMP port
EXPOSE 3001 1935

# Environment variables (must be provided at runtime)
ENV NODE_ENV=production
ENV PORT=3001
ENV RTMP_PORT=1935

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "fetch('http://localhost:3001/health', {headers: {'Authorization': 'Bearer ' + process.env.API_SECRET}}).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Run the application
CMD ["node", "index.js"]
