# Build React app and copy dist to shared volume
FROM node:22-slim AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY . .
RUN npm run build

# Final stage — just copies the built files into the image
# Nginx will mount the volume and serve from there
FROM alpine:latest
WORKDIR /app/dist
COPY --from=builder /app/dist .
