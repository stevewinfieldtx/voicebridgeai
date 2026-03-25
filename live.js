/* =========================================
   TalkBridge — Live Translate Mode
   ElevenLabs Conversational AI agent for
   seamless bidirectional voice translation.
   ========================================= */

(function () {
    'use strict';

    // ---- Language Catalog ----
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

    // ---- Idle chatter patterns to suppress ----
    const IDLE_PATTERNS = [
        /are you (still )?there/i,
        /hello\??$/i,
        /^hi\!?$/i,
        /how can i help/i,
        /what would you like/i,
        /can i help/i,
        /is there anything/i,
        /i'?m (still )?here/i,
        /waiting for/i,
        /let me know/i,
        /go ahead/i,
        /ready when you are/i,
        /still listening/i,
        /do you need/i,
        /what can i/i,
        /how may i/i,
    ];

    // Minimum response length — suppress very short utterances (stutters/breaths)
    const MIN_RESPONSE_LEN = 2;

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
    let micCtx = null;
    let playCtx = null;
    let srcNode = null;
    let procNode = null;
    let active = false;
    let agentSpeaking = false;
    let gender = localStorage.getItem('vb-gender') || 'female';

    // Audio scheduling
    let nextPlayTime = 0;
    let scheduled = [];
    const PCM_RATE = 16000;

    // Reconnection
    let reconnects = 0;
    const MAX_RECONNECTS = 5;
    let reconnectTimer = null;
    let lastPong = 0;
    let watchdog = null;

    // Session params — which language is "English" and which is "other"
    let curFrom = '';
    let curTo = '';
    let englishCode = '';   // whichever of from/to is 'en'
    let otherCode = '';     // the non-English language
    let otherName = '';     // display name for the other language

    // Idle suppression
    let lastSpeechAt = 0;
    let suppressCurrent = false;

    // Transcript pairing
    let pendingRow = null;
    let pendingIsEnglish = false; // was the pending user_transcript English?

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
    //  LANGUAGE DETECTION (simple heuristic)
    //  Used to determine which column text belongs in.
    // =========================================================
    function isLikelyEnglish(text) {
        if (!text) return true;
        // Count characters outside basic ASCII range
        const nonAscii = text.replace(/[\x00-\x7F]/g, '').length;
        // If less than 15% non-ASCII, likely English
        return nonAscii / text.length < 0.15;
    }

    // =========================================================
    //  START SESSION
    // =========================================================
    async function start() {
        const from = $fromSelect.value;
        const to   = $toSelect.value;
        if (from === to) { log('Please select two different languages.', 'system'); return; }

        curFrom = from;
        curTo   = to;

        // Determine which is English
        if (from === 'en') {
            englishCode = 'en';
            otherCode = to;
        } else {
            englishCode = 'en';
            otherCode = from === 'en' ? to : from;
        }

        reconnects = 0;
        lastSpeechAt = 0;
        pendingRow = null;
        suppressCurrent = false;

        setStatus('connecting', 'Connecting\u2026');
        lockUI(true);

        try {
            if (!mediaStream) {
                mediaStream = await navigator.mediaDevices.getUserMedia({
                    audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
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
    //  CONNECT WEBSOCKET
    // =========================================================
    async function connect() {
        const { signedUrl, languages } = await fetchAgent();

        // Find the other language name from the response
        otherName = (curFrom === 'en') ? languages.b : languages.a;

        if (reconnects === 0) {
            setColumnHeaders(otherName);
            log(`Agent ready: English \u2194 ${otherName}`, 'system');
        } else {
            log(`Reconnected (attempt ${reconnects})`, 'system');
        }

        if (ws) { try { ws.close(); } catch (_) {} ws = null; }

        ws = new WebSocket(signedUrl);
        lastPong = Date.now();

        ws.onopen = () => {
            active = true;
            reconnects = 0;
            setStatus('active', 'Listening\u2026');
            lockUI(true);
            $startBtn.disabled = false;
            $startBtn.querySelector('.btn-label').textContent = 'Stop';
            $startBtn.classList.add('active');
            if (!procNode) startMicCapture();
            startWatchdog();
        };

        ws.onmessage = (e) => {
            try { handleMsg(JSON.parse(e.data)); }
            catch (err) { console.warn('WS parse error:', err); }
        };

        ws.onerror = (err) => console.error('WS error:', err);

        ws.onclose = () => {
            stopWatchdog();
            if (active) tryReconnect();
        };
    }

    async function fetchAgent() {
        const r = await fetch(`/api/agent?from=${curFrom}&to=${curTo}&gender=${gender}`);
        if (!r.ok) { const e = await r.json(); throw new Error(e.error || 'Server error'); }
        return r.json();
    }

    // =========================================================
    //  HANDLE AGENT MESSAGES
    // =========================================================
    function handleMsg(msg) {
        switch (msg.type) {
            case 'conversation_initiation_metadata':
                console.log('[ws] session started');
                break;

            case 'user_transcript': {
                const text = msg.user_transcript_event?.user_transcript;
                console.log('[ws] user_transcript:', text);
                if (text && text.trim().length >= MIN_RESPONSE_LEN) {
                    lastSpeechAt = Date.now();
                    suppressCurrent = false;
                    const isEn = isLikelyEnglish(text);
                    pendingIsEnglish = isEn;
                    addTranscriptRow(text, null, isEn);
                }
                break;
            }

            case 'agent_response': {
                const text = msg.agent_response_event?.agent_response;
                console.log('[ws] agent_response:', text);
                if (!text || text.trim().length < MIN_RESPONSE_LEN) break;

                // Suppress idle chatter patterns
                if (IDLE_PATTERNS.some(rx => rx.test(text.trim()))) {
                    console.log('[suppress-pattern]', text);
                    suppressCurrent = true;
                    break;
                }

                suppressCurrent = false;
                fillTranslation(text);
                break;
            }

            case 'audio': {
                if (suppressCurrent) break;
                if (msg.audio_event?.audio_base_64) {
                    playChunk(msg.audio_event.audio_base_64);
                }
                break;
            }

            case 'interruption':
                flushAudio();
                suppressCurrent = false;
                break;

            case 'ping':
                lastPong = Date.now();
                if (ws?.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'pong', event_id: msg.ping_event?.event_id }));
                }
                break;

            case 'agent_response_correction': {
                const text = msg.agent_response_correction_event?.corrected_text;
                if (text) updateLastTranslation(text);
                break;
            }

            default:
                console.log('[ws]', msg.type);
        }
    }

    // =========================================================
    //  MIC CAPTURE → WEBSOCKET
    // =========================================================
    function startMicCapture() {
        micCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
        srcNode = micCtx.createMediaStreamSource(mediaStream);

        const bufSize = 4096;
        procNode = micCtx.createScriptProcessor(bufSize, 1, 1);

        procNode.onaudioprocess = (e) => {
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

            ws.send(JSON.stringify({ user_audio_chunk: btoa(bin) }));
        };

        srcNode.connect(procNode);
        procNode.connect(micCtx.destination);
    }

    // =========================================================
    //  AUDIO PLAYBACK (PCM 16kHz → Speaker)
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
    //  RECONNECT + WATCHDOG
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

    function startWatchdog() {
        stopWatchdog();
        watchdog = setInterval(() => {
            if (!active || !ws) return;
            if (Date.now() - lastPong > 30000) {
                console.warn('Watchdog: no pong in 30s');
                try { ws.close(); } catch (_) {}
            }
        }, 15000);
    }
    function stopWatchdog() { if (watchdog) { clearInterval(watchdog); watchdog = null; } }

    // =========================================================
    //  STOP SESSION
    // =========================================================
    function stop() {
        active = false;
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        stopWatchdog();
        if (ws) { ws.close(); ws = null; }
        if (procNode)    { procNode.disconnect(); procNode = null; }
        if (srcNode)     { srcNode.disconnect();  srcNode = null; }
        if (micCtx)      { micCtx.close();  micCtx = null; }
        if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
        flushAudio();
        if (playCtx) { playCtx.close(); playCtx = null; }
        reconnects = 0;
        lockUI(false);
        setStatus('idle', 'Ready');
        log('Session ended', 'system');
    }

    // =========================================================
    //  TRANSCRIPT UI — Two fixed columns
    //  Left column = ALWAYS English
    //  Right column = ALWAYS other language
    // =========================================================
    function setColumnHeaders(otherLangName) {
        const hFrom = document.getElementById('col-header-from');
        const hTo   = document.getElementById('col-header-to');
        if (hFrom) hFrom.textContent = '\uD83C\uDDFA\uD83C\uDDF8 English';
        if (hTo)   hTo.textContent   = `\uD83C\uDF10 ${otherLangName}`;
    }

    /**
     * Add a new transcript row.
     * @param {string} text       - the user's spoken text
     * @param {string|null} trans - translation (null = pending)
     * @param {boolean} isEnglish - was the spoken text English?
     */
    function addTranscriptRow(text, trans, isEnglish) {
        hideEmpty();

        const row = document.createElement('div');
        row.className = 'msg-row';

        const enCell = document.createElement('div');
        const otherCell = document.createElement('div');

        if (isEnglish) {
            // User spoke English → English text left, translation pending right
            enCell.className = 'msg-cell col-from';
            enCell.textContent = text;
            otherCell.className = 'msg-cell col-to empty';
            otherCell.textContent = '\u2026';
        } else {
            // User spoke other language → other text right, translation pending left
            enCell.className = 'msg-cell col-from empty';
            enCell.textContent = '\u2026';
            otherCell.className = 'msg-cell col-to';
            otherCell.textContent = text;
        }

        row.appendChild(enCell);
        row.appendChild(otherCell);
        $transcript.appendChild(row);
        pendingRow = row;
        scrollDown();
    }

    /**
     * Fill in the translation for the pending row.
     */
    function fillTranslation(text) {
        hideEmpty();

        if (pendingRow) {
            // Find the cell that's still marked 'empty'
            const emptyCell = pendingRow.querySelector('.msg-cell.empty');
            if (emptyCell) {
                emptyCell.textContent = text;
                emptyCell.classList.remove('empty');
            }
            pendingRow = null;
        } else {
            // Standalone agent response (no pending user row)
            const row = document.createElement('div');
            row.className = 'msg-row';

            const isEn = isLikelyEnglish(text);
            const enCell = document.createElement('div');
            const otherCell = document.createElement('div');

            if (isEn) {
                enCell.className = 'msg-cell col-from';
                enCell.textContent = text;
                otherCell.className = 'msg-cell col-to empty';
            } else {
                enCell.className = 'msg-cell col-from empty';
                otherCell.className = 'msg-cell col-to';
                otherCell.textContent = text;
            }

            row.appendChild(enCell);
            row.appendChild(otherCell);
            $transcript.appendChild(row);
        }
        scrollDown();
    }

    function updateLastTranslation(text) {
        const rows = $transcript.querySelectorAll('.msg-row');
        if (rows.length) {
            const emptyCell = rows[rows.length - 1].querySelector('.msg-cell.empty');
            if (emptyCell) {
                emptyCell.textContent = text;
                emptyCell.classList.remove('empty');
            }
        }
    }

    function log(text, type) {
        hideEmpty();
        const div = document.createElement('div');
        div.className = `transcript-line ${type}`;
        div.textContent = type === 'system' ? `\u2014 ${text}` : text;
        $transcript.appendChild(div);
        scrollDown();
    }

    function hideEmpty() {
        const el = document.getElementById('transcript-empty');
        if (el) el.style.display = 'none';
        const hdr = document.getElementById('col-headers');
        if (hdr) hdr.style.display = '';
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
