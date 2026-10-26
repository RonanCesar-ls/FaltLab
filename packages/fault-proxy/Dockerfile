# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
WORKDIR /workspace
RUN npm install --global pnpm@10.33.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY examples/checkout/package.json ./examples/checkout/package.json
COPY examples/payment-provider/package.json ./examples/payment-provider/package.json
COPY packages/fault-proxy/package.json ./packages/fault-proxy/package.json
RUN pnpm install --frozen-lockfile
COPY packages/fault-proxy ./packages/fault-proxy
RUN pnpm --filter @faultlab/fault-proxy build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3003
WORKDIR /app
COPY --from=build --chown=node:node /workspace/packages/fault-proxy/dist ./dist
USER node
EXPOSE 3003
HEALTHCHECK --interval=2s --timeout=3s --start-period=5s --retries=10 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT??'3003')+'/health',{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
