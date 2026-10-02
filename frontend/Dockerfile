# ── Stage 1: Build React app ──────────────────────────────────────────────────
FROM node:22-slim AS builder

WORKDIR /app

# Copy package files
COPY package.json package-lock.json* ./

# Install deps (use install not ci in case lock file is missing)
RUN npm install

# Copy all source including .env for Vite build-time env vars
COPY . .

# Build React app
RUN npm run build

# ── Stage 2: Serve with Nginx ─────────────────────────────────────────────────
FROM nginx:alpine

# Copy built React app
COPY --from=builder /app/dist /usr/share/nginx/html

# Remove default nginx config — we mount our own via docker-compose volume
RUN rm -f /etc/nginx/conf.d/default.conf

EXPOSE 80 443

CMD ["nginx", "-g", "daemon off;"]
