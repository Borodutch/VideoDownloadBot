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

In groups the bot needs privacy mode off (BotFather → Bot Settings → Group Privacy) or admin rights to see links. Replying to a message with a link and mentioning the bot (`@VideoDownloadBot`) downloads the replied-to link. With Guest Mode on (BotFather Mini App → bot settings), the same mention works in any chat, even ones the bot isn't in.

## License

MIT
