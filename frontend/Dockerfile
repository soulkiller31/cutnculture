# Build React app and copy dist to shared volume
FROM node:22-slim AS builder

WORKDIR /app

# Build arg — can be overridden at build time, defaults to /api (relative, works on any domain)
ARG VITE_API_URL=/api
ENV VITE_API_URL=$VITE_API_URL

COPY package.json package-lock.json* ./
RUN npm install

# Copy all source including .env (needed for Firebase keys etc.)
COPY . .

# Build — VITE_API_URL is baked into the JS bundle here
RUN npm run build

# Final stage — copy built files into image for volume sharing
FROM alpine:latest
WORKDIR /app/dist
COPY --from=builder /app/dist .
