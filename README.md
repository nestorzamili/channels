# Channels

A messaging platform built with Bun, TypeScript, and [Zaileys](https://zaileys.kejaa.id).

## Features

- WhatsApp Web integration with QR or pairing-code login and persistent sessions.
- Interactive FAQ: topics → questions → answers, with native lists, buttons, and pagination.
- Keyword search, support contact details, and numbered text menus as a fallback.
- Automatic greetings with a 30-second cooldown per chat.
- JSON-based FAQ content with startup validation.
- Readable development logs and structured JSON production logs.

## Quick Start

Requires [Bun](https://bun.sh). Node.js 20+ is needed for the doctor check.

```bash
bun install
cp .env.example .env
```

Edit `.env` with your bot name and support contact details, then run `bun run dev`. Scan the QR code using WhatsApp's **Linked Devices** menu. For pairing-code login, set `WA_AUTH_TYPE=pairing` and `WA_PHONE_NUMBER` to your bot's number, including the country code and digits only.

Send `halo` or `menu` to open the FAQ. Use `kembali` to go back or `teks` to switch to numbered menus.

## Configuration

See [.env.example](.env.example) for all settings.

- `FAQ_ENABLED=false` disables FAQ replies while keeping WhatsApp connected. Default: `true`.
- `WA_MENU_MODE=text` uses numbered menus. Default: `native`.
- `WA_SESSION_ID` identifies the saved WhatsApp session. Run one process per session.
- `LOG_LEVEL` controls application and Zaileys logs. Default: `info`, with Zaileys warnings and errors enabled; use `debug` for library diagnostics.

Edit [faq.data.json](src/modules/faq/faq.data.json) to update topics and answers. Topic IDs must be unique; question IDs must be unique across all topics, ignoring case. Restart after changing configuration or FAQ content; rebuild the image for Docker deployments.

Sessions are stored in `.zaileys/auth/<WA_SESSION_ID>`. Activity logs include sender phone numbers and message IDs for debugging.

## Run and Check

```bash
bun run start
bun test
bun run typecheck
bun run doctor
```

Images are published to GHCR with the seven-character commit SHA as their only tag. Set `IMAGE_TAG` to the published commit, then link WhatsApp interactively before starting the service:

```bash
export IMAGE_TAG="$(git rev-parse --short=7 HEAD)"
docker compose pull
docker compose run --rm channels
docker compose up -d
```

Use `docker compose build` for a local build. The runtime image contains the production bundle, FAQ JSON, and production dependencies; sessions remain in a named volume.

## Coming Soon

- WhatsApp Cloud API integration.
- Telegram integration.
- Discord integration.
