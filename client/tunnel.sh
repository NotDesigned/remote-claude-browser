#!/bin/sh
# Exits when the connection drops or the forward cannot be set up, and Compose starts it again.
set -eu

for file in /ssh/id_ed25519 /ssh/known_hosts; do
  if [ ! -r "$file" ]; then
    echo "$file is missing or unreadable. See docs/deployment.md for how to create it." >&2
    exit 1
  fi
done

exec ssh -NT \
  -F none \
  -i /ssh/id_ed25519 \
  -p "$SERVER_SSH_PORT" \
  -o BatchMode=yes \
  -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile=/ssh/known_hosts \
  -o GlobalKnownHostsFile=/dev/null \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=15 \
  -o ServerAliveCountMax=3 \
  -o ConnectTimeout=15 \
  -L "0.0.0.0:3010:127.0.0.1:$SERVER_PORT" \
  "$SERVER_SSH_USER@$SERVER_SSH_HOST"
