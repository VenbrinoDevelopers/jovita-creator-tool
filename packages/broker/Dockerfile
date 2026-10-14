FROM node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates ffmpeg git \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
COPY package.json package-lock.json ./
COPY packages/runtime/package.json packages/runtime/package.json
COPY packages/provider-catalog/package.json packages/provider-catalog/package.json
COPY packages/sdk/package.json packages/sdk/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/broker/package.json packages/broker/package.json
RUN npm ci --ignore-scripts
COPY packages/provider-catalog packages/provider-catalog
COPY packages/broker packages/broker
RUN npm run build -w @jovita-ai/provider-catalog && npm run build -w @jovita-ai/broker
USER node
ENV NODE_ENV=production
ENV BROKER_HOST=0.0.0.0
EXPOSE 19091
CMD ["npm", "run", "start", "-w", "@jovita-ai/broker"]
