FROM node:20-alpine AS builder

WORKDIR /app
# From the lock file, not a fresh resolve. A lockless `npm install` builds
# whatever the registry holds today, and it stopped building at all
# ("Cannot read properties of null (reading 'edgesOut')") without a line of
# this repo changing — every source install and every published image with it.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
