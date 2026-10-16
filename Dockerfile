FROM node:26-alpine AS deps
WORKDIR /app


RUN apk add --no-cache libc6-compat


COPY package*.json ./

RUN npm ci --omit=dev && npm cache clean --force

FROM node:26-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

RUN apk add --no-cache dumb-init

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY index.js ./

USER node

EXPOSE 3000

CMD ["node", "index.js"]
