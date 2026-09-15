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

## Everything that's new

**Facilitation**
- **Story queue**: admin adds stories to a queue, then "Start next in queue" moves to the next one and automatically logs the finished round to history.
- **Round history**: every revealed round (story, votes, average/median/consensus, timestamp) is kept for the room's lifetime. Visible to everyone, with a CSV export button.
- **Voting timer**: admin starts a shared countdown (5\u2013600 seconds); everyone sees it live. It's advisory only \u2014 it doesn't force a reveal by itself.
- **Auto-reveal**: admin can toggle "reveal automatically once everyone connected has voted," instead of clicking Reveal every time.
- **Confetti**: fires once, client-side, when a round reveals to full consensus.

**Admin controls**
- **Lock room**: blocks new joiners (existing participants can still reconnect, and admins can always get in).
- **Kick**: admin can remove any participant; they're bounced back to the join screen with a message.
- **Reconnect on refresh**: each browser tab gets a stable identity (via `sessionStorage`, not `localStorage`) so refreshing a tab keeps your name and vote. Opening a *second* tab still counts as a different person \u2014 useful for testing multiple "participants" locally. Disconnected participants show greyed-out and are auto-removed after 10 idle minutes.
- **Custom decks**: Fibonacci (default), T-shirt sizes, or a custom comma-separated list, set live by the admin.

**Integrations (need your own credentials to activate)**
- **Reveal webhook**: set `REVEAL_WEBHOOK_URL` to any URL that accepts a `POST` with `{ "text": "..." }` \u2014 this works directly with Slack incoming webhooks. For Microsoft Teams, you may need to adjust the payload to your connector's expected shape.
- **GitHub issue import**: set `GITHUB_TOKEN` (a token with read access to the repo) and `GITHUB_REPO` (format `owner/repo`) to let the admin pull open issues straight into the queue with one click. Without these two set, the import button stays hidden.

None of the above needs a database \u2014 it's all still in server memory, so a restart clears rooms, history, and the queue. If you want that to survive restarts or run across multiple server instances, that's the point where swapping in Redis makes sense; ask if you want that built out.

**Not included yet (need more specifics from you first)**
- **Push estimates back into Jira/GitHub**: doable via the same reveal-webhook mechanism if you point it at a Zapier/Make/Jira-automation endpoint, but a *direct* Jira API integration needs your Jira site URL and auth details (Jira Cloud vs Server use different auth) \u2014 tell me which you use and I'll wire it up properly.
- **Redis-backed persistence**: straightforward to add once you've provisioned a Redis instance (e.g. Render's Redis add-on) and can share the connection string.

## Environment variables

| Variable | Required? | Purpose |
|---|---|---|
| `ADMIN_PIN` | Recommended | PIN that grants the admin role. Defaults to `admin123` with a startup warning if unset. |
| `PORT` | No | Set automatically by most hosts (including Render). Defaults to 3000 locally. |
| `REVEAL_WEBHOOK_URL` | No | POSTs a summary to this URL whenever votes are revealed (Slack-compatible). |
| `GITHUB_TOKEN` | No | Enables the "Import from GitHub" button. Needs `owner/repo` issues:read access. |
| `GITHUB_REPO` | No | Format `owner/repo`, e.g. `acme-corp/backend`. |

On Render: Service > Environment tab. Locally: prefix your command, e.g.
`ADMIN_PIN=teampin REVEAL_WEBHOOK_URL=https://hooks.slack.com/... npm start`.

## Two ways to get into a room

- **Create room**: enter your name only. The server generates a friendly room code (e.g. `brave-otter-57`), and you're automatically the admin \u2014 no PIN needed. Share the resulting code with your team.
- **Join room**: enter a room code someone shared with you, plus your name. You join as a regular participant. There's still an optional "Join as admin with a PIN" checkbox here, for cases like a co-facilitator joining an already-created room, or the original creator getting back in after fully closing their browser (see the reconnect note below \u2014 a PIN-based admin join is the fallback for that case).

## What happens when someone leaves

- **A refresh or brief disconnect (any role)**: the page now remembers which room and name you were using, and automatically reconnects on load \u2014 no retyping, and your vote/admin status come back exactly as they were. This works because the server gives everyone (not just the admin) a 5-second grace window before actually removing them, so a refresh's brief reconnect lands well within it.
- **Actually closing the tab, or clicking Leave room**: removed for real \u2014 there's no saved session to auto-resume (closing a tab clears the browser's `sessionStorage`), so getting back in means rejoining with the room code like anyone else.
- **Admin closes their tab or clicks Leave room**: same grace window applies, but once it expires (or immediately, on an explicit Leave click) the room ends for everyone if that was the last remaining admin.

One edge case worth knowing: if a refresh takes longer than 5 seconds to reconnect (very slow network), the old participant record will already be gone by the time it retries, and you'll rejoin as a brand-new participant in the same room \u2014 losing your vote and, if you were admin, your admin status. This should be rare in practice; let me know if you want the window longer.

There's intentionally no "transfer admin to someone else" step \u2014 if you
want the session to survive the original admin leaving for good (not just a
refresh), that's a different feature (electing a new admin from the
remaining participants) that I haven't built; say so if you want it.

## Anonymous results

Once revealed, regular participants see the **team's numbers** \u2014 average,
median, consensus, and the raw spread of values \u2014 but never which value
belongs to which person, in the participant grid or in the results panel.
Their own card still shows their own value; everyone else's stays face-down.

The **admin** sees the full named breakdown everywhere: the participant
grid, the results panel (as "Name: value" chips), and round history/CSV
export all show who voted what. This is enforced server-side: the name-to-
vote mapping is only ever sent to the admin or to a person for their own
vote \u2014 everyone else receives just the anonymous value distribution as a
separate field with no names attached.

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