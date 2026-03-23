/* =========================================
   TalkBridge — Live Translate Mode
   Uses ElevenLabs Conversational AI agent
   for seamless bidirectional translation.
   ========================================= */

(function () {
    'use strict';

    // ---- Language Catalog (same as main app) ----
    const LANGS = [
        { code: 'en',  name: 'English',    flag: '🇺🇸' },
        { code: 'vi',  name: 'Tiếng Việt', flag: '🇻🇳' },
        { code: 'es',  name: 'Español',    flag: '🇲🇽' },
        { code: 'fr',  name: 'Français',   flag: '🇫🇷' },
        { code: 'de',  name: 'Deutsch',    flag: '🇩🇪' },
        { code: 'it',  name: 'Italiano',   flag: '🇮🇹' },
        { code: 'pt',  name: 'Português (BR)', flag: '🇧🇷' },
        { code: 'nl',  name: 'Nederlands', flag: '🇳🇱' },
        { code: 'ru',  name: 'Русский',    flag: '🇷🇺' },
        { code: 'uk',  name: 'Українська', flag: '🇺🇦' },
        { code: 'ar',  name: 'العربية',    flag: '🇸🇦' },
        { code: 'hi',  name: 'हिन्दी',     flag: '🇮🇳' },
        { code: 'zh',  name: '中文',        flag: '🇨🇳' },
        { code: 'ja',  name: '日本語',      flag: '🇯🇵' },
        { code: 'ko',  name: '한국어',      flag: '🇰🇷' },
        { code: 'th',  name: 'ภาษาไทย',    flag: '🇹🇭' },
    ];

    // ---- DOM Elements ----
    const langFromSelect = document.getElementById('lang-from');
    const langToSelect   = document.getElementById('lang-to');
    const startBtn       = document.getElementById('start-btn');
    const statusDot      = document.getElementById('status-dot');
    const statusText     = document.getElementById('status-text');
    const transcript     = document.getElementById('transcript');
    const backLink       = document.getElementById('back-link');
    const genderFemale   = document.getElementById('gender-female');
    const genderMale     = document.getElementById('gender-male');
    const genderBtns     = [genderFemale, genderMale];

    // ---- State ----
    let ws = null;
    let mediaStream = null;
    let audioContext = null;   // for mic capture
    let playbackCtx = null;    // for playing agent audio
    let sourceNode = null;
    let processorNode = null;
    let isActive = false;
    let isAgentSpeaking = false;
    let selectedGender = localStorage.getItem('vb-gender') || 'female';

    // Audio scheduling state
    let nextPlayTime = 0;          // AudioContext.currentTime of next chunk
    let scheduledSources = [];     // active AudioBufferSourceNodes
    const AGENT_SAMPLE_RATE = 16000;  // ElevenLabs output PCM sample rate

    // Reconnection state
    let reconnectAttempts = 0;
    const MAX_RECONNECTS = 5;
    let reconnectTimer = null;
    let lastPongTime = 0;
    let watchdogInterval = null;
    let currentFrom = '';
    let currentTo = '';
    let lastUserSpeechTime = 0;           // tracks when user last spoke
    const IDLE_SUPPRESS_MS = 8000;        // suppress agent if no user speech for 8s
    let pendingRow = null;                // current msg-row awaiting translation

    // ---- Populate Language Selects ----
    LANGS.forEach(lang => {
        langFromSelect.add(new Option(`${lang.flag} ${lang.name}`, lang.code));
        langToSelect.add(new Option(`${lang.flag} ${lang.name}`, lang.code));
    });

    // Load saved preferences
    langFromSelect.value = localStorage.getItem('vb-live-from') || 'en';
    langToSelect.value   = localStorage.getItem('vb-live-to') || 'vi';

    // Apply saved gender
    genderBtns.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.gender === selectedGender);
    });

    // Gender toggle logic
    genderBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            selectedGender = btn.dataset.gender;
            localStorage.setItem('vb-gender', selectedGender);
            genderBtns.forEach(b => b.classList.toggle('active', b === btn));
        });
    });

    // ---- Button Click ----
    startBtn.addEventListener('click', () => {
        if (isActive) {
            stopSession();
        } else {
            startSession();
        }
    });

    // Save language selection
    langFromSelect.addEventListener('change', () => {
        localStorage.setItem('vb-live-from', langFromSelect.value);
    });
    langToSelect.addEventListener('change', () => {
        localStorage.setItem('vb-live-to', langToSelect.value);
    });

    // ---- Start Session ----
    async function startSession() {
        const from = langFromSelect.value;
        const to = langToSelect.value;

        if (from === to) {
            addTranscriptLine('⚠️ Please select two different languages.', 'system');
            return;
        }

        currentFrom = from;
        currentTo = to;
        reconnectAttempts = 0;

        setStatus('connecting', 'Connecting…');
        startBtn.disabled = true;
        langFromSelect.disabled = true;
        langToSelect.disabled = true;
        genderBtns.forEach(b => b.disabled = true);

        try {
            // Step 1: Get microphone access (keep alive across reconnects)
            if (!mediaStream) {
                mediaStream = await navigator.mediaDevices.getUserMedia({
                    audio: {
                        sampleRate: 16000,
                        channelCount: 1,
                        echoCancellation: true,
                        noiseSuppression: true,
                        autoGainControl: true,
                    },
                });
            }

            // Step 2: Create playback audio context
            if (!playbackCtx) {
                playbackCtx = new (window.AudioContext || window.webkitAudioContext)({
                    sampleRate: AGENT_SAMPLE_RATE,
                });
            }
            nextPlayTime = 0;

            // Step 3: Connect WebSocket (gets fresh signed URL)
            await connectWebSocket();

        } catch (err) {
            console.error('Start error:', err);
            addTranscriptLine(`❌ ${err.message}`, 'error');
            setStatus('error', 'Failed');
            resetControls();
        }
    }

    // ---- Fetch fresh signed URL from our server ----
    async function fetchSignedUrl() {
        const resp = await fetch(
            `/api/agent?from=${currentFrom}&to=${currentTo}&gender=${selectedGender}`
        );
        if (!resp.ok) {
            const err = await resp.json();
            throw new Error(err.error || 'Server error');
        }
        const data = await resp.json();
        return data;
    }

    // ---- WebSocket Connection (with auto-reconnect) ----
    async function connectWebSocket() {
        // Always fetch a fresh signed URL for each connection
        const { signedUrl, languages } = await fetchSignedUrl();
        if (reconnectAttempts === 0) {
            // Update column headers with language names
            const colFrom = document.getElementById('col-header-from');
            const colTo = document.getElementById('col-header-to');
            if (colFrom) colFrom.textContent = `🗣️ ${languages.a}`;
            if (colTo) colTo.textContent = `🌐 ${languages.b}`;
            addTranscriptLine(`🔗 Agent ready: ${languages.a} ↔ ${languages.b}`, 'system');
        } else {
            addTranscriptLine(`🔄 Reconnected (attempt ${reconnectAttempts})`, 'system');
        }

        // Close any existing WebSocket cleanly
        if (ws) {
            try { ws.close(); } catch (_) { /* ignore */ }
            ws = null;
        }

        ws = new WebSocket(signedUrl);
        lastPongTime = Date.now();

        ws.onopen = () => {
            setStatus('active', 'Listening…');
            isActive = true;
            reconnectAttempts = 0; // reset on successful connection
            startBtn.disabled = false;
            startBtn.querySelector('.btn-label').textContent = 'Stop';
            startBtn.classList.add('active');

            // Start mic capture if not already running
            if (!processorNode) {
                startAudioCapture();
            }

            // Start watchdog
            startWatchdog();
        };

        ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                handleAgentMessage(msg);
            } catch (e) {
                // Binary audio data or unparseable
                console.warn('WS message parse error:', e);
            }
        };

        ws.onerror = (err) => {
            console.error('WS error:', err);
        };

        ws.onclose = (event) => {
            console.log('WS closed:', event.code, event.reason);
            stopWatchdog();

            if (isActive) {
                // Unexpected close — try to reconnect
                attemptReconnect();
            }
        };
    }

    // ---- Auto-Reconnect with Backoff ----
    function attemptReconnect() {
        if (!isActive) return;
        if (reconnectAttempts >= MAX_RECONNECTS) {
            addTranscriptLine('❌ Lost connection after multiple retries. Please restart.', 'error');
            stopSession();
            return;
        }

        reconnectAttempts++;
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts - 1), 8000); // 1s, 2s, 4s, 8s...
        setStatus('connecting', `Reconnecting in ${delay / 1000}s…`);
        addTranscriptLine(`⚡ Connection lost. Reconnecting… (${reconnectAttempts}/${MAX_RECONNECTS})`, 'system');

        // Stop any current audio but keep mic alive
        stopCurrentAudio();

        reconnectTimer = setTimeout(async () => {
            if (!isActive) return;
            try {
                await connectWebSocket();
            } catch (err) {
                console.error('Reconnect error:', err);
                attemptReconnect(); // try again
            }
        }, delay);
    }

    // ---- Connection Watchdog ----
    function startWatchdog() {
        stopWatchdog();
        watchdogInterval = setInterval(() => {
            if (!isActive || !ws) return;

            // If we haven't received a pong in 30 seconds, connection is dead
            if (Date.now() - lastPongTime > 30000) {
                console.warn('Watchdog: no pong in 30s, forcing reconnect');
                if (ws) {
                    try { ws.close(); } catch (_) { /* triggers onclose → reconnect */ }
                }
            }
        }, 15000); // check every 15 seconds
    }

    function stopWatchdog() {
        if (watchdogInterval) {
            clearInterval(watchdogInterval);
            watchdogInterval = null;
        }
    }

    // ---- Handle Messages from ElevenLabs Agent ----
    function handleAgentMessage(msg) {
        switch (msg.type) {
            case 'conversation_initiation_metadata':
                console.log('Agent initialized:', msg);
                break;

            case 'user_transcript':
                // What the user said (recognized speech)
                if (msg.user_transcript_event?.user_transcript) {
                    lastUserSpeechTime = Date.now();
                    addTranscriptLine(msg.user_transcript_event.user_transcript, 'user');
                }
                break;

            case 'agent_response':
                // Suppress idle chatter (e.g. "Are you there?")
                if (Date.now() - lastUserSpeechTime > IDLE_SUPPRESS_MS) {
                    console.log('Suppressed idle agent response:', msg.agent_response_event?.agent_response);
                    break;
                }
                // The agent's text response (translation)
                if (msg.agent_response_event?.agent_response) {
                    addTranscriptLine(msg.agent_response_event.agent_response, 'agent');
                }
                break;

            case 'audio':
                // Suppress audio when no recent user speech
                if (Date.now() - lastUserSpeechTime > IDLE_SUPPRESS_MS) {
                    break;
                }
                // Audio chunk from agent — decode PCM and play
                if (msg.audio_event?.audio_base_64) {
                    playPcmChunk(msg.audio_event.audio_base_64);
                }
                break;

            case 'interruption':
                // User interrupted the agent
                stopCurrentAudio();
                break;

            case 'ping':
                // Respond to keep-alive and track liveness
                lastPongTime = Date.now();
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                        type: 'pong',
                        event_id: msg.ping_event?.event_id,
                    }));
                }
                break;

            case 'agent_response_correction':
                // Updated transcript
                if (msg.agent_response_correction_event?.corrected_text) {
                    updateLastAgentLine(msg.agent_response_correction_event.corrected_text);
                }
                break;

            default:
                console.log('Agent msg:', msg.type, msg);
        }
    }

    // ---- Audio Capture (Mic → WebSocket) ----
    function startAudioCapture() {
        audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
        sourceNode = audioContext.createMediaStreamSource(mediaStream);

        // Use ScriptProcessorNode for broad compatibility
        const bufferSize = 4096;
        processorNode = audioContext.createScriptProcessor(bufferSize, 1, 1);

        processorNode.onaudioprocess = (e) => {
            if (!isActive || !ws || ws.readyState !== WebSocket.OPEN) return;

            const inputData = e.inputBuffer.getChannelData(0);

            // Convert Float32 to Int16 PCM
            const pcm16 = new Int16Array(inputData.length);
            for (let i = 0; i < inputData.length; i++) {
                const s = Math.max(-1, Math.min(1, inputData[i]));
                pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
            }

            // Convert to base64
            const bytes = new Uint8Array(pcm16.buffer);
            let binary = '';
            for (let i = 0; i < bytes.byteLength; i++) {
                binary += String.fromCharCode(bytes[i]);
            }
            const base64 = btoa(binary);

            // Send to ElevenLabs
            ws.send(JSON.stringify({
                user_audio_chunk: base64,
            }));
        };

        sourceNode.connect(processorNode);
        processorNode.connect(audioContext.destination);
    }

    // ---- Audio Playback via AudioContext (PCM → Speaker) ----
    // ElevenLabs sends base64-encoded 16-bit signed PCM at 16kHz.
    // We decode each chunk, convert Int16→Float32, create an
    // AudioBuffer, and schedule it for gapless playback.

    function playPcmChunk(base64Audio) {
        if (!playbackCtx) return;

        // Update status
        if (!isAgentSpeaking) {
            isAgentSpeaking = true;
            setStatus('speaking', 'Translating…');
        }

        // Decode base64 → Uint8Array → Int16Array
        const binaryString = atob(base64Audio);
        const rawBytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            rawBytes[i] = binaryString.charCodeAt(i);
        }
        const int16 = new Int16Array(rawBytes.buffer);

        // Convert Int16 → Float32 (range -1.0 to 1.0)
        const float32 = new Float32Array(int16.length);
        for (let i = 0; i < int16.length; i++) {
            float32[i] = int16[i] / 32768;
        }

        // Create AudioBuffer
        const audioBuffer = playbackCtx.createBuffer(1, float32.length, AGENT_SAMPLE_RATE);
        audioBuffer.getChannelData(0).set(float32);

        // Schedule for gapless playback
        const source = playbackCtx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(playbackCtx.destination);

        const now = playbackCtx.currentTime;
        const startTime = Math.max(now, nextPlayTime);
        source.start(startTime);
        nextPlayTime = startTime + audioBuffer.duration;

        // Track this source so we can stop it on interruption
        scheduledSources.push(source);
        source.onended = () => {
            scheduledSources = scheduledSources.filter(s => s !== source);
            // If no more sources are queued, agent is done speaking
            if (scheduledSources.length === 0) {
                isAgentSpeaking = false;
                setStatus('active', 'Listening…');
            }
        };
    }

    function stopCurrentAudio() {
        // Stop all scheduled audio sources
        scheduledSources.forEach(s => {
            try { s.stop(); } catch (_) { /* already stopped */ }
        });
        scheduledSources = [];
        nextPlayTime = 0;
        isAgentSpeaking = false;
    }

    // ---- Stop Session (user-initiated) ----
    function stopSession() {
        isActive = false;

        // Cancel any pending reconnect
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        stopWatchdog();

        // Close WebSocket
        if (ws) {
            ws.close();
            ws = null;
        }

        // Stop mic capture
        if (processorNode) {
            processorNode.disconnect();
            processorNode = null;
        }
        if (sourceNode) {
            sourceNode.disconnect();
            sourceNode = null;
        }
        if (audioContext) {
            audioContext.close();
            audioContext = null;
        }
        if (mediaStream) {
            mediaStream.getTracks().forEach(t => t.stop());
            mediaStream = null;
        }

        // Stop playback
        stopCurrentAudio();
        if (playbackCtx) {
            playbackCtx.close();
            playbackCtx = null;
        }

        reconnectAttempts = 0;
        resetControls();
        setStatus('idle', 'Ready');
        addTranscriptLine('⏹ Session ended', 'system');
    }

    // ---- UI Helpers ----
    function resetControls() {
        startBtn.disabled = false;
        startBtn.querySelector('.btn-label').textContent = 'Start';
        startBtn.classList.remove('active');
        langFromSelect.disabled = false;
        langToSelect.disabled = false;
        genderBtns.forEach(b => b.disabled = false);
    }

    function setStatus(state, text) {
        statusDot.className = 'status-dot ' + state;
        statusText.textContent = text;
    }

    function addTranscriptLine(text, type) {
        const empty = document.getElementById('transcript-empty');
        if (empty) empty.style.display = 'none';

        // Show column headers on first real message
        const colHeaders = document.getElementById('col-headers');
        if (colHeaders) colHeaders.style.display = '';

        if (type === 'user') {
            // Create a new two-column row: source on left, translation pending on right
            const row = document.createElement('div');
            row.className = 'msg-row';

            const sourceCell = document.createElement('div');
            sourceCell.className = 'msg-cell is-source col-from';
            sourceCell.textContent = text;

            const transCell = document.createElement('div');
            transCell.className = 'msg-cell is-translation col-to empty';
            transCell.textContent = '…';

            row.appendChild(sourceCell);
            row.appendChild(transCell);
            transcript.appendChild(row);
            pendingRow = row;
        } else if (type === 'agent') {
            // Fill the translation cell in the pending row
            if (pendingRow) {
                const transCell = pendingRow.querySelector('.msg-cell.is-translation');
                if (transCell) {
                    transCell.textContent = text;
                    transCell.classList.remove('empty');
                }
                pendingRow = null;
            } else {
                // No pending row — create a standalone row with translation on right
                const row = document.createElement('div');
                row.className = 'msg-row';
                const emptyCell = document.createElement('div');
                emptyCell.className = 'msg-cell is-source col-from empty';
                emptyCell.textContent = '';
                const transCell = document.createElement('div');
                transCell.className = 'msg-cell is-translation col-to';
                transCell.textContent = text;
                row.appendChild(emptyCell);
                row.appendChild(transCell);
                transcript.appendChild(row);
            }
        } else {
            // System / error — full-width line
            const div = document.createElement('div');
            div.className = `transcript-line ${type}`;
            div.textContent = text;
            transcript.appendChild(div);
        }
        transcript.scrollTop = transcript.scrollHeight;
    }

    function updateLastAgentLine(text) {
        const rows = transcript.querySelectorAll('.msg-row');
        if (rows.length > 0) {
            const lastRow = rows[rows.length - 1];
            const transCell = lastRow.querySelector('.msg-cell.is-translation');
            if (transCell) {
                transCell.textContent = text;
                transCell.classList.remove('empty');
            }
        }
    }

})();
