# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
WORKDIR /workspace
RUN npm install --global pnpm@10.33.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY examples/checkout/package.json ./examples/checkout/package.json
COPY examples/payment-provider/package.json ./examples/payment-provider/package.json
RUN pnpm install --frozen-lockfile
COPY examples/checkout ./examples/checkout
RUN pnpm --filter @faultlab/checkout build \
    && pnpm --filter @faultlab/checkout deploy --prod --legacy /out

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 3001
HEALTHCHECK --interval=5s --timeout=4s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT??'3001')+'/health/ready',{signal:AbortSignal.timeout(2500)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
