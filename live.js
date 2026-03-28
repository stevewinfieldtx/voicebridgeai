/* =========================================
   TalkBridge — Live Translate Mode
   OpenAI Realtime API for seamless
   bidirectional voice translation.
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

    const PCM_RATE = 24000; // OpenAI Realtime uses 24kHz

    // ---- DOM ----
    const $fromSelect   = document.getElementById('lang-from');
    const $toSelect     = document.getElementById('lang-to');
    const $startBtn     = document.getElementById('start-btn');
    const $statusDot    = document.getElementById('status-dot');
    const $statusText   = document.getElementById('status-text');
    const $transcript   = document.getElementById('transcript');
    const $genderFemale = document.getElementById('gender-female');
    const $genderMale   = document.getElementById('gender-male');
    const $genderBtns   = [$genderFemale, $genderMale];

    // ---- State ----
    let ws = null;
    let mediaStream = null;
    let audioCtx = null;
    let playCtx = null;
    let workletNode = null;
    let active = false;
    let agentSpeaking = false;
    let gender = localStorage.getItem('vb-gender') || 'female';

    // Audio playback scheduling
    let nextPlayTime = 0;
    let scheduled = [];

    // Reconnection
    let reconnects = 0;
    const MAX_RECONNECTS = 5;
    let reconnectTimer = null;

    // Session
    let curFrom = '';
    let curTo = '';
    let sessionPrompt = '';

    // Transcript pairing
    let pendingRow = null;

    // ---- Init UI ----
    LANGS.forEach(l => {
        $fromSelect.add(new Option(`${l.flag} ${l.name}`, l.code));
        $toSelect.add(new Option(`${l.flag} ${l.name}`, l.code));
    });
    $fromSelect.value = localStorage.getItem('vb-live-from') || 'en';
    $toSelect.value   = localStorage.getItem('vb-live-to')   || 'vi';

    $genderBtns.forEach(b => b.classList.toggle('active', b.dataset.gender === gender));
    $genderBtns.forEach(b => b.addEventListener('click', () => {
        gender = b.dataset.gender;
        localStorage.setItem('vb-gender', gender);
        $genderBtns.forEach(x => x.classList.toggle('active', x === b));
    }));

    $fromSelect.addEventListener('change', () => localStorage.setItem('vb-live-from', $fromSelect.value));
    $toSelect.addEventListener('change',   () => localStorage.setItem('vb-live-to',   $toSelect.value));
    $startBtn.addEventListener('click',     () => active ? stop() : start());

    // =========================================================
    //  START SESSION
    // =========================================================
    async function start() {
        const from = $fromSelect.value;
        const to   = $toSelect.value;
        if (from === to) { log('Please select two different languages.', 'system'); return; }

        curFrom = from;
        curTo   = to;
        reconnects = 0;
        pendingRow = null;

        setStatus('connecting', 'Connecting\u2026');
        lockUI(true);

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
            await connect();
        } catch (err) {
            console.error('Start error:', err);
            log(`Error: ${err.message}`, 'error');
            setStatus('error', 'Failed');
            lockUI(false);
        }
    }

    // =========================================================
    //  CONNECT TO OPENAI REALTIME
    // =========================================================
    async function connect() {
        // Get ephemeral token + system prompt from our server
        const r = await fetch(`/api/agent?from=${curFrom}&to=${curTo}`);
        if (!r.ok) { const e = await r.json(); throw new Error(e.error || 'Server error'); }
        const { ephemeralKey, languages, systemPrompt } = await r.json();
        sessionPrompt = systemPrompt;

        if (reconnects === 0) {
            setColumnHeaders();
            log(`Ready: ${languages.a} \u2194 ${languages.b}`, 'system');
        } else {
            log(`Reconnected (attempt ${reconnects})`, 'system');
        }

        if (ws) { try { ws.close(); } catch (_) {} ws = null; }

        // Connect with ephemeral key as subprotocol
        ws = new WebSocket(
            'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview',
            ['realtime', `openai-insecure-api-key.${ephemeralKey}`]
        );

        ws.onopen = () => {
            active = true;
            reconnects = 0;
            setStatus('active', 'Listening\u2026');
            lockUI(true);
            $startBtn.disabled = false;
            $startBtn.querySelector('.btn-label').textContent = 'Stop';
            $startBtn.classList.add('active');

            // Configure the session
            ws.send(JSON.stringify({
                type: 'session.update',
                session: {
                    type: 'realtime',
                    instructions: sessionPrompt,
                    input_audio_transcription: { model: 'whisper-1' },
                    turn_detection: {
                        type: 'server_vad',
                        threshold: 0.5,
                        prefix_padding_ms: 300,
                        silence_duration_ms: 500,
                    },
                },
            }));

            startMicCapture();
        };

        ws.onmessage = (e) => {
            try { handleMsg(JSON.parse(e.data)); }
            catch (err) { console.warn('WS parse error:', err); }
        };

        ws.onerror = (err) => console.error('WS error:', err);

        ws.onclose = () => {
            if (active) tryReconnect();
        };
    }

    // =========================================================
    //  HANDLE OPENAI REALTIME MESSAGES
    // =========================================================
    function handleMsg(msg) {
        switch (msg.type) {
            case 'session.created':
            case 'session.updated':
                console.log('[rt]', msg.type);
                break;

            // User speech transcript
            case 'conversation.item.input_audio_transcription.completed': {
                const text = msg.transcript;
                if (text && text.trim()) addOriginalRow(text.trim());
                break;
            }

            // Translation text (streaming)
            case 'response.audio_transcript.delta':
            case 'response.output_audio_transcript.delta': {
                // Accumulate streaming text — update pending row
                if (msg.delta && pendingRow) {
                    const cell = pendingRow.querySelector('.msg-cell.col-to');
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

            // Translation text (complete)
            case 'response.audio_transcript.done':
            case 'response.output_audio_transcript.done': {
                const text = msg.transcript;
                if (text && text.trim()) fillTranslation(text.trim());
                break;
            }

            // Audio chunks
            case 'response.audio.delta':
            case 'response.output_audio.delta': {
                if (msg.delta) playChunk(msg.delta);
                break;
            }

            case 'response.audio.done':
            case 'response.output_audio.done':
                // Audio stream complete
                break;

            case 'error':
                console.error('[rt] error:', msg.error);
                if (msg.error?.message) log(`Error: ${msg.error.message}`, 'error');
                break;

            default:
                console.log('[rt]', msg.type);
        }
    }

    // =========================================================
    //  MIC CAPTURE (24kHz PCM → WebSocket)
    // =========================================================
    async function startMicCapture() {
        if (audioCtx) { try { audioCtx.close(); } catch (_) {} }
        audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: PCM_RATE });

        const source = audioCtx.createMediaStreamSource(mediaStream);

        // Use ScriptProcessor (widely supported) for PCM capture
        const bufSize = 4096;
        const proc = audioCtx.createScriptProcessor(bufSize, 1, 1);

        proc.onaudioprocess = (e) => {
            if (!active || !ws || ws.readyState !== WebSocket.OPEN) return;

            const raw = e.inputBuffer.getChannelData(0);
            const pcm = new Int16Array(raw.length);
            for (let i = 0; i < raw.length; i++) {
                const s = Math.max(-1, Math.min(1, raw[i]));
                pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
            }

            const bytes = new Uint8Array(pcm.buffer);
            let bin = '';
            for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);

            ws.send(JSON.stringify({
                type: 'input_audio_buffer.append',
                audio: btoa(bin),
            }));
        };

        source.connect(proc);
        proc.connect(audioCtx.destination);
        workletNode = proc; // store for cleanup
    }

    // =========================================================
    //  AUDIO PLAYBACK (24kHz PCM)
    // =========================================================
    function playChunk(b64) {
        if (!playCtx) return;

        if (!agentSpeaking) {
            agentSpeaking = true;
            setStatus('speaking', 'Translating\u2026');
        }

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

        const now = playCtx.currentTime;
        const t = Math.max(now, nextPlayTime);
        src.start(t);
        nextPlayTime = t + buf.duration;

        scheduled.push(src);
        src.onended = () => {
            scheduled = scheduled.filter(s => s !== src);
            if (scheduled.length === 0) {
                agentSpeaking = false;
                setStatus('active', 'Listening\u2026');
            }
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
        if (reconnects >= MAX_RECONNECTS) {
            log('Lost connection. Please restart.', 'error');
            stop();
            return;
        }
        reconnects++;
        const delay = Math.min(1000 * 2 ** (reconnects - 1), 8000);
        setStatus('connecting', `Reconnecting in ${delay / 1000}s\u2026`);
        log(`Connection lost. Retrying\u2026 (${reconnects}/${MAX_RECONNECTS})`, 'system');
        flushAudio();
        reconnectTimer = setTimeout(async () => {
            if (!active) return;
            try { await connect(); }
            catch (_) { tryReconnect(); }
        }, delay);
    }

    // =========================================================
    //  STOP SESSION
    // =========================================================
    function stop() {
        active = false;
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        if (ws) { ws.close(); ws = null; }
        if (workletNode) { workletNode.disconnect(); workletNode = null; }
        if (audioCtx)    { audioCtx.close(); audioCtx = null; }
        if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
        flushAudio();
        if (playCtx) { playCtx.close(); playCtx = null; }
        reconnects = 0;
        lockUI(false);
        setStatus('idle', 'Ready');
        log('Session ended', 'system');
    }

    // =========================================================
    //  TRANSCRIPT UI — Original | Translation
    // =========================================================
    function setColumnHeaders() {
        const el = document.getElementById('transcript-empty');
        if (el) el.style.display = 'none';
        const hdr = document.getElementById('col-headers');
        if (hdr) hdr.style.display = '';
    }

    function addOriginalRow(text) {
        setColumnHeaders();
        const row = document.createElement('div');
        row.className = 'msg-row';

        const left = document.createElement('div');
        left.className = 'msg-cell col-from';
        left.textContent = text;

        const right = document.createElement('div');
        right.className = 'msg-cell col-to empty';
        right.textContent = '\u2026';

        row.appendChild(left);
        row.appendChild(right);
        $transcript.appendChild(row);
        pendingRow = row;
        scrollDown();
    }

    function fillTranslation(text) {
        if (pendingRow) {
            const cell = pendingRow.querySelector('.msg-cell.col-to');
            if (cell) {
                cell.textContent = text;
                cell.classList.remove('empty');
            }
            pendingRow = null;
        }
        scrollDown();
    }

    function log(text, type) {
        setColumnHeaders();
        const div = document.createElement('div');
        div.className = `transcript-line ${type}`;
        div.textContent = type === 'system' ? `\u2014 ${text}` : text;
        $transcript.appendChild(div);
        scrollDown();
    }

    function scrollDown() { $transcript.scrollTop = $transcript.scrollHeight; }

    // =========================================================
    //  UI HELPERS
    // =========================================================
    function setStatus(state, text) {
        $statusDot.className = 'status-dot ' + state;
        $statusText.textContent = text;
    }

    function lockUI(locked) {
        $startBtn.disabled = false;
        $startBtn.querySelector('.btn-label').textContent = locked ? 'Stop' : 'Start Live Session';
        $startBtn.classList.toggle('active', locked);
        $fromSelect.disabled = locked;
        $toSelect.disabled   = locked;
        $genderBtns.forEach(b => b.disabled = locked);
    }

})();
