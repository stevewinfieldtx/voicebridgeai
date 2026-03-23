/* =========================================
   VoiceBridge — Live Translate Mode
   Uses ElevenLabs Conversational AI agent
   for seamless bidirectional translation.
   ========================================= */

(function () {
    'use strict';

    // ---- Language Catalog (same as main app) ----
    const LANGS = [
        { code: 'en',  name: 'English',    flag: '🇺🇸' },
        { code: 'vi',  name: 'Tiếng Việt', flag: '🇻🇳' },
        { code: 'es',  name: 'Español',    flag: '🇪🇸' },
        { code: 'fr',  name: 'Français',   flag: '🇫🇷' },
        { code: 'de',  name: 'Deutsch',    flag: '🇩🇪' },
        { code: 'it',  name: 'Italiano',   flag: '🇮🇹' },
        { code: 'pt',  name: 'Português',  flag: '🇧🇷' },
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

    // ---- State ----
    let ws = null;
    let mediaStream = null;
    let audioContext = null;
    let sourceNode = null;
    let processorNode = null;
    let isActive = false;
    let isAgentSpeaking = false;
    let audioQueue = [];
    let isPlayingAudio = false;

    // ---- Populate Language Selects ----
    LANGS.forEach(lang => {
        langFromSelect.add(new Option(`${lang.flag} ${lang.name}`, lang.code));
        langToSelect.add(new Option(`${lang.flag} ${lang.name}`, lang.code));
    });

    // Load saved preferences
    langFromSelect.value = localStorage.getItem('vb-live-from') || 'en';
    langToSelect.value   = localStorage.getItem('vb-live-to') || 'vi';

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

        try {
            // Step 1: Get signed WebSocket URL from our server
            const resp = await fetch(`/api/agent?from=${from}&to=${to}`);
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

            // Step 3: Connect WebSocket to ElevenLabs
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
                // Audio chunk from agent — queue and play
                if (msg.audio_event?.audio_base_64) {
                    queueAudio(msg.audio_event.audio_base_64);
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

    // ---- Audio Playback (Agent → Speaker) ----
    function queueAudio(base64Audio) {
        audioQueue.push(base64Audio);
        if (!isPlayingAudio) {
            playNextAudio();
        }
    }

    async function playNextAudio() {
        if (audioQueue.length === 0) {
            isPlayingAudio = false;
            isAgentSpeaking = false;
            setStatus('active', 'Listening…');
            return;
        }

        isPlayingAudio = true;
        isAgentSpeaking = true;
        setStatus('speaking', 'Translating…');

        const base64 = audioQueue.shift();

        try {
            // Decode base64 to binary
            const binaryString = atob(base64);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }

            // Try to play as MP3/PCM via Audio element
            const blob = new Blob([bytes], { type: 'audio/mpeg' });
            const url = URL.createObjectURL(blob);
            const audio = new Audio(url);

            audio.onended = () => {
                URL.revokeObjectURL(url);
                playNextAudio();
            };

            audio.onerror = () => {
                URL.revokeObjectURL(url);
                playNextAudio();
            };

            await audio.play();
        } catch (err) {
            console.warn('Audio playback error:', err);
            playNextAudio();
        }
    }

    function stopCurrentAudio() {
        audioQueue = [];
        isPlayingAudio = false;
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

        // Stop mic
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

        stopCurrentAudio();
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
