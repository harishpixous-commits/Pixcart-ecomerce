FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-alpine AS build
WORKDIR /app
# The /api and /media proxy target is fixed into the standalone build, so pass the API's internal URL here.
ARG API_ORIGIN=http://api:8000
ENV NEXT_TELEMETRY_DISABLED=1 API_ORIGIN=${API_ORIGIN}
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
RUN addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
USER app
EXPOSE 3000
# API_ORIGIN is also read at runtime for server-rendered pages; PUBLIC_WEB_URL sets canonical URLs.
CMD ["node", "server.js"]
