# ── Stage 1: Build React app ──────────────────────────────────────────────────
FROM node:22-slim AS frontend-builder

WORKDIR /app

ARG VITE_API_URL=/api
ENV VITE_API_URL=$VITE_API_URL

COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install

COPY frontend/ .

# Force correct API URL
RUN echo "VITE_API_URL=/api" > .env.production

RUN npm run build

# ── Stage 2: Nginx serving built React + proxying to backend ──────────────────
FROM nginx:alpine

# Copy built React files into nginx
COPY --from=frontend-builder /app/dist /usr/share/nginx/html

RUN rm -f /etc/nginx/conf.d/default.conf

EXPOSE 80 443

CMD ["nginx", "-g", "daemon off;"]
