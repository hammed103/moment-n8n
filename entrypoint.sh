#!/bin/sh
if [ -n "$GOOGLE_CREDENTIALS_JSON" ]; then
  echo "$GOOGLE_CREDENTIALS_JSON" > /home/node/google-credentials.json
fi
exec n8n start
