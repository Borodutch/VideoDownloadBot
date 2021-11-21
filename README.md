# [@VideoDownloadBot](https://t.me/VideoDownloadBot) code

Bot that downloads videos and uploads the to Telegram. Originally developed by [MaxiFilippov](https://github.com/MaxiFilippov).

# Installation and local launch

1. Clone this repo: `git clone https://github.com/Borodutch/VideoDownloadBot`
2. Launch the [mongo database](https://www.mongodb.com/) locally
3. Create `.env` with the environment variables listed below
4. Run `yarn` in the root folder
5. Run `yarn develop`

And you should be good to go! Feel free to fork and submit pull requests. Thanks!

# Environment variables

- `TOKEN` — Telegram bot token
- `MONGO` — URL of the mongo database
- `ENVIRONMENT` — `development` or `production`
- `ADMIN_ID` — Telegram ID of the user to get error reports
- `BOT_API_URL` — URL of the bot API (defaults to `https://api.telegram.org`)

Also, please, consider looking at `.env.sample`.

# License

MIT — use for any purpose. Would be great if you could leave a note about the original developers. Thanks!

# CD

`main` branch gets deployed to [@VideoDownloadBot](https://t.me/VideoDownloadBot) automagically with [ci-ninja](https://t.me/backmeupplz/ci-ninja).
