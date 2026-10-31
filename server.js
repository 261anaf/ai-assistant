require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const { GoogleGenAI } = require('@google/genai');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');

const app = express();
const port = Number.parseInt(process.env.PORT || '3000', 10);
const production = process.env.NODE_ENV === 'production';
const dataDirectory = path.join(__dirname, 'data');
const maxMessageLength = 10_000;
const maxHistoryMessages = 40;
const activeSessions = new Set();

if (!process.env.GEMINI_API_KEY) {
  throw new Error('GEMINI_API_KEY is required. Add it to your .env file.');
}

if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  throw new Error('SESSION_SECRET must be set to a value at least 32 characters long.');
}

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be a valid TCP port number.');
}

fs.mkdirSync(dataDirectory, { recursive: true });

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

if (production) {
  app.set('trust proxy', 1);
}

app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      imgSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"]
    }
  }
}));
app.use(express.json({ limit: '16kb' }));
app.use(session({
  name: 'assistant.sid',
  secret: process.env.SESSION_SECRET,
  store: new FileStore({
    path: path.join(dataDirectory, 'sessions'),
    ttl: 7 * 24 * 60 * 60,
    reapInterval: 60 * 60
  }),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: production,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a little and try again.' }
});

app.use('/api', apiLimiter);
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
app.use(express.static(path.join(__dirname, 'public'), {
  index: 'index.html',
  maxAge: production ? '1h' : 0
}));

function requestHasValidOrigin(req) {
  const origin = req.get('origin');
  if (!origin) return true;

  try {
    const expectedOrigin = `${req.protocol}://${req.get('host')}`;
    return new URL(origin).origin === expectedOrigin;
  } catch {
    return false;
  }
}

function requireSameOrigin(req, res, next) {
  if (!requestHasValidOrigin(req)) {
    return res.status(403).json({ error: 'This request was blocked.' });
  }
  next();
}

function ensureHistory(req) {
  if (!Array.isArray(req.session.history)) {
    req.session.history = [];
  }
  return req.session.history;
}

function saveSession(req) {
  return new Promise((resolve, reject) => {
    req.session.save((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function userFacingError(error) {
  const status = Number(error.status || error.statusCode || error.code);
  if (status === 400 || status === 401 || status === 403) {
    return {
      status: 502,
      message: 'Gemini rejected the request. Check that your API key is valid and has access to the selected model.'
    };
  }
  if (status === 429) {
    return {
      status: 429,
      message: 'Gemini is receiving too many requests right now. Please wait a moment and try again.'
    };
  }
  if (status >= 500) {
    return {
      status: 502,
      message: 'Gemini is temporarily unavailable. Please try again shortly.'
    };
  }
  return {
    status: 502,
    message: 'The assistant could not complete that request. Please try again.'
  };
}

app.get('/api/session', (req, res) => {
  const history = ensureHistory(req);
  res.json({
    messages: history.map(({ role, text }) => ({ role, text })),
    model
  });
});

app.post('/api/chat', requireSameOrigin, async (req, res) => {
  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  if (!message || message.length > maxMessageLength) {
    return res.status(400).json({
      error: `Enter a message between 1 and ${maxMessageLength.toLocaleString()} characters.`
    });
  }

  if (activeSessions.has(req.sessionID)) {
    return res.status(409).json({ error: 'A response is already in progress for this conversation.' });
  }

  activeSessions.add(req.sessionID);
  const abortController = new AbortController();
  const abortIfDisconnected = () => {
    if (!res.writableEnded) abortController.abort();
  };
  res.once('close', abortIfDisconnected);

  try {
    const history = ensureHistory(req);
    const contents = [
      ...history.map(({ role, text }) => ({
        role,
        parts: [{ text }]
      })),
      { role: 'user', parts: [{ text: message }] }
    ];

    const stream = await ai.models.generateContentStream({
      model,
      contents,
      config: {
        maxOutputTokens: 2048,
        abortSignal: abortController.signal,
        httpOptions: { timeout: 120_000 }
      }
    });

    res.status(200);
    res.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.flushHeaders();

    let responseText = '';
    for await (const chunk of stream) {
      const text = chunk.text || '';
      if (!text) continue;
      responseText += text;
      res.write(`data: ${JSON.stringify({ text })}\n\n`);
    }

    if (!responseText.trim()) {
      throw new Error('Gemini returned an empty response.');
    }

    req.session.history = [
      ...history,
      { role: 'user', text: message },
      { role: 'model', text: responseText }
    ].slice(-maxHistoryMessages);
    await saveSession(req);
    res.write('event: done\ndata: {}\n\n');
    res.end();
  } catch (error) {
    console.error('Chat request failed:', error);
    if (res.destroyed) return;
    if (res.headersSent) {
      res.write(`event: error\ndata: ${JSON.stringify({
        error: 'The response was interrupted. Please try again.'
      })}\n\n`);
      res.end();
    } else {
      const result = userFacingError(error);
      res.status(result.status).json({ error: result.message });
    }
  } finally {
    res.removeListener('close', abortIfDisconnected);
    activeSessions.delete(req.sessionID);
  }
});

app.post('/api/clear', requireSameOrigin, async (req, res, next) => {
  if (activeSessions.has(req.sessionID)) {
    return res.status(409).json({ error: 'Wait for the current response to finish before clearing the chat.' });
  }

  req.session.history = [];
  try {
    await saveSession(req);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.use((error, req, res, next) => {
  console.error('Request failed:', error);
  if (res.headersSent) return next(error);
  if (error.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Request body must contain valid JSON.' });
  }
  if (error.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body is too large.' });
  }
  res.status(500).json({ error: 'An unexpected server error occurred.' });
});

app.listen(port, () => {
  console.log(`Personal AI Assistant is running at http://localhost:${port}`);
});
