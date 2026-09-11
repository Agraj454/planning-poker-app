# Planning poker

Real-time planning poker for agile teams. Node.js + Express + Socket.io backend,
plain HTML/CSS/JS frontend. Room state lives in server memory — no database
required, and rooms disappear automatically once everyone leaves.

## Run it locally

```bash
npm install
npm start
```

Then open http://localhost:3000 in your browser. Open it again in a second
tab (or have a teammate on the same network open http://YOUR-LOCAL-IP:3000)
and join the same room code to see votes sync live.

To find your local IP for teammates on the same wifi:
- macOS: `ipconfig getifaddr en0`
- Windows: `ipconfig` (look for IPv4 address)
- Linux: `hostname -I`

During development, `npm run dev` restarts the server automatically on file
changes (requires the `nodemon` dev dependency, already listed in
`package.json`).

## How it works

- Each browser tab opens a Socket.io connection to the server.
- Joining a room adds you to an in-memory `rooms[roomCode]` object and joins
  a Socket.io room of the same name.
- Every action (set story, vote, reveal, new round) updates that in-memory
  object on the server and broadcasts the full room state to everyone
  connected to that room — that's what makes it instant instead of polling.
- Closing the tab (or losing connection) removes you from the room. When a
  room has no participants left, it's deleted.

This is intentionally simple: state is not persisted to disk, so restarting
the server clears all rooms. For a small team's daily standup use, that's
usually fine. If you outgrow it (need history, multiple server instances,
etc.), swap the in-memory `rooms` object for Redis — everything else stays
the same.

## Deploying so your whole team can use it

Any host that supports long-running Node processes and WebSockets works.
Serverless platforms that spin functions up/down per request (e.g. plain
Vercel/Netlify functions) are a poor fit for Socket.io — pick a host that
keeps a persistent process running instead:

- **Render** (render.com) — free tier, connect your git repo, it detects
  `npm start` automatically. Easiest option if you don't already have infra.
- **Railway** (railway.app) — similar to Render, generous free tier.
- **Fly.io** — a bit more setup (a `fly.toml` and Dockerfile-less deploy),
  good if you want more control over region/scaling.
- **Your own VPS** — run `npm install && npm start` behind a reverse proxy
  (nginx/Caddy) with a process manager like `pm2` so it restarts on crash.

Whichever you pick, once deployed you'll get a public URL (e.g.
`https://your-app.onrender.com`) — that's the link you share with your team
instead of localhost.

## Admin view

There are two roles:

- **Regular participants** vote normally. While voting is open, they see
  everyone else's card as a face-down "?" and only know their own vote —
  same as before. Once someone reveals, everyone sees everyone's vote and
  the average/median, same as before.
- **Admins** see every participant's actual vote live, by name, while
  voting is still open — before anyone reveals. This is enforced on the
  server: non-admin clients are never sent the real vote values for other
  people until reveal, so it's not just hidden in the UI.

To join as admin, check "Join as admin" on the join screen and enter the
admin PIN. The PIN is set via the `ADMIN_PIN` environment variable:

- **Locally**: `ADMIN_PIN=your-pin npm start` (or add it to a `.env` file
  if you introduce a loader like `dotenv`).
- **On Render**: go to your service > Environment, add a variable named
  `ADMIN_PIN` with your chosen value, and save (this triggers a redeploy).

If `ADMIN_PIN` isn't set, the server falls back to `admin123` and logs a
warning on startup — fine for local testing, but set a real one before
sharing the deployed link with your team.

Anyone who knows the PIN can join as admin — there's no per-person admin
list. If you want tighter control (e.g. only specific people, or an
audit trail of who has admin access), that's a bigger change involving
real user accounts rather than a shared PIN; let me know if you want that
instead.

## Customizing

- **Card deck**: edit the `DECK` array in `public/index.html` (currently
  Fibonacci-ish: 1, 2, 3, 5, 8, 13, 21, ?, coffee break).
- **Colors/theme**: CSS variables at the top of the `<style>` block in
  `public/index.html`.
- **Room code format**: currently free text, lowercased. Add validation in
  the `join` handler in `server.js` if you want to enforce a format.