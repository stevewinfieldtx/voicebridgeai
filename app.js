/* =========================================
   VoiceBridge — Two-Column Split Layout
   English always left, Vietnamese always right
   ========================================= */

(function () {
    'use strict';

    // ---- Feature Detection ----
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
        document.getElementById('browser-warning').style.display = 'flex';
    }

    // ---- State ----
    let direction = 'en-vi'; // 'en-vi' or 'vi-en'
    let isListening = false;
    let recognition = null;
    let ttsUnlocked = false; // iOS Safari requires TTS to be triggered from a user gesture first

    // ---- Voice Settings State ----
    const voicePrefs = loadVoicePrefs();

    function loadVoicePrefs() {
        try {
            const saved = JSON.parse(localStorage.getItem('vb-voice-prefs'));
            return {
                enVoiceName: saved?.enVoiceName || '',
                viVoiceName: saved?.viVoiceName || '',
                speed: saved?.speed ?? 0.92,
                pitch: saved?.pitch ?? 1,
            };
        } catch {
            return { enVoiceName: '', viVoiceName: '', speed: 0.92, pitch: 1 };
        }
    }

    function saveVoicePrefs() {
        localStorage.setItem('vb-voice-prefs', JSON.stringify(voicePrefs));
    }

    // ---- DOM Elements (populated in init) ----
    let chipEn, chipVi, feedEl, emptyEl, interimBar, interimText, micBtn, clearBtn, statusText;

    // Settings DOM
    let settingsBtn, settingsOverlay, settingsClose;
    let voiceEnSelect, voiceViSelect, previewEnBtn, previewViBtn;
    let speedSlider, pitchSlider, speedValue, pitchValue;

    // ---- Direction Config ----
    const configs = {
        'en-vi': {
            recognitionLang: 'en-US',
            sourceLang: 'en',
            targetLang: 'vi',
            sourceLabel: 'English',
            targetLabel: 'Tiếng Việt',
            sourceFlag: '🇺🇸',
            targetFlag: '🇻🇳',
        },
        'vi-en': {
            recognitionLang: 'vi-VN',
            sourceLang: 'vi',
            targetLang: 'en',
            sourceLabel: 'Tiếng Việt',
            targetLabel: 'English',
            sourceFlag: '🇻🇳',
            targetFlag: '🇺🇸',
        },
    };

    function getConfig() {
        return configs[direction];
    }

    // ---- Direction Toggle ----
    function setDirection(dir) {
        direction = dir;

        // Swap active class between chips
        if (dir === 'en-vi') {
            chipEn.classList.add('active');
            chipVi.classList.remove('active');
        } else {
            chipVi.classList.add('active');
            chipEn.classList.remove('active');
        }

        // Toggle body class for CSS colors
        document.body.classList.toggle('dir-vi', dir === 'vi-en');

        // If currently listening, tear down old instance and restart fresh
        if (isListening) {
            const old = recognition;
            recognition = null;
            isListening = false;
            if (old) { try { old.abort(); } catch (e) { /* ok */ } }

            setTimeout(() => startListening(), 350);
        }
    }

    function swapDirection() {
        setDirection(direction === 'en-vi' ? 'vi-en' : 'en-vi');
    }

    // ---- Translation API ----
    async function translateText(text, fromLang, toLang) {
        const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${fromLang}|${toLang}`;
        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            if (data.responseStatus === 200 && data.responseData) {
                return data.responseData.translatedText;
            }
            throw new Error(data.responseDetails || 'Translation failed');
        } catch (err) {
            console.error('Translation error:', err);
            return `[Error: ${err.message}]`;
        }
    }

    // ---- Text-to-Speech (voice-aware) ----
    function getSelectedVoice(lang) {
        const voices = window.speechSynthesis.getVoices();
        const prefName = lang === 'vi' ? voicePrefs.viVoiceName : voicePrefs.enVoiceName;

        // Try exact match by name
        if (prefName) {
            const exact = voices.find(v => v.name === prefName);
            if (exact) return exact;
        }

        // Fallback: first voice that matches language
        const langCode = lang === 'vi' ? 'vi' : 'en';
        return voices.find(v => v.lang.startsWith(langCode)) || null;
    }

    function speak(text, lang) {
        if (!window.speechSynthesis) return;
        window.speechSynthesis.cancel();

        const utter = new SpeechSynthesisUtterance(text);
        utter.lang = lang === 'vi' ? 'vi-VN' : 'en-US';
        utter.rate = voicePrefs.speed;
        utter.pitch = voicePrefs.pitch;

        const voice = getSelectedVoice(lang);
        if (voice) utter.voice = voice;

        window.speechSynthesis.speak(utter);
    }

    // ---- Voice Settings Panel ----
    function populateVoiceDropdowns() {
        const voices = window.speechSynthesis.getVoices();

        // Categorize voices
        const enVoices = voices.filter(v => v.lang.startsWith('en'));
        const viVoices = voices.filter(v => v.lang.startsWith('vi'));

        fillSelect(voiceEnSelect, enVoices, voicePrefs.enVoiceName, 'English');
        fillSelect(voiceViSelect, viVoices, voicePrefs.viVoiceName, 'Vietnamese');
    }

    function fillSelect(selectEl, voices, savedName, langLabel) {
        selectEl.innerHTML = '';

        if (voices.length === 0) {
            const opt = document.createElement('option');
            opt.textContent = `No ${langLabel} voices available`;
            opt.disabled = true;
            selectEl.appendChild(opt);
            return;
        }

        voices.forEach(v => {
            const opt = document.createElement('option');
            // Build a friendly label: name + (local/remote indicator)
            let label = v.name;
            if (v.localService === false) label += ' ☁️';
            opt.value = v.name;
            opt.textContent = label;
            if (v.name === savedName) opt.selected = true;
            selectEl.appendChild(opt);
        });

        // If nothing was pre-selected, select first
        if (!savedName || !voices.find(v => v.name === savedName)) {
            selectEl.selectedIndex = 0;
        }
    }

    function openSettings() {
        populateVoiceDropdowns();
        // Sync slider values
        speedSlider.value = voicePrefs.speed;
        pitchSlider.value = voicePrefs.pitch;
        speedValue.textContent = voicePrefs.speed.toFixed(2) + '×';
        pitchValue.textContent = voicePrefs.pitch.toFixed(1);

        settingsOverlay.classList.add('open');
    }

    function closeSettings() {
        settingsOverlay.classList.remove('open');
    }

    function previewVoice(lang) {
        const sampleText = lang === 'vi'
            ? 'Xin chào, tôi là trợ lý giọng nói của bạn.'
            : 'Hello, I am your voice assistant.';
        speak(sampleText, lang);
    }

    // ---- Preload voices ----
    if (window.speechSynthesis) {
        window.speechSynthesis.getVoices();
        window.speechSynthesis.onvoiceschanged = () => {
            window.speechSynthesis.getVoices();
            // Re-populate if settings is open
            if (settingsOverlay && settingsOverlay.classList.contains('open')) {
                populateVoiceDropdowns();
            }
        };
    }

    // ---- UI Helpers ----
    function setStatus(text) {
        statusText.textContent = text;
    }

    function showInterim(text) {
        interimBar.style.display = 'flex';
        interimText.textContent = text || 'Listening...';
    }

    function hideInterim() {
        interimBar.style.display = 'none';
        interimText.textContent = '';
    }

    function hideEmptyState() {
        if (emptyEl) emptyEl.style.display = 'none';
    }

    function scrollToBottom() {
        requestAnimationFrame(() => {
            feedEl.scrollTop = feedEl.scrollHeight;
        });
    }

    function escapeHtml(str) {
        const d = document.createElement('div');
        d.textContent = str;
        return d.innerHTML;
    }

    /**
     * Two-column message layout.
     * English text ALWAYS goes in the left cell.
     * Vietnamese text ALWAYS goes in the right cell.
     */
    function addMessage(sourceText, translatedText, cfg) {
        hideEmptyState();

        let enText, viText;
        let enIsSource, viIsSource;

        if (cfg.sourceLang === 'en') {
            enText = sourceText;
            viText = translatedText;
            enIsSource = true;
            viIsSource = false;
        } else {
            viText = sourceText;
            enText = translatedText;
            viIsSource = true;
            enIsSource = false;
        }

        const row = document.createElement('div');
        row.className = 'msg-row';

        const enCell = document.createElement('div');
        enCell.className = `msg-cell col-en ${enIsSource ? 'is-source' : 'is-translation'}`;
        enCell.innerHTML = escapeHtml(enText);

        const viCell = document.createElement('div');
        viCell.className = `msg-cell col-vi ${viIsSource ? 'is-source' : 'is-translation'}`;
        viCell.innerHTML = escapeHtml(viText);

        const translationCell = enIsSource ? viCell : enCell;
        const speakerHTML = `
            <button class="speak-btn" aria-label="Listen" title="Listen">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                    <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8.5v7a4.49 4.49 0 0 0 2.5-3.5zM14 3.23v2.06a6.5 6.5 0 0 1 0 13.42v2.06A8.5 8.5 0 0 0 14 3.23z"/>
                </svg>
            </button>
        `;
        translationCell.innerHTML += speakerHTML;

        row.appendChild(enCell);
        row.appendChild(viCell);

        row.querySelector('.speak-btn').addEventListener('click', () => {
            speak(translatedText, cfg.targetLang);
        });

        feedEl.appendChild(row);
        scrollToBottom();
    }

    // ---- Speech Recognition ----
    function createRecognition() {
        if (!SpeechRecognition) return null;

        const cfg = getConfig();
        const rec = new SpeechRecognition();
        rec.lang = cfg.recognitionLang;
        rec.interimResults = true;
        rec.continuous = true;
        rec.maxAlternatives = 1;

        let finalTranscript = '';

        const isCurrent = () => rec === recognition;

        rec.onstart = () => {
            if (!isCurrent()) return;
            isListening = true;
            micBtn.classList.add('active');
            setStatus('Listening...');
            finalTranscript = '';
        };

        rec.onresult = (event) => {
            if (!isCurrent()) return;

            let interim = '';
            for (let i = event.resultIndex; i < event.results.length; i++) {
                const t = event.results[i][0].transcript;
                if (event.results[i].isFinal) {
                    finalTranscript += t;
                } else {
                    interim += t;
                }
            }

            if (interim) {
                showInterim(interim);
            }

            if (finalTranscript.trim()) {
                const text = finalTranscript.trim();
                finalTranscript = '';
                hideInterim();
                setStatus('Translating...');

                const cfgSnapshot = getConfig();
                translateText(text, cfgSnapshot.sourceLang, cfgSnapshot.targetLang)
                    .then((translated) => {
                        addMessage(text, translated, cfgSnapshot);
                        speak(translated, cfgSnapshot.targetLang);
                        if (isListening) setStatus('Listening...');
                        else setStatus('Ready');
                    });
            }
        };

        rec.onerror = (event) => {
            if (!isCurrent()) return;
            console.warn('Recognition error:', event.error);
            if (event.error === 'not-allowed') {
                setStatus('⚠ Mic denied');
                stopListening();
            } else if (event.error !== 'no-speech') {
                setStatus(`Error: ${event.error}`);
            }
        };

        rec.onend = () => {
            if (!isCurrent()) return;

            if (isListening) {
                try { rec.start(); } catch (e) { /* already started */ }
            } else {
                micBtn.classList.remove('active');
                setStatus('Ready');
                hideInterim();
            }
        };

        return rec;
    }

    function startListening() {
        if (isListening) return;
        recognition = createRecognition();
        if (!recognition) return;
        try {
            recognition.start();
        } catch (e) {
            console.warn('Could not start:', e);
        }
    }

    function stopListening() {
        isListening = false;
        if (recognition) {
            const old = recognition;
            recognition = null;
            try { old.abort(); } catch (e) { /* ok */ }
        }
        micBtn.classList.remove('active');
        setStatus('Ready');
        hideInterim();
    }

    // ---- iOS TTS Unlock ----
    // iOS Safari blocks speechSynthesis.speak() called from async callbacks.
    // Firing a silent utterance on the first user tap unlocks it for the session.
    function unlockTTS() {
        if (ttsUnlocked || !window.speechSynthesis) return;
        ttsUnlocked = true;
        const silent = new SpeechSynthesisUtterance('');
        silent.volume = 0;
        window.speechSynthesis.speak(silent);
    }

    function toggleListening() {
        unlockTTS(); // must be called synchronously inside a user gesture
        if (isListening) stopListening();
        else startListening();
    }

    // ---- Clear ----
    function clearConversation() {
        feedEl.querySelectorAll('.msg-row').forEach(el => el.remove());
        if (emptyEl) emptyEl.style.display = '';
    }

    // ---- Init ----
    function init() {
        chipEn = document.getElementById('chip-en');
        chipVi = document.getElementById('chip-vi');
        feedEl = document.getElementById('conversation-feed');
        emptyEl = document.getElementById('empty-state');
        interimBar = document.getElementById('interim-bar');
        interimText = document.getElementById('interim-text');
        micBtn = document.getElementById('mic-btn');
        clearBtn = document.getElementById('clear-btn');
        statusText = document.getElementById('status-text');

        // Settings DOM
        settingsBtn = document.getElementById('settings-btn');
        settingsOverlay = document.getElementById('settings-overlay');
        settingsClose = document.getElementById('settings-close');
        voiceEnSelect = document.getElementById('voice-en');
        voiceViSelect = document.getElementById('voice-vi');
        previewEnBtn = document.getElementById('preview-en');
        previewViBtn = document.getElementById('preview-vi');
        speedSlider = document.getElementById('voice-speed');
        pitchSlider = document.getElementById('voice-pitch');
        speedValue = document.getElementById('speed-value');
        pitchValue = document.getElementById('pitch-value');

        // QR Share DOM
        const shareBtn   = document.getElementById('share-btn');
        const qrOverlay  = document.getElementById('qr-overlay');
        const qrClose    = document.getElementById('qr-close');
        const openQR  = () => qrOverlay.classList.add('open');
        const closeQR = () => qrOverlay.classList.remove('open');
        shareBtn.addEventListener('click', openQR);
        qrClose.addEventListener('click', closeQR);
        qrOverlay.addEventListener('click', (e) => { if (e.target === qrOverlay) closeQR(); });

        setDirection('en-vi');

        chipEn.addEventListener('click', () => setDirection('en-vi'));
        chipVi.addEventListener('click', () => setDirection('vi-en'));
        micBtn.addEventListener('click', toggleListening);
        clearBtn.addEventListener('click', clearConversation);

        // Settings events
        settingsBtn.addEventListener('click', openSettings);
        settingsClose.addEventListener('click', closeSettings);
        settingsOverlay.addEventListener('click', (e) => {
            if (e.target === settingsOverlay) closeSettings();
        });

        // Voice selection changes
        voiceEnSelect.addEventListener('change', () => {
            voicePrefs.enVoiceName = voiceEnSelect.value;
            saveVoicePrefs();
        });
        voiceViSelect.addEventListener('change', () => {
            voicePrefs.viVoiceName = voiceViSelect.value;
            saveVoicePrefs();
        });

        // Preview buttons
        previewEnBtn.addEventListener('click', () => previewVoice('en'));
        previewViBtn.addEventListener('click', () => previewVoice('vi'));

        // Sliders
        speedSlider.addEventListener('input', () => {
            voicePrefs.speed = parseFloat(speedSlider.value);
            speedValue.textContent = voicePrefs.speed.toFixed(2) + '×';
            saveVoicePrefs();
        });
        pitchSlider.addEventListener('input', () => {
            voicePrefs.pitch = parseFloat(pitchSlider.value);
            pitchValue.textContent = voicePrefs.pitch.toFixed(1);
            saveVoicePrefs();
        });

        // Keyboard: Space = toggle mic, Tab = swap direction, Escape = close settings
        document.addEventListener('keydown', (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;

            if (e.key === 'Escape') {
                if (qrOverlay.classList.contains('open')) { closeQR(); return; }
                if (settingsOverlay.classList.contains('open')) { closeSettings(); return; }
            }
            if (e.code === 'Space') {
                e.preventDefault();
                toggleListening();
            }
            if (e.key === 'Tab') {
                e.preventDefault();
                swapDirection();
            }
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
