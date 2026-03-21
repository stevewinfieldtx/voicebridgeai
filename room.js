/* =========================================
   VoiceBridge — Room Client
   Polling-based room sync via /api/room
   ========================================= */
(function () {
    'use strict';

    const API = '/api/room';
    const POLL_MS = 1800;       // poll every 1.8 s
    const HEARTBEAT_MS = 25000; // heartbeat every 25 s

    // ---- State ----
    let roomCode    = null;
    let memberId    = null;
    let lastSeq     = 0;
    let pollTimer   = null;
    let heartTimer  = null;

    // ---- DOM ----
    const roomBtn       = document.getElementById('room-btn');
    const roomOverlay   = document.getElementById('room-overlay');
    const roomClose     = document.getElementById('room-close');
    const roomCreateBtn = document.getElementById('room-create-btn');
    const roomJoinBtn   = document.getElementById('room-join-btn');
    const roomJoinInput = document.getElementById('room-join-input');
    const roomNote      = document.getElementById('room-note');
    const roomBar       = document.getElementById('room-bar');
    const roomBarCode   = document.getElementById('room-bar-code');
    const roomBarMembers = document.getElementById('room-bar-members');
    const roomBarLeave  = document.getElementById('room-bar-leave');

    // ---- Helpers ----
    function note(text, type) {
        roomNote.textContent = text;
        roomNote.className = 'room-note' + (type ? ' ' + type : '');
    }

    function openModal()  { roomOverlay.classList.add('open'); note(''); }
    function closeModal() { roomOverlay.classList.remove('open'); }

    async function api(action, body = {}) {
        const res = await fetch(API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action, ...body }),
        });
        return res.json();
    }

    // ---- Create ----
    async function createRoom() {
        roomCreateBtn.disabled = true;
        note('Creating room…');
        try {
            const data = await api('create');
            if (data.error) throw new Error(data.error);
            roomCode = data.roomCode;
            memberId = data.memberId;
            lastSeq  = 0;
            enterRoom();
            note('Room created — share code ' + roomCode, 'success');
            setTimeout(closeModal, 800);
        } catch (e) {
            note(e.message, 'error');
        } finally {
            roomCreateBtn.disabled = false;
        }
    }

    // ---- Join ----
    async function joinRoom() {
        const code = roomJoinInput.value.trim().toUpperCase();
        if (code.length < 4) { note('Enter a valid room code', 'error'); return; }
        roomJoinBtn.disabled = true;
        note('Joining…');
        try {
            const data = await api('join', { roomCode: code });
            if (data.error) throw new Error(data.error);
            roomCode = data.roomCode;
            memberId = data.memberId;
            lastSeq  = 0;
            enterRoom();
            note('Joined room ' + roomCode, 'success');
            setTimeout(closeModal, 600);
        } catch (e) {
            note(e.message, 'error');
        } finally {
            roomJoinBtn.disabled = false;
        }
    }

    // ---- Leave ----
    async function leaveRoom() {
        try { await api('leave', { roomCode, memberId }); } catch (e) { /* ok */ }
        exitRoom();
    }

    // ---- Enter / Exit helpers ----
    function enterRoom() {
        roomBarCode.textContent = roomCode;
        roomBar.style.display = '';
        roomBtn.classList.add('in-room');

        // Hook: intercept local translations to broadcast them to the room
        window._vb.onLocalMessage = broadcastLocal;

        startPolling();
        startHeartbeat();
    }

    function exitRoom() {
        roomCode = null;
        memberId = null;
        lastSeq  = 0;
        roomBar.style.display = 'none';
        roomBtn.classList.remove('in-room');
        window._vb.onLocalMessage = null;
        stopPolling();
        stopHeartbeat();
    }

    // ---- Broadcast local message ----
    function broadcastLocal(sourceText, translatedText, fromCode, toCode) {
        if (!roomCode || !memberId) return;
        api('send', {
            roomCode,
            memberId,
            sourceText,
            translatedText,
            fromLang: fromCode,
            toLang: toCode,
        }).catch(err => console.warn('[room] send error', err));
    }

    // ---- Polling ----
    function startPolling() {
        stopPolling();
        poll(); // immediate first poll
        pollTimer = setInterval(poll, POLL_MS);
    }

    function stopPolling() {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    }

    async function poll() {
        if (!roomCode || !memberId) return;
        try {
            const data = await api('poll', { roomCode, memberId, since: lastSeq });
            if (data.error) { console.warn('[room] poll:', data.error); exitRoom(); return; }

            // Update member count
            if (data.members != null) {
                roomBarMembers.textContent = data.members + ' online';
            }

            // Render new remote messages
            if (data.messages && data.messages.length) {
                for (const msg of data.messages) {
                    if (msg.seq > lastSeq) lastSeq = msg.seq;
                    if (msg.memberId === memberId) continue; // skip own messages

                    const fromLang = window._vb.getLang(msg.fromLang);
                    const toLang   = window._vb.getLang(msg.toLang);
                    window._vb.addMessage(
                        msg.sourceText,
                        msg.translatedText,
                        fromLang,
                        toLang,
                        { remote: true }
                    );
                }
            }
        } catch (e) {
            console.warn('[room] poll network error', e);
        }
    }

    // ---- Heartbeat ----
    function startHeartbeat() {
        stopHeartbeat();
        heartTimer = setInterval(() => {
            if (!roomCode || !memberId) return;
            api('heartbeat', { roomCode, memberId }).catch(() => {});
        }, HEARTBEAT_MS);
    }

    function stopHeartbeat() {
        if (heartTimer) { clearInterval(heartTimer); heartTimer = null; }
    }

    // ---- Event listeners ----
    roomBtn.addEventListener('click', () => {
        if (roomCode) {
            // Already in a room — show room bar (scroll to top)
            window.scrollTo({ top: 0, behavior: 'smooth' });
        } else {
            openModal();
        }
    });
    roomClose.addEventListener('click', closeModal);
    roomOverlay.addEventListener('click', (e) => { if (e.target === roomOverlay) closeModal(); });
    roomCreateBtn.addEventListener('click', createRoom);
    roomJoinBtn.addEventListener('click', joinRoom);
    roomJoinInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(); });
    roomBarLeave.addEventListener('click', leaveRoom);

    // Escape key = close room modal
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && roomOverlay.classList.contains('open')) {
            closeModal();
        }
    });

    // Leave room on page unload
    window.addEventListener('beforeunload', () => {
        if (roomCode && memberId) {
            navigator.sendBeacon(API, JSON.stringify({ action: 'leave', roomCode, memberId }));
        }
    });
})();
