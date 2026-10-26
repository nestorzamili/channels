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

## Environment

- Local: [`.env.example`](./.env.example)
- Production: GitHub Environment `production` secret `ENV_FILE` (full runtime env)

## CI/CD

- PR → [`ci.yml`](./.github/workflows/ci.yml) (typecheck, tests, and Alpine runtime image verification)
- main → [`deploy.yml`](./.github/workflows/deploy.yml) via [gha-workflows](https://github.com/nestorzamili/gha-workflows)

Environment `production` secrets only (no Variables): `SSH_CONFIG`, `GHCR_USERNAME`, `GHCR_TOKEN`, `ENV_FILE`.

VM (sekali): Docker, network `proxy`, named volume `channels_session` mounted to `/app/.zaileys`.

## Coming Soon

- WhatsApp Cloud API integration.
- Telegram integration.
- Discord integration.
