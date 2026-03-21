/**
 * VoiceBridge — Room Relay API
 *
 * POST /api/room  — Send a message to a room
 *   Body: { room, id, source, translated, fromLang, toLang, sender }
 *
 * GET  /api/room?room=XXX&since=<timestamp>  — Poll for messages
 *
 * GET  /api/room?room=XXX&heartbeat=<senderId> — Register/refresh presence
 *
 * Messages are kept in-memory. Rooms auto-expire after 30 minutes of inactivity.
 */

// In-memory store: Map<roomCode, { messages: [], lastActivity: number, members: Map<id, lastSeen> }>
const rooms = new Map();

const MAX_MESSAGES = 200;        // per room
const ROOM_TTL     = 30 * 60e3;  // 30 min inactivity → room dies
const MEMBER_TTL   = 15e3;       // 15s without heartbeat → considered disconnected
const CLEANUP_INTERVAL = 60e3;   // run cleanup every 60s

// Periodic cleanup (runs within same function invocation context)
let lastCleanup = 0;
function cleanup() {
    const now = Date.now();
    if (now - lastCleanup < CLEANUP_INTERVAL) return;
    lastCleanup = now;
    for (const [code, room] of rooms) {
        if (now - room.lastActivity > ROOM_TTL) {
            rooms.delete(code);
        } else {
            // Prune dead members
            for (const [id, lastSeen] of room.members) {
                if (now - lastSeen > MEMBER_TTL * 2) {
                    room.members.delete(id);
                }
            }
        }
    }
}

function getRoom(code) {
    if (!rooms.has(code)) {
        rooms.set(code, {
            messages: [],
            lastActivity: Date.now(),
            members: new Map(),
        });
    }
    const room = rooms.get(code);
    room.lastActivity = Date.now();
    return room;
}

function corsHeaders() {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    };
}

export default function handler(req, res) {
    // CORS preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders());
        return res.end();
    }

    cleanup();

    const headers = { ...corsHeaders(), 'Content-Type': 'application/json' };

    // ---- POST: send a message ----
    if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const { room: roomCode, id, source, translated, fromLang, toLang, sender } = data;

                if (!roomCode || !source) {
                    res.writeHead(400, headers);
                    return res.end(JSON.stringify({ error: 'Missing room or source' }));
                }

                const room = getRoom(roomCode);
                const msg = {
                    id: id || `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                    source,
                    translated: translated || '',
                    fromLang: fromLang || '',
                    toLang: toLang || '',
                    sender: sender || 'unknown',
                    ts: Date.now(),
                };

                room.messages.push(msg);
                // Cap messages
                if (room.messages.length > MAX_MESSAGES) {
                    room.messages = room.messages.slice(-MAX_MESSAGES);
                }

                res.writeHead(200, headers);
                return res.end(JSON.stringify({ ok: true, id: msg.id }));
            } catch (err) {
                res.writeHead(400, headers);
                return res.end(JSON.stringify({ error: 'Invalid JSON' }));
            }
        });
        return;
    }

    // ---- GET: poll for messages or heartbeat ----
    if (req.method === 'GET') {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const roomCode  = url.searchParams.get('room');
        const since     = parseInt(url.searchParams.get('since') || '0', 10);
        const heartbeat = url.searchParams.get('heartbeat');

        if (!roomCode) {
            res.writeHead(400, headers);
            return res.end(JSON.stringify({ error: 'Missing room param' }));
        }

        const room = getRoom(roomCode);

        // Register heartbeat
        if (heartbeat) {
            room.members.set(heartbeat, Date.now());
        }

        // Count active members (seen within MEMBER_TTL)
        const now = Date.now();
        let activeCount = 0;
        for (const [, lastSeen] of room.members) {
            if (now - lastSeen < MEMBER_TTL) activeCount++;
        }

        // Get messages since timestamp
        const newMessages = room.messages.filter(m => m.ts > since);

        res.writeHead(200, headers);
        return res.end(JSON.stringify({
            room: roomCode,
            members: activeCount,
            messages: newMessages,
            ts: now,
        }));
    }

    // Unknown method
    res.writeHead(405, headers);
    res.end(JSON.stringify({ error: 'Method not allowed' }));
}
