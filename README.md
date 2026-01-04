# AI Resizer 1920×1080 (HF Outpainting)
AI-first resizer that outputs **exactly 1920×1080**.
If the AI fails, it returns a JSON error with a reason and a `jobId` for retry (5-minute in-memory TTL). You can opt into a deterministic fallback.

## Quickstart
1) Create `.env`:
```bash
cp .env.example .env
```
2) Set your Hugging Face token in `.env`:
- `HF_TOKEN=...`
3) Start:
```bash
./start.sh
```
4) Open:
- http://localhost:3002

## API
- `POST /api/resize-only` (multipart: `image`, optional `prompt`, optional `fallback=true`)
- `POST /api/jobs/:jobId/retry?fallback=true|false`
- `GET /api/jobs/:jobId`
- `GET /healthz`

## Limits
- Upload limit: 25MB
- Job TTL: 5 minutes

## Docker
Build:
```bash
docker build -t ai-resizer-1920x1080 .
```
Run:
```bash
docker run --rm -p 3002:3002 -e HF_TOKEN=hf_your_token_here ai-resizer-1920x1080
```

## License
MIT
