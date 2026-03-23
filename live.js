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

        setStatus('connecting', 'Connecting…');
        startBtn.disabled = true;
        langFromSelect.disabled = true;
        langToSelect.disabled = true;
        genderBtns.forEach(b => b.disabled = true);

        try {
            // Step 1: Get signed WebSocket URL from our server
        const resp = await fetch(`/api/agent?from=${from}&to=${to}&gender=${selectedGender}`);
            if (!resp.ok) {
                const err = await resp.json();
                throw new Error(err.error || 'Server error');
            }
            const { signedUrl, languages } = await resp.json();

            addTranscriptLine(`🔗 Agent ready: ${languages.a} ↔ ${languages.b}`, 'system');

            // Step 2: Get microphone access
            mediaStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    sampleRate: 16000,
                    channelCount: 1,
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                },
            });

            // Step 3: Create playback audio context
            playbackCtx = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: AGENT_SAMPLE_RATE,
            });
            nextPlayTime = 0;

            // Step 4: Connect WebSocket to ElevenLabs
            connectWebSocket(signedUrl);

        } catch (err) {
            console.error('Start error:', err);
            addTranscriptLine(`❌ ${err.message}`, 'error');
            setStatus('error', 'Failed');
            resetControls();
        }
    }

    // ---- WebSocket Connection ----
    function connectWebSocket(url) {
        ws = new WebSocket(url);

        ws.onopen = () => {
            setStatus('active', 'Listening…');
            isActive = true;
            startBtn.disabled = false;
            startBtn.querySelector('.btn-label').textContent = 'Stop';
            startBtn.classList.add('active');
            startAudioCapture();
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
            addTranscriptLine('⚠️ Connection error', 'error');
        };

        ws.onclose = (event) => {
            console.log('WS closed:', event.code, event.reason);
            if (isActive) {
                addTranscriptLine('🔌 Connection closed', 'system');
                stopSession();
            }
        };
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
                    addTranscriptLine(msg.user_transcript_event.user_transcript, 'user');
                }
                break;

            case 'agent_response':
                // The agent's text response (translation)
                if (msg.agent_response_event?.agent_response) {
                    addTranscriptLine(msg.agent_response_event.agent_response, 'agent');
                }
                break;

            case 'audio':
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
                // Respond to keep-alive
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

    // ---- Stop Session ----
    function stopSession() {
        isActive = false;

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
        const div = document.createElement('div');
        div.className = `transcript-line ${type}`;

        const prefix = type === 'user' ? '🗣️ ' :
                       type === 'agent' ? '🌐 ' : '';
        div.textContent = prefix + text;
        transcript.appendChild(div);
        transcript.scrollTop = transcript.scrollHeight;
    }

    function updateLastAgentLine(text) {
        const lines = transcript.querySelectorAll('.transcript-line.agent');
        if (lines.length > 0) {
            lines[lines.length - 1].textContent = '🌐 ' + text;
        }
    }

})();
