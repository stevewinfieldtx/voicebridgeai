/* =========================================
   TalkBridge — Bridge Mode
   Two phones, two one-directional sessions,
   one shared room. OpenAI Realtime API.
   ========================================= */

(function () {
    'use strict';

    const LANGS = [
        { code: 'en', name: 'English',         flag: '\u{1F1FA}\u{1F1F8}' },
        { code: 'vi', name: 'Ti\u1EBFng Vi\u1EC7t', flag: '\u{1F1FB}\u{1F1F3}' },
        { code: 'es', name: 'Espa\u00F1ol',    flag: '\u{1F1F2}\u{1F1FD}' },
        { code: 'fr', name: 'Fran\u00E7ais',   flag: '\u{1F1EB}\u{1F1F7}' },
        { code: 'de', name: 'Deutsch',          flag: '\u{1F1E9}\u{1F1EA}' },
        { code: 'it', name: 'Italiano',         flag: '\u{1F1EE}\u{1F1F9}' },
        { code: 'pt', name: 'Portugu\u00EAs (BR)', flag: '\u{1F1E7}\u{1F1F7}' },
        { code: 'nl', name: 'Nederlands',       flag: '\u{1F1F3}\u{1F1F1}' },
        { code: 'ru', name: '\u0420\u0443\u0441\u0441\u043A\u0438\u0439', flag: '\u{1F1F7}\u{1F1FA}' },
        { code: 'uk', name: '\u0423\u043A\u0440\u0430\u0457\u043D\u0441\u044C\u043A\u0430', flag: '\u{1F1FA}\u{1F1E6}' },
        { code: 'ar', name: '\u0627\u0644\u0639\u0631\u0628\u064A\u0629', flag: '\u{1F1F8}\u{1F1E6}' },
        { code: 'hi', name: '\u0939\u093F\u0928\u094D\u0926\u0940', flag: '\u{1F1EE}\u{1F1F3}' },
        { code: 'zh', name: '\u4E2D\u6587',     flag: '\u{1F1E8}\u{1F1F3}' },
        { code: 'ja', name: '\u65E5\u672C\u8A9E', flag: '\u{1F1EF}\u{1F1F5}' },
        { code: 'ko', name: '\uD55C\uAD6D\uC5B4', flag: '\u{1F1F0}\u{1F1F7}' },
        { code: 'th', name: '\u0E20\u0E32\u0E29\u0E32\u0E44\u0E17\u0E22', flag: '\u{1F1F9}\u{1F1ED}' },
    ];

    const PCM_RATE = 24000;

    // ---- DOM ----
    const $roomPanel    = document.getElementById('room-panel');
    const $sessionPanel = document.getElementById('session-panel');
    const $myLang       = document.getElementById('my-lang');
    const $partnerLang  = document.getElementById('partner-lang');
    const $gFemale      = document.getElementById('g-female');
    const $gMale        = document.getElementById('g-male');
    const $gBtns        = [$gFemale, $gMale];
    const $createBtn    = document.getElementById('create-btn');
    const $joinCode     = document.getElementById('join-code');
    const $joinBtn      = document.getElementById('join-btn');
    const $codeDisplay  = document.getElementById('room-code-display');
    const $copyBtn      = document.getElementById('copy-code-btn');
    const $memberCount  = document.getElementById('member-count');
    const $startBtn     = document.getElementById('start-btn');
    const $sDot         = document.getElementById('s-dot');
    const $sText        = document.getElementById('s-text');
    const $transcript   = document.getElementById('transcript');
    const $leaveBtn     = document.getElementById('leave-btn');

    // ---- State ----
    let gender = localStorage.getItem('vb-bridge-gender') || 'female';
    let myLang = '';
    let partnerLang = '';

    // Room
    let roomCode = null;
    let memberId = null;
    let lastSeq = 0;
    let pollTimer = null;
    let heartTimer = null;

    // OpenAI Realtime
    let ws = null;
    let mediaStream = null;
    let audioCtx = null;
    let playCtx = null;
    let workletNode = null;
    let active = false;
    let agentSpeaking = false;
    let sessionPrompt = '';

    // Audio scheduling
    let nextPlayTime = 0;
    let scheduled = [];

    // Reconnection
    let reconnects = 0;
    const MAX_RECONNECTS = 5;
    let reconnectTimer = null;

    // Transcript pairing
    let pendingRow = null;
    let pendingSource = '';

    // ---- Init UI ----
    LANGS.forEach(l => {
        $myLang.add(new Option(`${l.flag} ${l.name}`, l.code));
        $partnerLang.add(new Option(`${l.flag} ${l.name}`, l.code));
    });
    $myLang.value      = localStorage.getItem('vb-bridge-my')      || 'en';
    $partnerLang.value  = localStorage.getItem('vb-bridge-partner') || 'vi';

    $gBtns.forEach(b => b.classList.toggle('active', b.dataset.gender === gender));
    $gBtns.forEach(b => b.addEventListener('click', () => {
        gender = b.dataset.gender;
        localStorage.setItem('vb-bridge-gender', gender);
        $gBtns.forEach(x => x.classList.toggle('active', x === b));
    }));

    $myLang.addEventListener('change',      () => localStorage.setItem('vb-bridge-my', $myLang.value));
    $partnerLang.addEventListener('change',  () => localStorage.setItem('vb-bridge-partner', $partnerLang.value));
    $createBtn.addEventListener('click',     createRoom);
    $joinBtn.addEventListener('click',       () => joinRoom($joinCode.value.trim()));
    $startBtn.addEventListener('click',      () => active ? stopSession() : startSession());
    $leaveBtn.addEventListener('click',      leaveRoom);
    $copyBtn.addEventListener('click',       copyRoomCode);

    window.addEventListener('beforeunload', () => {
        if (roomCode && memberId) {
            navigator.sendBeacon('/api/room', JSON.stringify({ action: 'leave', roomCode, memberId }));
        }
    });

    // =========================================================
    //  ROOM MANAGEMENT
    // =========================================================
    async function roomApi(action, extra) {
        const body = { action, roomCode, memberId, ...extra };
        const r = await fetch('/api/room', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        return r.json();
    }

    async function createRoom() {
        myLang = $myLang.value;
        partnerLang = $partnerLang.value;
        if (myLang === partnerLang) { alert('Languages must be different'); return; }
        $createBtn.disabled = true;
        try {
            const data = await roomApi('create', { roomCode: null, memberId: null });
            if (data.error) throw new Error(data.error);
            roomCode = data.roomCode;
            memberId = data.memberId;
            enterSession();
        } catch (err) { alert('Failed to create room: ' + err.message); }
        $createBtn.disabled = false;
    }

    async function joinRoom(code) {
        if (!code || code.length < 4) { alert('Enter a valid room code'); return; }
        myLang = $myLang.value;
        partnerLang = $partnerLang.value;
        if (myLang === partnerLang) { alert('Languages must be different'); return; }
        $joinBtn.disabled = true;
        try {
            const data = await roomApi('join', { roomCode: code.toUpperCase(), memberId: null });
            if (data.error) throw new Error(data.error);
            roomCode = data.roomCode;
            memberId = data.memberId;
            enterSession();
        } catch (err) { alert('Failed to join room: ' + err.message); }
        $joinBtn.disabled = false;
    }

    function enterSession() {
        $roomPanel.classList.add('hidden');
        $sessionPanel.classList.remove('hidden');
        $codeDisplay.textContent = roomCode;
        lastSeq = 0;
        startPolling();
        startHeartbeat();
        logSystem(`Joined room ${roomCode}`);
    }

    async function leaveRoom() {
        stopSession();
        stopPolling();
        stopHeartbeat();
        if (roomCode && memberId) { try { await roomApi('leave'); } catch (_) {} }
        roomCode = null;
        memberId = null;
        $sessionPanel.classList.add('hidden');
        $roomPanel.classList.remove('hidden');
    }

    function copyRoomCode() {
        if (roomCode) {
            navigator.clipboard.writeText(roomCode).then(() => {
                $copyBtn.textContent = 'Copied!';
                setTimeout(() => { $copyBtn.textContent = 'Copy'; }, 1500);
            });
        }
    }

    function startPolling() { stopPolling(); pollTimer = setInterval(poll, 1800); }
    function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

    async function poll() {
        if (!roomCode || !memberId) return;
        try {
            const data = await roomApi('poll', { since: lastSeq });
            if (data.messages) {
                data.messages.forEach(m => {
                    if (m.seq > lastSeq) lastSeq = m.seq;
                    if (m.memberId === memberId) return;
                    addRemoteMessage(m.sourceText, m.translatedText);
                });
            }
        } catch (_) {}
    }

    function startHeartbeat() {
        stopHeartbeat();
        heartTimer = setInterval(async () => {
            if (!roomCode || !memberId) return;
            try {
                const data = await roomApi('heartbeat');
                if (data.memberCount != null) $memberCount.textContent = `${data.memberCount} online`;
            } catch (_) {}
        }, 25000);
    }
    function stopHeartbeat() { if (heartTimer) { clearInterval(heartTimer); heartTimer = null; } }

    function broadcastPair(sourceText, translatedText) {
        if (!roomCode || !memberId) return;
        roomApi('send', { sourceText, translatedText, fromLang: myLang, toLang: partnerLang }).catch(() => {});
    }

    // =========================================================
    //  OPENAI REALTIME CONNECTION
    // =========================================================
    async function startSession() {
        reconnects = 0;
        pendingRow = null;
        pendingSource = '';
        setStatus('connecting', 'Connecting\u2026');

        try {
            if (!mediaStream) {
                mediaStream = await navigator.mediaDevices.getUserMedia({
                    audio: { sampleRate: PCM_RATE, channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
                });
            }
            if (!playCtx) {
                playCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: PCM_RATE });
            }
            nextPlayTime = 0;
            await connectAgent();
        } catch (err) {
            console.error('Start error:', err);
            logError(`Error: ${err.message}`);
            setStatus('error', 'Failed');
        }
    }

    async function connectAgent() {
        const r = await fetch(`/api/agent?from=${myLang}&to=${partnerLang}`);
        if (!r.ok) { const e = await r.json(); throw new Error(e.error || 'Server error'); }
        const { ephemeralKey, languages, systemPrompt } = await r.json();
        sessionPrompt = systemPrompt;

        if (reconnects === 0) {
            showColumnHeaders();
            logSystem(`Agent ready: ${languages.a} \u2192 ${languages.b}`);
        } else {
            logSystem(`Reconnected (attempt ${reconnects})`);
        }

        if (ws) { try { ws.close(); } catch (_) {} ws = null; }

        ws = new WebSocket(
            'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview',
            ['realtime', `openai-insecure-api-key.${ephemeralKey}`]
        );

        ws.onopen = () => {
            active = true;
            reconnects = 0;
            setStatus('active', 'Listening\u2026');
            $startBtn.querySelector('.btn-label').textContent = 'Stop';
            $startBtn.classList.add('active');

            // Transcription + VAD already set via client_secrets
            ws.send(JSON.stringify({
                type: 'session.update',
                session: {
                    type: 'realtime',
                    instructions: sessionPrompt,
                },
            }));

            startMicCapture();
        };

        ws.onmessage = (e) => {
            try { handleMsg(JSON.parse(e.data)); }
            catch (err) { console.warn('WS parse:', err); }
        };

        ws.onerror = (err) => console.error('WS error:', err);
        ws.onclose = () => { if (active) tryReconnect(); };
    }

    // =========================================================
    //  HANDLE OPENAI REALTIME MESSAGES
    // =========================================================
    function handleMsg(msg) {
        switch (msg.type) {
            case 'session.created':
            case 'session.updated':
                console.log('[bridge]', msg.type);
                break;

            case 'conversation.item.input_audio_transcription.completed': {
                const text = msg.transcript;
                if (text && text.trim()) {
                    pendingSource = text.trim();
                    addLocalOriginal(pendingSource);
                }
                break;
            }

            case 'response.audio_transcript.delta':
            case 'response.output_audio_transcript.delta': {
                if (msg.delta && pendingRow) {
                    const cell = pendingRow.querySelector('.b-msg-cell.translation');
                    if (cell) {
                        if (cell.classList.contains('empty')) {
                            cell.textContent = msg.delta;
                            cell.classList.remove('empty');
                        } else {
                            cell.textContent += msg.delta;
                        }
                    }
                }
                break;
            }

            case 'response.audio_transcript.done':
            case 'response.output_audio_transcript.done': {
                const text = msg.transcript;
                if (text && text.trim()) {
                    fillLocalTranslation(text.trim());
                    broadcastPair(pendingSource, text.trim());
                    pendingSource = '';
                }
                break;
            }

            case 'response.audio.delta':
            case 'response.output_audio.delta':
                if (msg.delta) playChunk(msg.delta);
                break;

            case 'error':
                console.error('[bridge] error:', msg.error);
                if (msg.error?.message) logError(`Error: ${msg.error.message}`);
                break;

            default:
                console.log('[bridge]', msg.type);
        }
    }

    // =========================================================
    //  MIC CAPTURE (24kHz)
    // =========================================================
    async function startMicCapture() {
        if (audioCtx) { try { audioCtx.close(); } catch (_) {} }
        audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: PCM_RATE });
        const source = audioCtx.createMediaStreamSource(mediaStream);
        const proc = audioCtx.createScriptProcessor(4096, 1, 1);

        proc.onaudioprocess = (e) => {
            if (!active || !ws || ws.readyState !== WebSocket.OPEN) return;
            // Mute mic while agent is speaking to prevent echo loop
            if (agentSpeaking) return;
            const raw = e.inputBuffer.getChannelData(0);
            const pcm = new Int16Array(raw.length);
            for (let i = 0; i < raw.length; i++) {
                const s = Math.max(-1, Math.min(1, raw[i]));
                pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
            }
            const bytes = new Uint8Array(pcm.buffer);
            let bin = '';
            for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
            ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: btoa(bin) }));
        };

        source.connect(proc);
        proc.connect(audioCtx.destination);
        workletNode = proc;
    }

    // =========================================================
    //  AUDIO PLAYBACK (24kHz)
    // =========================================================
    function playChunk(b64) {
        if (!playCtx) return;
        if (!agentSpeaking) { agentSpeaking = true; setStatus('speaking', 'Translating\u2026'); }

        const bin = atob(b64);
        const raw = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) raw[i] = bin.charCodeAt(i);
        const int16 = new Int16Array(raw.buffer);
        const f32 = new Float32Array(int16.length);
        for (let i = 0; i < int16.length; i++) f32[i] = int16[i] / 32768;

        const buf = playCtx.createBuffer(1, f32.length, PCM_RATE);
        buf.getChannelData(0).set(f32);
        const src = playCtx.createBufferSource();
        src.buffer = buf;
        src.connect(playCtx.destination);

        const t = Math.max(playCtx.currentTime, nextPlayTime);
        src.start(t);
        nextPlayTime = t + buf.duration;
        scheduled.push(src);
        src.onended = () => {
            scheduled = scheduled.filter(s => s !== src);
            if (scheduled.length === 0) { agentSpeaking = false; setStatus('active', 'Listening\u2026'); }
        };
    }

    function flushAudio() {
        scheduled.forEach(s => { try { s.stop(); } catch (_) {} });
        scheduled = [];
        nextPlayTime = 0;
        agentSpeaking = false;
    }

    // =========================================================
    //  RECONNECT
    // =========================================================
    function tryReconnect() {
        if (!active) return;
        if (reconnects >= MAX_RECONNECTS) { logError('Lost connection. Please restart.'); stopSession(); return; }
        reconnects++;
        const delay = Math.min(1000 * 2 ** (reconnects - 1), 8000);
        setStatus('connecting', `Reconnecting in ${delay / 1000}s\u2026`);
        logSystem(`Connection lost. Retrying\u2026 (${reconnects}/${MAX_RECONNECTS})`);
        flushAudio();
        reconnectTimer = setTimeout(async () => {
            if (!active) return;
            try { await connectAgent(); } catch (_) { tryReconnect(); }
        }, delay);
    }

    // =========================================================
    //  STOP SESSION (stay in room)
    // =========================================================
    function stopSession() {
        active = false;
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        if (ws) { ws.close(); ws = null; }
        if (workletNode) { workletNode.disconnect(); workletNode = null; }
        if (audioCtx)    { audioCtx.close(); audioCtx = null; }
        if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
        flushAudio();
        if (playCtx) { playCtx.close(); playCtx = null; }
        reconnects = 0;
        $startBtn.querySelector('.btn-label').textContent = 'Start Translating';
        $startBtn.classList.remove('active');
        setStatus('idle', 'Ready');
        logSystem('Session stopped');
    }

    // =========================================================
    //  TRANSCRIPT UI
    // =========================================================
    function showColumnHeaders() {
        const el = document.getElementById('transcript-empty');
        if (el) el.style.display = 'none';
        const hdr = document.getElementById('col-headers');
        if (hdr) hdr.style.display = '';
    }

    function addLocalOriginal(text) {
        showColumnHeaders();
        const wrapper = document.createElement('div');
        const tag = document.createElement('div');
        tag.className = 'sender-tag you';
        tag.textContent = 'You';

        const row = document.createElement('div');
        row.className = 'b-msg-row';
        const left = document.createElement('div');
        left.className = 'b-msg-cell original';
        left.textContent = text;
        const right = document.createElement('div');
        right.className = 'b-msg-cell translation empty';
        right.textContent = '\u2026';

        row.appendChild(left);
        row.appendChild(right);
        wrapper.appendChild(tag);
        wrapper.appendChild(row);
        $transcript.appendChild(wrapper);
        pendingRow = row;
        scrollDown();
    }

    function fillLocalTranslation(text) {
        if (pendingRow) {
            const cell = pendingRow.querySelector('.b-msg-cell.translation');
            if (cell) { cell.textContent = text; cell.classList.remove('empty'); }
            pendingRow = null;
        }
        scrollDown();
    }

    function addRemoteMessage(sourceText, translatedText) {
        showColumnHeaders();
        const wrapper = document.createElement('div');
        const tag = document.createElement('div');
        tag.className = 'sender-tag partner';
        tag.textContent = 'Partner';

        const row = document.createElement('div');
        row.className = 'b-msg-row';
        const left = document.createElement('div');
        left.className = 'b-msg-cell original';
        left.textContent = sourceText || '';
        const right = document.createElement('div');
        right.className = 'b-msg-cell translation';
        right.textContent = translatedText || '';

        row.appendChild(left);
        row.appendChild(right);
        wrapper.appendChild(tag);
        wrapper.appendChild(row);
        $transcript.appendChild(wrapper);
        scrollDown();
    }

    function logSystem(text) {
        showColumnHeaders();
        const div = document.createElement('div');
        div.className = 'b-system';
        div.textContent = `\u2014 ${text}`;
        $transcript.appendChild(div);
        scrollDown();
    }

    function logError(text) {
        showColumnHeaders();
        const div = document.createElement('div');
        div.className = 'b-error';
        div.textContent = text;
        $transcript.appendChild(div);
        scrollDown();
    }

    function scrollDown() { $transcript.scrollTop = $transcript.scrollHeight; }

    function setStatus(state, text) {
        $sDot.className = 's-dot ' + state;
        $sText.textContent = text;
    }

})();
