FROM oven/bun:1.4-alpine
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production
COPY tsconfig.json ./
COPY src ./src
ENV NODE_ENV=production
EXPOSE 3000
# exec form → bun is PID 1 and receives SIGTERM directly (graceful shutdown)
CMD ["bun", "run", "src/main.ts"]
