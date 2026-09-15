const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// --- Config -----------------------------------------------------------

// Shared PIN that grants the admin role. Set this via an environment
// variable in production (e.g. on Render: Settings > Environment) rather
// than relying on the fallback below.
const ADMIN_PIN = process.env.ADMIN_PIN || 'admin123';
if (!process.env.ADMIN_PIN) {
  console.warn(
    `[warning] ADMIN_PIN env var not set. Using default admin PIN "${ADMIN_PIN}". ` +
    `Set ADMIN_PIN in your environment before sharing this with your team.`
  );
}

// Optional: POST a simple { text } payload to this URL whenever votes are
// revealed. Works directly with Slack incoming webhooks; for Teams you may
// need to adapt the payload shape to your connector's expected format.
const REVEAL_WEBHOOK_URL = process.env.REVEAL_WEBHOOK_URL || null;

// Optional: import open issues from a GitHub repo into the story queue.
// Needs a token with at least read access to the repo's issues.
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || null;
const GITHUB_REPO = process.env.GITHUB_REPO || null; // format: "owner/repo"

const DEFAULT_DECK = ['1', '2', '3', '5', '8', '13', '21', '?', '\u2615'];
const STALE_DISCONNECT_MS = 10 * 60 * 1000; // safety-net sweep, shouldn't normally be needed
const RECONNECT_GRACE_MS = 5 * 1000; // tolerate a brief disconnect (refresh, wifi blip) before removing anyone

// Ambiguous characters (I, O, 0, 1) are excluded so codes are easy to read
// aloud and type back in without mixing up letters and digits.
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

function generateRoomCode() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return code;
}

// --- Room store ---------------------------------------------------------
//
// rooms[code] = {
//   story: string,
//   phase: 'voting' | 'revealed',
//   deck: string[],
//   locked: boolean,
//   autoReveal: boolean,
//   timerEndAt: number|null,
//   queue: string[],
//   history: [{ story, revealedAt, votes: [{name, vote}], avg, median, mode }],
//   participants: {
//     [participantId]: {
//       name, vote, isAdmin, joinedAt,
//       connected, disconnectedAt, socketId
//     }
//   }
// }
const rooms = {};

function generateId() {
  return 'p-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function getOrCreateRoom(code) {
  if (!rooms[code]) {
    rooms[code] = {
      story: '',
      phase: 'voting',
      deck: DEFAULT_DECK.slice(),
      locked: false,
      autoReveal: false,
      timerEndAt: null,
      queue: [],
      history: [],
      participants: {},
    };
  }
  return rooms[code];
}

function cleanupIfEmpty(code) {
  const room = rooms[code];
  if (room && Object.keys(room.participants).length === 0) {
    delete rooms[code];
  }
}

function adminCount(room) {
  return Object.values(room.participants).filter((p) => p.isAdmin).length;
}

// Kicks every currently-connected participant out with a reason, then
// deletes the room entirely. Used when the admin leaves or disconnects \u2014
// without a facilitator, the session is over for everyone.
function endRoom(code, reason) {
  const room = rooms[code];
  if (!room) return;
  Object.values(room.participants).forEach((p) => {
    if (p.socketId) {
      const s = io.sockets.sockets.get(p.socketId);
      if (s) {
        s.emit('room-ended', reason);
        s.leave(code);
      }
    }
  });
  delete rooms[code];
}

function computeRoundSummary(room) {
  const numeric = Object.values(room.participants)
    .filter((p) => p.vote !== null && !isNaN(parseInt(p.vote, 10)))
    .map((p) => parseInt(p.vote, 10));
  if (numeric.length === 0) return { avg: null, median: null, mode: null };
  const vals = numeric.slice().sort((a, b) => a - b);
  const avg = +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1);
  const median = vals.length % 2 === 0
    ? (vals[vals.length / 2 - 1] + vals[vals.length / 2]) / 2
    : vals[Math.floor(vals.length / 2)];
  const freq = {};
  vals.forEach((v) => (freq[v] = (freq[v] || 0) + 1));
  const mode = Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0];
  return { avg, median, mode };
}

// Strips the name off each vote, keeping only the value \u2014 used so
// non-admin viewers get the distribution of votes without learning who
// cast which one.
function anonymizeVotes(votes) {
  return votes.map((v) => ({ vote: v.vote }));
}

function notifyRevealWebhook(room) {
  if (!REVEAL_WEBHOOK_URL) return;
  const summary = computeRoundSummary(room);
  const lines = Object.values(room.participants)
    .map((p) => `${p.name}: ${p.vote !== null ? p.vote : '\u2014'}`)
    .join(', ');
  const text =
    `Planning poker reveal \u2014 "${room.story || 'Untitled story'}"\n` +
    `Votes: ${lines}\n` +
    `Average: ${summary.avg ?? 'n/a'} \u00b7 Median: ${summary.median ?? 'n/a'} \u00b7 Consensus: ${summary.mode ?? 'n/a'}`;
  fetch(REVEAL_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  }).catch((err) => console.warn('[reveal webhook] failed:', err.message));
}

// Logs the just-finished round to history (if it had been revealed) and
// advances to the next story (or keeps the current one, for a re-vote).
function finishRoundAndAdvance(room, nextStory) {
  if (room.phase === 'revealed' && room.story) {
    const summary = computeRoundSummary(room);
    room.history.unshift({
      story: room.story,
      revealedAt: Date.now(),
      votes: Object.values(room.participants).map((p) => ({ name: p.name, vote: p.vote })),
      avg: summary.avg,
      median: summary.median,
      mode: summary.mode,
    });
    if (room.history.length > 100) room.history.length = 100;
  }
  room.story = nextStory || '';
  room.phase = 'voting';
  room.timerEndAt = null;
  Object.values(room.participants).forEach((p) => (p.vote = null));
}

function maybeAutoReveal(room) {
  if (!room.autoReveal || room.phase === 'revealed') return;
  const connected = Object.values(room.participants).filter((p) => p.connected);
  if (connected.length === 0) return;
  const allVoted = connected.every((p) => p.vote !== null);
  if (allVoted) {
    room.phase = 'revealed';
    notifyRevealWebhook(room);
  }
}

// --- Per-viewer payload (this is what enforces vote-masking) -----------

function buildPayloadFor(room, roomCode, viewerId) {
  const viewer = room.participants[viewerId];
  const viewerIsAdmin = !!(viewer && viewer.isAdmin);
  const revealed = room.phase === 'revealed';

  const participants = {};
  Object.entries(room.participants).forEach(([id, p]) => {
    // Only the admin (and you, for your own vote) ever see a name tied to
    // a value here \u2014 that stays true even after reveal now, so results
    // are anonymous for everyone except the admin. The team-wide numbers
    // (average/median/consensus) are sent separately via `results` below,
    // with no names attached at all.
    const canSeeValue = viewerIsAdmin || id === viewerId;
    participants[id] = {
      name: p.name,
      isAdmin: !!p.isAdmin,
      joinedAt: p.joinedAt,
      connected: !!p.connected,
      hasVoted: p.vote !== null,
      vote: canSeeValue ? p.vote : null,
    };
  });

  let results = null;
  if (revealed) {
    const summary = computeRoundSummary(room);
    if (viewerIsAdmin) {
      const named = Object.values(room.participants)
        .filter((p) => p.vote !== null)
        .map((p) => ({ name: p.name, vote: p.vote }));
      results = {
        avg: summary.avg,
        median: summary.median,
        mode: summary.mode,
        values: named.map((v) => v.vote),
        named, // admin only: lets the UI show whose vote was which
      };
    } else {
      const values = Object.values(room.participants)
        .filter((p) => p.vote !== null)
        .map((p) => p.vote);
      results = { avg: summary.avg, median: summary.median, mode: summary.mode, values };
    }
  }

  const history = viewerIsAdmin
    ? room.history
    : room.history.map((h) => ({
        story: h.story,
        revealedAt: h.revealedAt,
        avg: h.avg,
        median: h.median,
        mode: h.mode,
        votes: anonymizeVotes(h.votes),
      }));

  return {
    roomCode,
    you: viewerId,
    story: room.story,
    phase: room.phase,
    amAdmin: viewerIsAdmin,
    deck: room.deck,
    locked: !!room.locked,
    autoReveal: !!room.autoReveal,
    timerEndAt: room.timerEndAt || null,
    queue: room.queue,
    results,
    history,
    integrations: {
      githubImportAvailable: !!(GITHUB_TOKEN && GITHUB_REPO),
    },
    participants,
  };
}

function broadcastRoom(code) {
  const room = rooms[code];
  if (!room) return;
  Object.entries(room.participants).forEach(([pid, p]) => {
    if (!p.connected || !p.socketId) return;
    const sock = io.sockets.sockets.get(p.socketId);
    if (sock) sock.emit('room-update', buildPayloadFor(room, code, pid));
  });
}

// --- Socket handlers ------------------------------------------------------

io.on('connection', (socket) => {
  let currentRoom = null;
  let myParticipantId = null;

  function requireAdmin(room) {
    const me = room.participants[myParticipantId];
    if (!me || !me.isAdmin) {
      socket.emit('action-error', 'Only the admin can do that.');
      return null;
    }
    return me;
  }

  socket.on('create-room', ({ name }) => {
    const cleanName = String(name || '').trim().slice(0, 20);
    if (!cleanName) return;

    let code;
    do {
      code = generateRoomCode();
    } while (rooms[code]);

    const room = getOrCreateRoom(code);
    const pid = generateId();

    currentRoom = code;
    myParticipantId = pid;
    socket.join(code);

    room.participants[pid] = {
      name: cleanName,
      vote: null,
      isAdmin: true,
      joinedAt: Date.now(),
      connected: true,
      disconnectedAt: null,
      socketId: socket.id,
    };

    socket.emit('room-created', { roomCode: code, participantId: pid });
    broadcastRoom(code);
  });

  socket.on('join', ({ roomCode, name, adminPin, participantId }) => {
    if (!roomCode || !name) return;
    const code = String(roomCode).trim().toUpperCase();
    const cleanName = String(name).trim().slice(0, 20);
    if (!code || !cleanName) return;

    const wantsAdmin = typeof adminPin === 'string' && adminPin.length > 0;
    if (wantsAdmin && adminPin !== ADMIN_PIN) {
      socket.emit('join-error', 'Incorrect admin PIN.');
      return;
    }

    const room = getOrCreateRoom(code);
    const pid = (typeof participantId === 'string' && participantId) ? participantId : generateId();
    const existing = room.participants[pid];

    if (!existing && room.locked && !wantsAdmin) {
      socket.emit('join-error', 'This room is locked by the admin.');
      return;
    }

    currentRoom = code;
    myParticipantId = pid;
    socket.join(code);

    room.participants[pid] = {
      name: cleanName,
      vote: existing ? existing.vote : null,
      isAdmin: wantsAdmin || !!(existing && existing.isAdmin),
      joinedAt: existing ? existing.joinedAt : Date.now(),
      connected: true,
      disconnectedAt: null,
      socketId: socket.id,
    };

    socket.emit('session', { participantId: pid });
    broadcastRoom(code);
  });

  socket.on('set-story', (story) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    if (!requireAdmin(room)) return;
    room.story = String(story || '').slice(0, 200);
    broadcastRoom(currentRoom);
  });

  socket.on('vote', (card) => {
    if (!currentRoom || !rooms[currentRoom] || !myParticipantId) return;
    const room = rooms[currentRoom];
    if (room.phase === 'revealed') return;
    const me = room.participants[myParticipantId];
    if (!me) return;
    me.vote = String(card).slice(0, 10);
    maybeAutoReveal(room);
    broadcastRoom(currentRoom);
  });

  socket.on('reveal', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    if (!requireAdmin(room)) return;
    const anyVotes = Object.values(room.participants).some((p) => p.vote !== null);
    if (!anyVotes) return;
    room.phase = 'revealed';
    notifyRevealWebhook(room);
    broadcastRoom(currentRoom);
  });

  socket.on('new-round', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    if (!requireAdmin(room)) return;
    finishRoundAndAdvance(room, room.story);
    broadcastRoom(currentRoom);
  });

  socket.on('set-locked', (locked) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    if (!requireAdmin(room)) return;
    room.locked = !!locked;
    broadcastRoom(currentRoom);
  });

  socket.on('set-auto-reveal', (enabled) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    if (!requireAdmin(room)) return;
    room.autoReveal = !!enabled;
    broadcastRoom(currentRoom);
  });

  socket.on('set-deck', (deck) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    if (!requireAdmin(room)) return;
    if (!Array.isArray(deck) || deck.length === 0 || deck.length > 15) return;
    room.deck = deck.map((c) => String(c).slice(0, 8)).slice(0, 15);
    room.phase = 'voting';
    room.timerEndAt = null;
    Object.values(room.participants).forEach((p) => (p.vote = null));
    broadcastRoom(currentRoom);
  });

  socket.on('start-timer', (seconds) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    if (!requireAdmin(room)) return;
    const secs = Math.max(5, Math.min(600, parseInt(seconds, 10) || 60));
    room.timerEndAt = Date.now() + secs * 1000;
    broadcastRoom(currentRoom);
  });

  socket.on('stop-timer', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    if (!requireAdmin(room)) return;
    room.timerEndAt = null;
    broadcastRoom(currentRoom);
  });

  socket.on('add-to-queue', (title) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    if (!requireAdmin(room)) return;
    const clean = String(title || '').trim().slice(0, 200);
    if (!clean) return;
    room.queue.push(clean);
    broadcastRoom(currentRoom);
  });

  socket.on('remove-from-queue', (index) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    if (!requireAdmin(room)) return;
    if (Number.isInteger(index) && index >= 0 && index < room.queue.length) {
      room.queue.splice(index, 1);
      broadcastRoom(currentRoom);
    }
  });

  socket.on('start-next-story', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    if (!requireAdmin(room)) return;
    if (!room.queue.length) {
      socket.emit('action-error', 'The queue is empty.');
      return;
    }
    const next = room.queue.shift();
    finishRoundAndAdvance(room, next);
    broadcastRoom(currentRoom);
  });

  socket.on('import-github-issues', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    if (!requireAdmin(room)) return;
    if (!GITHUB_TOKEN || !GITHUB_REPO) {
      socket.emit('action-error', 'GitHub import needs GITHUB_TOKEN and GITHUB_REPO set on the server.');
      return;
    }
    fetch(`https://api.github.com/repos/${GITHUB_REPO}/issues?state=open&per_page=20`, {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        'User-Agent': 'planning-poker-app',
        Accept: 'application/vnd.github+json',
      },
    })
      .then((r) => {
        if (!r.ok) throw new Error(`GitHub API returned ${r.status}`);
        return r.json();
      })
      .then((issues) => {
        if (!Array.isArray(issues)) throw new Error('Unexpected response shape');
        let added = 0;
        issues.filter((i) => !i.pull_request).forEach((i) => {
          room.queue.push(`#${i.number} ${i.title}`);
          added++;
        });
        broadcastRoom(currentRoom);
        socket.emit('action-error', `Imported ${added} issue(s) into the queue.`);
      })
      .catch((err) => {
        console.warn('[github import] failed:', err.message);
        socket.emit('action-error', 'Could not import GitHub issues \u2014 check server logs.');
      });
  });

  socket.on('kick', (targetId) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    if (!requireAdmin(room)) return;
    if (targetId === myParticipantId) return; // use "leave" or "step down" instead
    const target = room.participants[targetId];
    if (!target) return;
    delete room.participants[targetId];
    if (target.socketId) {
      const targetSocket = io.sockets.sockets.get(target.socketId);
      if (targetSocket) {
        targetSocket.emit('kicked');
        targetSocket.leave(currentRoom);
      }
    }
    broadcastRoom(currentRoom);
    cleanupIfEmpty(currentRoom);
  });

  socket.on('leave', () => {
    if (currentRoom && rooms[currentRoom] && myParticipantId) {
      const room = rooms[currentRoom];
      delete room.participants[myParticipantId];
      socket.leave(currentRoom);
      if (adminCount(room) === 0) {
        endRoom(currentRoom, 'The admin left \u2014 this room is now closed.');
      } else {
        broadcastRoom(currentRoom);
        cleanupIfEmpty(currentRoom);
      }
    }
    currentRoom = null;
    myParticipantId = null;
  });

  socket.on('disconnect', () => {
    if (!currentRoom || !rooms[currentRoom] || !myParticipantId) return;
    const room = rooms[currentRoom];
    const p = room.participants[myParticipantId];
    if (!p || p.socketId !== socket.id) return;

    // Everyone gets a short window to reconnect (e.g. a page refresh or a
    // brief wifi drop) before being removed. This is what lets a refresh
    // resume the same room with the same vote intact, for admins and
    // regular participants alike. A genuine tab close never reconnects, so
    // it just plays out as a removal once the window elapses \u2014 same end
    // result as before, just not instant.
    p.connected = false;
    p.disconnectedAt = Date.now();
    p.socketId = null;
    broadcastRoom(currentRoom);

    const code = currentRoom;
    const pid = myParticipantId;
    setTimeout(() => {
      const r = rooms[code];
      if (!r) return;
      const entry = r.participants[pid];
      if (entry && !entry.connected) {
        const wasAdmin = entry.isAdmin;
        delete r.participants[pid];
        if (wasAdmin && adminCount(r) === 0) {
          endRoom(code, 'The admin left \u2014 this room is now closed.');
        } else {
          broadcastRoom(code);
          cleanupIfEmpty(code);
        }
      }
    }, RECONNECT_GRACE_MS);
  });
});

// Periodically remove participants who disconnected long ago and never came
// back, so ghost entries don't accumulate forever.
setInterval(() => {
  Object.keys(rooms).forEach((code) => {
    const room = rooms[code];
    let changed = false;
    Object.entries(room.participants).forEach(([pid, p]) => {
      if (!p.connected && p.disconnectedAt && Date.now() - p.disconnectedAt > STALE_DISCONNECT_MS) {
        delete room.participants[pid];
        changed = true;
      }
    });
    if (changed) broadcastRoom(code);
    cleanupIfEmpty(code);
  });
}, 60 * 1000);

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Planning poker server listening on port ${PORT}`);
});