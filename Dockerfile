FROM node:20-bookworm-slim

# System deps for sharp + python venv
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-venv python3-pip ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Node deps
COPY package.json package-lock.json ./
RUN npm ci

# Python deps (HF client)
RUN python3 -m venv /app/venv \
  && /app/venv/bin/python -m pip install --upgrade pip \
  && /app/venv/bin/python -m pip install --no-cache-dir requests pillow huggingface_hub

# App source
COPY server.js resizer.html standalone_resizer.py ./

ENV PORT=3002
EXPOSE 3002

# HF_TOKEN must be provided at runtime
CMD ["node", "server.js"]
