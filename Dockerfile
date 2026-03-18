FROM n8nio/n8n:latest

# Copy workflows for easy import
COPY workflows/ /home/node/.n8n/workflows-import/

# Copy Google service account key
COPY peak-lattice-398418-eeb02e45c896.json /home/node/google-credentials.json

ENV N8N_PORT=${PORT:-5678}
ENV N8N_PROTOCOL=https
ENV GENERIC_TIMEZONE=America/New_York
