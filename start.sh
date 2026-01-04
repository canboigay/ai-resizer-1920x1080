#!/bin/bash
set -e

echo "🚀 Launching AI Resizer (1920x1080)..."

# Node deps
if [ ! -d "node_modules" ]; then
  echo "📦 Installing Node dependencies..."
  npm install
fi

# Python venv for HF client
if [ ! -d "venv" ]; then
  echo "🐍 Creating Python venv..."
  python3 -m venv venv
fi

echo "🐍 Ensuring Python deps..."
./venv/bin/python -m pip install --upgrade pip >/dev/null 2>&1 || true
./venv/bin/python -m pip install -q requests pillow huggingface_hub

# Kill anything already on 3002
lsof -ti:3002 | xargs kill -9 2>/dev/null || true

echo "🌐 Starting on http://localhost:3002"
node server.js
