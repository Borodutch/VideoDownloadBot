# videodownloadbot-warp (Tugport target `warp`): Cloudflare WARP as an HTTP proxy on :25345 that the bot sends
# YouTube through (WARP_PROXY, #415). wireproxy runs the WireGuard tunnel in userspace (no NET_ADMIN); its config,
# a wgcf profile plus `[http] BindAddress = 0.0.0.0:25345`, is the service's file mount /wireproxy.conf.
# wireproxy built from source: v1.1.3 is upstream's latest release, and its prebuilt binary carries Go 1.26.5 and
# x/net and x/crypto versions with known CVEs (#913). The module and the bumped x/ versions (x/sys follows) are
# pinned and checked against sum.golang.org.
FROM golang:1.26.11-trixie@sha256:f9e99477a80ccd7adfb69780510b22c7249ce9169885f18aa762cd886e75e018 AS wireproxy
RUN go mod download github.com/windtf/wireproxy@v1.1.3 \
  && cp -r "$(go env GOMODCACHE)/github.com/windtf/wireproxy@v1.1.3" /src && chmod -R u+w /src
WORKDIR /src
RUN go get golang.org/x/net@v0.63.0 golang.org/x/crypto@v0.59.0 \
  && CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=v1.1.3" -o /wireproxy ./cmd/wireproxy

FROM oven/bun:1.4.5@sha256:3aa040e5445efa09d75bb428a64ba50db13e2b3ac9b6b0c7f145615f62b2ee18 AS warp
# zlib1g: the base image's is older than Debian's fix for CVE-2026-85091
RUN apt-get update && apt-get install -y --no-install-recommends --only-upgrade zlib1g && rm -rf /var/lib/apt/lists/*
COPY --from=wireproxy /wireproxy /usr/local/bin/wireproxy
CMD ["wireproxy", "-s", "-c", "/wireproxy.conf"]

FROM oven/bun:1.4.5@sha256:3aa040e5445efa09d75bb428a64ba50db13e2b3ac9b6b0c7f145615f62b2ee18
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates zlib1g && rm -rf /var/lib/apt/lists/*
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
