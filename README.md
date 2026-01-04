# AI Resizer 1920×1080 (HF Outpainting)
A standalone, AI-first image resizer that outputs **exactly 1920×1080**.
It tries Hugging Face outpainting first, and only returns an image if the AI succeeds.
Optionally, you can enable a deterministic fallback (always returns 1920×1080) if AI fails.

## What this does
- Upload any image
- Server requests an AI outpaint/resize via Hugging Face
- If AI succeeds and output validates as 1920×1080 → returns PNG
- If AI fails → returns a JSON error with a reason + a `jobId`
- In-memory queue supports retry for 5 minutes (no re-upload needed)

## Requirements
- Node.js 18+
- Python 3.10+
- A Hugging Face token with access to the Inference API

## Setup
1) Install dependencies & start:
```bash
./start.sh
```
2) Create `.env`:
```bash
cp .env.example .env
```
3) Edit `.env` and set:
- `HF_TOKEN=...`

## Run
Open:
- http://localhost:3002

## API
### POST /api/resize-only
multipart/form-data:
- `image` (file)
- `fallback` (optional, set to `true`)
- `prompt` (optional)

Success:
- `200 image/png`
- `X-Job-Id: <jobId>`

AI Failure (no fallback):
- `502 application/json`
```json
{"ok":false,"jobId":"...","reasonCode":"HF_FAILED","message":"...","retryAfterSeconds":10}
```

### POST /api/jobs/:jobId/retry?fallback=true|false
Retries the last upload stored in memory.

### GET /api/jobs/:jobId
Returns status and last failure reason.

## Notes
- Jobs expire after 5 minutes.
- Max upload size is 25MB.

## License
MIT
