#!/bin/sh
set -e

# Install OpenCode if not present. A relay-mode connector runs no agent, so it
# neither needs the binary nor may fetch one.
if [ -n "$RELAY_SOCKET" ]; then
  echo "[DOCKER] Relay mode: no agent runs in this container; OpenCode not installed"
elif [ ! -f /root/.opencode/bin/opencode ]; then
  echo "[DOCKER] Installing OpenCode..."
  curl -fsSL https://opencode.ai/install | bash
  echo "[DOCKER] OpenCode installed"
fi
export PATH="/root/.opencode/bin:$PATH"

case "$CONNECTOR" in
  discord)
    exec bun connectors/discord.ts
    ;;
  slack)
    exec bun connectors/slack.ts
    ;;
  matrix)
    exec bun connectors/matrix.ts
    ;;
  whatsapp)
    exec bun connectors/whatsapp.ts
    ;;
  mattermost)
    exec bun connectors/mattermost.ts
    ;;
  telegram)
    exec bun connectors/telegram.ts
    ;;
  *)
    echo "Unknown connector: $CONNECTOR"
    echo "Valid options: discord, slack, matrix, whatsapp, mattermost, telegram"
    exit 1
    ;;
esac
