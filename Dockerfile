FROM n8nio/n8n:latest

# Copy workflows for easy import
COPY workflows/ /home/node/.n8n/workflows-import/

ENV N8N_PORT=${PORT:-5678}
ENV N8N_PROTOCOL=https
ENV GENERIC_TIMEZONE=America/New_York

# Write Google credentials from env var at startup
CMD sh -c 'echo "$GOOGLE_CREDENTIALS_JSON" > /home/node/google-credentials.json && n8n start'
