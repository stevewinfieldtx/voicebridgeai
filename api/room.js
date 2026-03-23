/**
 * TalkBridge — Room Relay API
 *
 * All requests are POST with JSON body containing an `action` field:
 *
 *   action: "create"                          → { roomCode, memberId }
 *   action: "join",    roomCode               → { roomCode, memberId }
 *   action: "send",    roomCode, memberId, sourceText, translatedText, fromLang, toLang
 *   action: "poll",    roomCode, memberId, since  → { members, messages }
 *   action: "leave",   roomCode, memberId
 *   action: "heartbeat", roomCode, memberId   → { ok, members }
 *
 * Messages are kept in-memory. Rooms auto-expire after 30 min of inactivity.
 */

// In-memory store
const rooms = new Map();

const MAX_MESSAGES     = 200;
const ROOM_TTL         = 30 * 60e3;   // 30 min
const MEMBER_TTL       = 30e3;        // 30s without heartbeat → disconnected
const CLEANUP_INTERVAL = 60e3;

let lastCleanup = 0;

function cleanup() {
    const now = Date.now();
    if (now - lastCleanup < CLEANUP_INTERVAL) return;
    lastCleanup = now;
    for (const [code, room] of rooms) {
        if (now - room.lastActivity > ROOM_TTL) {
            rooms.delete(code);
        } else {
            for (const [id, member] of room.members) {
                if (now - member.lastSeen > MEMBER_TTL * 2) {
                    room.members.delete(id);
                }
            }
        }
    }
}

function generateCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1 for clarity
    let code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
}

function generateId() {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function getRoom(code) {
    if (!rooms.has(code)) return null;
    const room = rooms.get(code);
    room.lastActivity = Date.now();
    return room;
}

function createRoom() {
    let code;
    do { code = generateCode(); } while (rooms.has(code));
    rooms.set(code, {
        messages: [],
        lastActivity: Date.now(),
        members: new Map(),
        seq: 0,
    });
    return code;
}

function activeMembers(room) {
    const now = Date.now();
    let count = 0;
    for (const [, m] of room.members) {
        if (now - m.lastSeen < MEMBER_TTL) count++;
    }
    return count;
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
    const ok  = (data) => { res.writeHead(200, headers); res.end(JSON.stringify(data)); };
    const err = (code, msg) => { res.writeHead(code, headers); res.end(JSON.stringify({ error: msg })); };

    if (req.method !== 'POST') {
        return err(405, 'Method not allowed');
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
        let data;
        try { data = JSON.parse(body); } catch { return err(400, 'Invalid JSON'); }

        const { action } = data;

        // ── CREATE ──
        if (action === 'create') {
            const roomCode = createRoom();
            const memberId = generateId();
            const room = rooms.get(roomCode);
            room.members.set(memberId, { lastSeen: Date.now() });
            return ok({ roomCode, memberId });
        }

        // ── JOIN ──
        if (action === 'join') {
            const { roomCode } = data;
            if (!roomCode) return err(400, 'Missing roomCode');
            // Auto-create if room doesn't exist (graceful)
            if (!rooms.has(roomCode)) {
                rooms.set(roomCode, {
                    messages: [],
                    lastActivity: Date.now(),
                    members: new Map(),
                    seq: 0,
                });
            }
            const room = getRoom(roomCode);
            const memberId = generateId();
            room.members.set(memberId, { lastSeen: Date.now() });
            return ok({ roomCode, memberId, members: activeMembers(room) });
        }

        // ── SEND ──
        if (action === 'send') {
            const { roomCode, memberId, sourceText, translatedText, fromLang, toLang } = data;
            if (!roomCode || !memberId) return err(400, 'Missing roomCode or memberId');
            const room = getRoom(roomCode);
            if (!room) return err(404, 'Room not found');

            room.seq++;
            const msg = {
                seq: room.seq,
                memberId,
                sourceText: sourceText || '',
                translatedText: translatedText || '',
                fromLang: fromLang || '',
                toLang: toLang || '',
                ts: Date.now(),
            };
            room.messages.push(msg);
            if (room.messages.length > MAX_MESSAGES) {
                room.messages = room.messages.slice(-MAX_MESSAGES);
            }

            // Refresh sender heartbeat
            if (room.members.has(memberId)) {
                room.members.get(memberId).lastSeen = Date.now();
            }

            return ok({ ok: true, seq: msg.seq });
        }

        // ── POLL ──
        if (action === 'poll') {
            const { roomCode, memberId, since } = data;
            if (!roomCode || !memberId) return err(400, 'Missing roomCode or memberId');
            const room = getRoom(roomCode);
            if (!room) return err(404, 'Room not found');

            // Refresh heartbeat on poll
            if (room.members.has(memberId)) {
                room.members.get(memberId).lastSeen = Date.now();
            }

            const sinceSeq = parseInt(since) || 0;
            const newMessages = room.messages.filter(m => m.seq > sinceSeq);

            return ok({
                members: activeMembers(room),
                messages: newMessages,
            });
        }

        // ── LEAVE ──
        if (action === 'leave') {
            const { roomCode, memberId } = data;
            if (roomCode && memberId) {
                const room = getRoom(roomCode);
                if (room) room.members.delete(memberId);
            }
            return ok({ ok: true });
        }

        // ── HEARTBEAT ──
        if (action === 'heartbeat') {
            const { roomCode, memberId } = data;
            if (!roomCode || !memberId) return err(400, 'Missing roomCode or memberId');
            const room = getRoom(roomCode);
            if (!room) return err(404, 'Room not found');

            if (room.members.has(memberId)) {
                room.members.get(memberId).lastSeen = Date.now();
            }

            return ok({ ok: true, members: activeMembers(room) });
        }

        return err(400, 'Unknown action: ' + action);
    });
}
