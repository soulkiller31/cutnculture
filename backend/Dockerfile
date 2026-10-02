FROM node:22-slim

# Install Google Chrome for Puppeteer / WhatsApp
RUN apt-get update && apt-get install -y \
    wget gnupg curl ca-certificates \
    fonts-liberation libatk-bridge2.0-0 libatk1.0-0 \
    libcups2 libdbus-1-3 libdrm2 libgbm1 libgtk-3-0 \
    libnspr4 libnss3 libx11-xcb1 libxcomposite1 \
    libxdamage1 libxfixes3 libxrandr2 libxss1 xdg-utils \
    libasound2 libpango-1.0-0 libpangocairo-1.0-0 \
    --no-install-recommends \
  && wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | apt-key add - \
  && echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" \
       > /etc/apt/sources.list.d/google-chrome.list \
  && apt-get update \
  && apt-get install -y google-chrome-stable --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copy source
COPY . .

# Pre-create WhatsApp session dirs
RUN mkdir -p .wwebjs_auth .wwebjs_cache .cache/puppeteer

ENV NODE_ENV=production \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

EXPOSE 5000

CMD ["node", "src/server.js"]
