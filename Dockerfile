FROM oven/bun:1.4.4
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
# A pinned nightly, so this layer stays cached (an unpinned URL is downloaded again on every build). The bot
# updates it to the latest nightly before it starts and then daily, so it still runs the newest nightly.
ADD --checksum=sha256:e96ebc0e090ad01514ed97f87f13f31abd3711a5ca595fbcc0544cde4227f96b --chmod=755 https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/download/2026.10.23.233055/yt-dlp_linux /usr/local/bin/yt-dlp
WORKDIR /app
COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --production --frozen-lockfile
COPY *.ts ./
ENV DATA_DIR=/data
CMD ["bun", "bot.ts"]
