FROM node:24-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

# 0.0.0.0 so the published port can reach the daemon; keep it host-local by
# publishing as 127.0.0.1:7688:7688 (see docker-compose.yml)
ENV GRAF_MCP_HOST=0.0.0.0 \
    GRAF_MCP_PORT=7688 \
    GRAF_MCP_DB=/app/data/graph.kuzu

EXPOSE 7688
VOLUME /app/data

HEALTHCHECK --interval=30s --timeout=4s --start-period=15s \
  CMD node -e "fetch('http://127.0.0.1:7688/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/daemon.js"]
