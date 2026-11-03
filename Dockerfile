# videodownloadbot-warp (Tugport target `warp`): Cloudflare WARP as an HTTP proxy on :25345 that the bot sends
# YouTube through (WARP_PROXY, #415). wireproxy runs the WireGuard tunnel in userspace (no NET_ADMIN); its config,
# a wgcf profile plus `[http] BindAddress = 0.0.0.0:25345`, is the service's file mount /wireproxy.conf.
FROM oven/bun:1.4.4 AS warp
ADD --checksum=sha256:e88c1d090740373fc606c1bafd81d9a5eadc642cce5667616e20e9d7a444f51c https://github.com/whyvl/wireproxy/releases/download/v1.1.3/wireproxy_linux_amd64.tar.gz /tmp/wireproxy.tgz
RUN tar xzf /tmp/wireproxy.tgz -C /usr/local/bin wireproxy && rm /tmp/wireproxy.tgz
CMD ["wireproxy", "-s", "-c", "/wireproxy.conf"]

FROM oven/bun:1.4.4
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
# A pinned nightly, so this layer stays cached (an unpinned URL is downloaded again on every build). The bot
# updates it to the latest nightly before it starts polling and then daily (a failed update is tried again within
# the hour), so it still runs the newest nightly.
ADD --checksum=sha256:e96ebc0e090ad01514ed97f87f13f31abd3711a5ca595fbcc0544cde4227f96b --chmod=755 https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/download/2026.10.23.233055/yt-dlp_linux /usr/local/bin/yt-dlp
WORKDIR /app
COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --production --frozen-lockfile
COPY *.ts ./
ENV DATA_DIR=/data
CMD ["bun", "bot.ts"]
