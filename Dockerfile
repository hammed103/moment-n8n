FROM n8nio/n8n:latest

# Copy workflows for easy import
COPY workflows/ /home/node/.n8n/workflows-import/

ENV N8N_PORT=${PORT:-5678}
ENV N8N_PROTOCOL=https
ENV GENERIC_TIMEZONE=America/New_York
ENV QUEUE_HEALTH_CHECK_ACTIVE=true

# Write Google credentials from env var at startup
COPY entrypoint.sh /home/node/entrypoint.sh
ENTRYPOINT ["tini", "--", "/home/node/entrypoint.sh"]
