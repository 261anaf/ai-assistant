# Personal AI Assistant

A responsive personal chat app powered by Google Gemini. The API key stays on
the server. Conversations are stored with an HTTP-only session cookie and a
persistent file-backed session store.

## Requirements

- Node.js 20 or newer
- A Gemini API key from [Google AI Studio](https://aistudio.google.com/app/apikey)

## Run locally

1. Install dependencies:

   ```sh
   npm install
   ```

2. Copy `.env.example` to `.env` and set `GEMINI_API_KEY`. Set
   `SESSION_SECRET` to a random secret of at least 32 characters. For example,
   generate one with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`.

3. Start the app:

   ```sh
   npm start
   ```

4. Visit [http://localhost:3000](http://localhost:3000).

For development with automatic server restarts, use `npm run dev`.

## Configuration

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `GEMINI_API_KEY` | Yes | (none) | Google Gemini API key; never expose it in frontend code. |
| `SESSION_SECRET` | Yes | (none) | Secret used to sign session cookies; use a unique random value of at least 32 characters. |
| `PORT` | No | `3000` | HTTP port. |
| `NODE_ENV` | No | `development` | Set to `production` behind HTTPS to enable secure cookies and proxy support. |
| `GEMINI_MODEL` | No | `gemini-2.5-flash` | Gemini model identifier. |

## Notes for deployment

- Serve the app behind HTTPS and set `NODE_ENV=production`.
- Keep `.env` private and use a distinct, strong `SESSION_SECRET` for each deployment.
- Session files are created under `data/sessions/`; persist that directory
  across deployments and restrict access to it.
- The included request limiter and file-backed session store are suitable for a
  single server instance. For a multi-instance deployment, use a shared session
  store and a shared rate-limit store.
- Chat history is limited to the most recent 40 messages to keep requests bounded.
- The browser streams generated text. A response is added to durable history only
  after Gemini finishes successfully.
