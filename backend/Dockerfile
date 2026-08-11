# ⚠ THE BUILD CONTEXT IS THE REPOSITORY ROOT, NOT ./backend.
#
# Build it as:   docker build -f backend/Dockerfile .
# (docker-compose.yml already does this: `context: .`)
#
# The context has to be the root because the image must carry two things that
# live outside ./backend, and Docker cannot COPY from a parent of its context:
#
#   supabase/migrations   so the container can migrate itself and the image-only
#                         install works with no source tree on the host
#   forge-growth-plugin   so the plugin .zip download works without a bind-mount
#
# Everything the context must NOT include — starting with a real .env — is listed
# in the .dockerignore at the repo root.

FROM node:20-alpine

# ffmpeg for transcoding WhatsApp voice notes (Ogg/Opus → MP3) so Safari can play them
RUN apk add --no-cache ffmpeg

WORKDIR /app

COPY backend/package.json ./
RUN npm install --omit=dev

COPY backend/src/ ./src/
COPY backend/scripts/ ./scripts/
COPY backend/docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

# Baked, not mounted. A bind-mount works only when the host has the repo, which
# is exactly what the image-only install does not have.
COPY supabase/migrations/ ./migrations/
COPY forge-growth-plugin/ ./plugin/

ENV NODE_ENV=production
EXPOSE 3013

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "src/index.js"]
