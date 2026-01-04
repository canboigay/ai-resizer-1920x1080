const express = require('express');
require('dotenv').config();
const multer = require('multer');
const sharp = require('sharp');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const app = express();

// 25MB max upload (in-memory)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

// --- In-memory job queue (expires after 5 minutes) ---
const JOB_TTL_MS = 5 * 60 * 1000;
const jobs = new Map();

function nowMs() {
  return Date.now();
}

function cleanupJobs() {
  const cutoff = nowMs() - JOB_TTL_MS;
  for (const [jobId, job] of jobs.entries()) {
    if ((job.updatedAt || job.createdAt) < cutoff) {
      jobs.delete(jobId);
    }
  }
}
setInterval(cleanupJobs, 60 * 1000).unref();

function makeFailure(reasonCode, message, extra = {}) {
  return { ok: false, reasonCode, message, ...extra };
}

function sendFailure(res, status, reasonCode, message, extra = {}) {
  return res.status(status).json(makeFailure(reasonCode, message, extra));
}

async function validate1920x1080(buffer) {
  const meta = await sharp(buffer).metadata();
  return meta.width === 1920 && meta.height === 1080;
}

async function runHfOutpaintViaPython({ inputBuffer, token, prompt }) {
  const runId = uuidv4();
  const tempInput = path.join(__dirname, `temp_resize_in_${runId}.jpg`);
  const tempOutput = path.join(__dirname, `temp_resize_out_${runId}.png`);

  let stderrTail = '';

  try {
    fs.writeFileSync(tempInput, inputBuffer);

    await new Promise((resolve, reject) => {
      const pythonProcess = spawn(
        'source venv/bin/activate && python standalone_resizer.py',
        ['--input', tempInput, '--output', tempOutput, '--token', token, '--prompt', prompt],
        { shell: true }
      );

      pythonProcess.stdout.on('data', (d) => {
        const s = d.toString().trim();
        if (s) console.log(`[HF ${runId}] ${s}`);
      });

      pythonProcess.stderr.on('data', (d) => {
        const s = d.toString();
        stderrTail = (stderrTail + s).slice(-4000);
        const t = s.trim();
        if (t) console.error(`[HF ${runId} ERR] ${t}`);
      });

      pythonProcess.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`python_exit_${code}`));
      });
    });

    if (!fs.existsSync(tempOutput)) {
      return { ok: false, reasonCode: 'MISSING_OUTPUT', message: 'HF returned no output file.' };
    }

    const out = fs.readFileSync(tempOutput);
    return { ok: true, buffer: out };
  } catch (e) {
    const code = String(e && e.message ? e.message : e);
    const msg = stderrTail || code;
    return { ok: false, reasonCode: 'HF_FAILED', message: msg };
  } finally {
    if (fs.existsSync(tempInput)) fs.unlinkSync(tempInput);
    if (fs.existsSync(tempOutput)) fs.unlinkSync(tempOutput);
  }
}

async function processResizeJob({ jobId, fallback }) {
  const job = jobs.get(jobId);
  if (!job) {
    return { ok: false, status: 404, body: makeFailure('NOT_FOUND', 'Job not found (expired or invalid).') };
  }

  const token = process.env.HF_TOKEN;
  if (!token || token.includes('YOUR_TOKEN')) {
    job.status = 'failed';
    job.updatedAt = nowMs();
    job.reasonCode = 'MISSING_TOKEN';
    job.message = 'Server missing HF_TOKEN in .env';
    return { ok: false, status: 500, body: makeFailure('MISSING_TOKEN', 'Server missing HF_TOKEN in .env') };
  }

  job.status = 'running';
  job.updatedAt = nowMs();
  job.reasonCode = null;
  job.message = null;
  job.fallbackReturned = false;

  const prompt = job.prompt || 'cinematic background extension, seamless, photoreal';
  const hf = await runHfOutpaintViaPython({ inputBuffer: job.inputBuffer, token, prompt });

  if (hf.ok) {
    try {
      const isValid = await validate1920x1080(hf.buffer);
      if (isValid) {
        job.status = 'succeeded';
        job.updatedAt = nowMs();
        return { ok: true, status: 200, buffer: hf.buffer };
      }

      job.status = 'failed';
      job.updatedAt = nowMs();
      job.reasonCode = 'INVALID_DIMENSIONS';
      job.message = 'HF output was not 1920x1080.';

      if (!fallback) {
        return {
          ok: false,
          status: 502,
          body: { ok: false, jobId, reasonCode: job.reasonCode, message: job.message },
        };
      }
    } catch {
      job.status = 'failed';
      job.updatedAt = nowMs();
      job.reasonCode = 'INVALID_IMAGE';
      job.message = 'HF output could not be decoded as an image.';

      if (!fallback) {
        return {
          ok: false,
          status: 502,
          body: { ok: false, jobId, reasonCode: job.reasonCode, message: job.message },
        };
      }
    }
  } else {
    job.status = 'failed';
    job.updatedAt = nowMs();
    job.reasonCode = hf.reasonCode || 'HF_FAILED';
    job.message = hf.message || 'HF outpainting failed.';

    if (!fallback) {
      return {
        ok: false,
        status: 502,
        body: { ok: false, jobId, reasonCode: job.reasonCode, message: job.message, retryAfterSeconds: 10 },
      };
    }
  }

  // Fallback (opt-in): deterministic resize
  const fallbackBuf = await sharp(job.inputBuffer)
    .resize(1920, 1080, { fit: 'cover' })
    .png()
    .toBuffer();

  job.fallbackReturned = true;
  return {
    ok: true,
    status: 200,
    buffer: fallbackBuf,
    fallbackUsed: true,
    failureReason: { reasonCode: job.reasonCode, message: job.message },
  };
}

// Routes
app.get('/healthz', (req, res) => {
  const hasToken = !!(process.env.HF_TOKEN && !process.env.HF_TOKEN.includes('YOUR_TOKEN'));
  res.json({ ok: true, service: 'ai-resizer-1920x1080', hasToken });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'resizer.html'));
});

app.get('/api/jobs/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return sendFailure(res, 404, 'NOT_FOUND', 'Job not found (expired or invalid).');

  res.json({
    ok: true,
    jobId: req.params.jobId,
    status: job.status,
    retryCount: job.retryCount,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    reasonCode: job.reasonCode || null,
    message: job.message || null,
    fallbackReturned: !!job.fallbackReturned,
  });
});

app.post('/api/resize-only', upload.single('image'), async (req, res) => {
  cleanupJobs();

  const file = req.file;
  if (!file) return sendFailure(res, 400, 'NO_IMAGE', 'No image uploaded');

  const fallback = String(req.body.fallback || 'false') === 'true';
  const prompt = (req.body.prompt || 'cinematic background extension, seamless, photoreal').toString();

  const jobId = uuidv4();
  jobs.set(jobId, {
    status: 'queued',
    retryCount: 0,
    createdAt: nowMs(),
    updatedAt: nowMs(),
    inputBuffer: file.buffer,
    prompt,
    reasonCode: null,
    message: null,
    fallbackReturned: false,
  });

  const result = await processResizeJob({ jobId, fallback });

  if (!result.ok) {
    return res.status(result.status).json(result.body);
  }

  if (result.fallbackUsed) {
    res.set('X-AI-Fallback-Used', 'true');
    res.set('X-AI-Failure-Reason', `${result.failureReason.reasonCode}`);
  }

  res.set('Content-Type', 'image/png');
  res.set('X-Job-Id', jobId);
  return res.status(200).send(result.buffer);
});

app.post('/api/jobs/:jobId/retry', async (req, res) => {
  const jobId = req.params.jobId;
  const job = jobs.get(jobId);
  if (!job) return sendFailure(res, 404, 'NOT_FOUND', 'Job not found (expired or invalid).');

  const fallback = String(req.query.fallback || 'false') === 'true';
  job.retryCount += 1;
  job.updatedAt = nowMs();

  const result = await processResizeJob({ jobId, fallback });

  if (!result.ok) {
    return res.status(result.status).json(result.body);
  }

  if (result.fallbackUsed) {
    res.set('X-AI-Fallback-Used', 'true');
    res.set('X-AI-Failure-Reason', `${result.failureReason.reasonCode}`);
  }

  res.set('Content-Type', 'image/png');
  res.set('X-Job-Id', jobId);
  return res.status(200).send(result.buffer);
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
  console.log(`AI Resizer running on http://localhost:${PORT}`);
});
