FROM oven/bun:1.4.3-slim

WORKDIR /app

ENV PORT=20134 \
    HOST=0.0.0.0 \
    OPENCODE_CACHE_DIR=/data/cache \
    FUCKING_OPENCODE_STATE_DIR=/data/state

COPY --chown=bun:bun . .

# `COPY --chown` 只会修改复制文件的属主，不会修改包含它们的目录，
# 因此 /app 仍归 root 所有，而进程以 `bun` 身份运行。
# 自更新器会把临时文件放在 __dirname 内的目标文件旁边，
# 所以它需要可写的 /app，否则每次更新都会因 EACCES 失败。
RUN mkdir -p /data/cache /data/state \
    && chown -R bun:bun /data /app

USER bun

EXPOSE 20134

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||'20134')+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["bun", "server.js"]
