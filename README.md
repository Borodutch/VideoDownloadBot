# [@VideoDownloadBot](https://t.me/VideoDownloadBot)

Send it a link (or post one in a group it's in) and it replies with the video. Downloads go through [yt-dlp](https://github.com/yt-dlp/yt-dlp); every sent file's Telegram `file_id` is kept in SQLite, so the same link (or the same video under another link) is resent instantly. Originally developed by [MaxiFilippov](https://github.com/MaxiFilippov).

## Run

```sh
bun install
TOKEN=123:abc bun bot.ts
```

Needs `yt-dlp` and `ffmpeg` on PATH (the Dockerfile ships both). `bun test` runs the checks.

## Environment

- `TOKEN`: Telegram bot token
- `BOT_API_URL`: Bot API server, default `https://api.telegram.org`. Point it at a [local Bot API server](https://github.com/tdlib/telegram-bot-api) (`--local`) to upload up to 2000 MB instead of 50 MB
- `COOKIES`: Netscape cookies file for yt-dlp (a logged-in YouTube session), default `/cookies.txt`, skipped if missing. It seeds `DATA_DIR/cookies.txt`, which keeps the cookies yt-dlp refreshes; replacing `COOKIES` reseeds it. Every 6 h the bot opens Watch Later to keep the session in use and checks it's still logged in
- `ADMIN_ID`: Telegram user ID that gets a DM when the YouTube login dies
- `STORAGE_CHAT`: chat the bot uploads guest-mode videos to before putting them into its guest reply (each upload is deleted right away), default `ADMIN_ID` (guest replies fail without either)
- `DATA_DIR`: where `bot.sqlite` lives, default `./data` (`/data` in Docker)
- `MAX_DOWNLOADS`: parallel downloads, default 3
- `STATS_PORT`: port of the stats endpoint, default 8080. `GET /stats` returns chat and user totals and new ones per UTC day (counted from when the bot first sees them; ids only, nothing else is stored) for stats.borodutch.com. Don't give it a public domain
- `PROMO_TOKEN`: turns on cross-promotion experiments (`promo.ts`): campaigns come from `PROMO_URL` (default `https://lumen.borodutch.com/go/campaigns.json`, edited in Prime Radiant's `go/campaigns.json`), and the token signs the seen/shown events and salts the user hashes in them. Unset, or `PROMO=off`, means no promos at all. Promos only go into private-chat replies, at most one per reply and one per person per campaign's `cap_days`, and every person stays in the same arm (a variant or the holdout, which never sees one). Links to another bot are native deep links (`t.me/<bot>?start=<campaign>-<variant>-vdb`, which Telegram opens in the app; the promoted bot reports the /start), channel invite links go as they are, and only web pages go through the tracking redirect
- `EGRESS_DENY`: comma-separated addresses or CIDRs (IPv4 and IPv6) that yt-dlp may never reach, on top of the private, loopback and link-local ranges it's always kept out of. **Set it on deploy to the server's own public IPv4 address and IPv6 prefix** (e.g. `1.2.3.4/32,2a01:4f8:c0c:1::/64`). Those addresses look public, but they lead to every port docker publishes on the host (the panel, the reverse proxy's internal routes), and a cloud firewall doesn't filter traffic that starts on the host. If docker gives containers global IPv6 addresses from a routed prefix outside the host's /64, list that prefix too. A malformed entry stops the bot at startup

In groups the bot needs privacy mode off (BotFather → Bot Settings → Group Privacy) or admin rights to see links. There it only picks up links to sites yt-dlp has a dedicated extractor for (YouTube, TikTok, Instagram, X and so on) and stays quiet when such a page has no video; other links, like a bare domain or an article, are ignored unless the bot is mentioned. Replying to a message with a link and mentioning the bot (`@VideoDownloadBot`) downloads the replied-to link. With Guest Mode on (BotFather Mini App → bot settings), the same mention works in any chat, even ones the bot isn't in.

## License

MIT
