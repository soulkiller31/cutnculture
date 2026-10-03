# ── Stage 1: Build React app ──────────────────────────────────────────────────
FROM node:22-slim AS builder

WORKDIR /app

# Ensure VITE_API_URL is always /api — never localhost
ARG VITE_API_URL=/api
ENV VITE_API_URL=$VITE_API_URL

COPY package.json package-lock.json* ./
RUN npm install

# Copy all source including .env
COPY . .

# Override .env to guarantee correct API URL regardless of what .env says
RUN echo "VITE_API_URL=/api" > .env.production

RUN npm run build

# ── Stage 2: Final image with built files ─────────────────────────────────────
FROM alpine:latest
WORKDIR /app/dist
COPY --from=builder /app/dist .
