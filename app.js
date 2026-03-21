/* =========================================
   VoiceBridge — Multi-Language Edition
   ========================================= */

(function () {
    'use strict';

    // ---- Feature Detection ----
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
        document.getElementById('browser-warning').style.display = 'flex';
    }

    // ---- Language Catalog ----
    // recognition: BCP-47 tag for Web Speech API
    // tts:         BCP-47 tag for speechSynthesis
    // memory:      langpair code for MyMemory API
    const LANGS = [
        { code: 'en',  name: 'English',    flag: '🇺🇸', recognition: 'en-US', tts: 'en-US', memory: 'en' },
        { code: 'vi',  name: 'Tiếng Việt', flag: '🇻🇳', recognition: 'vi-VN', tts: 'vi-VN', memory: 'vi' },
        { code: 'es',  name: 'Español',    flag: '🇪🇸', recognition: 'es-ES', tts: 'es-ES', memory: 'es' },
        { code: 'fr',  name: 'Français',   flag: '🇫🇷', recognition: 'fr-FR', tts: 'fr-FR', memory: 'fr' },
        { code: 'de',  name: 'Deutsch',    flag: '🇩🇪', recognition: 'de-DE', tts: 'de-DE', memory: 'de' },
        { code: 'it',  name: 'Italiano',   flag: '🇮🇹', recognition: 'it-IT', tts: 'it-IT', memory: 'it' },
        { code: 'pt',  name: 'Português',  flag: '🇧🇷', recognition: 'pt-BR', tts: 'pt-BR', memory: 'pt' },
        { code: 'nl',  name: 'Nederlands', flag: '🇳🇱', recognition: 'nl-NL', tts: 'nl-NL', memory: 'nl' },
        { code: 'ru',  name: 'Русский',    flag: '🇷🇺', recognition: 'ru-RU', tts: 'ru-RU', memory: 'ru' },
        { code: 'uk',  name: 'Українська', flag: '🇺🇦', recognition: 'uk-UA', tts: 'uk-UA', memory: 'uk' },
        { code: 'ar',  name: 'العربية',    flag: '🇸🇦', recognition: 'ar-SA', tts: 'ar-SA', memory: 'ar' },
        { code: 'hi',  name: 'हिन्दी',     flag: '🇮🇳', recognition: 'hi-IN', tts: 'hi-IN', memory: 'hi' },
        { code: 'zh',  name: '中文',        flag: '🇨🇳', recognition: 'zh-CN', tts: 'zh-CN', memory: 'zh-CN' },
        { code: 'ja',  name: '日本語',      flag: '🇯🇵', recognition: 'ja-JP', tts: 'ja-JP', memory: 'ja' },
        { code: 'ko',  name: '한국어',      flag: '🇰🇷', recognition: 'ko-KR', tts: 'ko-KR', memory: 'ko' },
        { code: 'th',  name: 'ภาษาไทย',    flag: '🇹🇭', recognition: 'th-TH', tts: 'th-TH', memory: 'th' },
    ];

    function getLang(code) {
        return LANGS.find(l => l.code === code) || LANGS[0];
    }

    // ---- State ----
    let fromCode = 'en';
    let toCode   = 'vi';
    let isListening = false;
    let isSpeaking  = false;   // true while TTS audio plays — suppresses mic echo
    let recognition = null;
    let ttsUnlocked = false;
    let ttsAudio = null;

    // ---- Voice Settings State ----
    const voicePrefs = loadVoicePrefs();

    function loadVoicePrefs() {
        try {
            const saved = JSON.parse(localStorage.getItem('vb-voice-prefs'));
            return {
                speed: saved?.speed ?? 0.92,
                pitch: saved?.pitch ?? 1,
            };
        } catch {
            return { speed: 0.92, pitch: 1 };
        }
    }

    function saveVoicePrefs() {
        localStorage.setItem('vb-voice-prefs', JSON.stringify(voicePrefs));
    }

    // ---- DOM Elements (populated in init) ----
    let langFromSelect, langToSelect, langSwapBtn, chipA, chipB;
    let colFromHeader, colToHeader;
    let feedEl, emptyEl, interimBar, interimText, micBtn, clearBtn, statusText;
    let settingsBtn, settingsOverlay, settingsClose;
    let speedSlider, pitchSlider, speedValue, pitchValue;

    // ---- Language Setup ----
    function setLanguages(from, to) {
        // Prevent same language on both sides
        if (from === to) {
            // Swap the other side to something different
            const fallback = LANGS.find(l => l.code !== from);
            if (from === fromCode) to = fallback.code;
            else from = fallback.code;
        }

        fromCode = from;
        toCode   = to;

        // Sync selects
        if (langFromSelect) langFromSelect.value = from;
        if (langToSelect)   langToSelect.value   = to;

        // Update direction chips
        updateChips();

        // Update column headers
        const fromLang = getLang(from);
        const toLang   = getLang(to);
        if (colFromHeader) colFromHeader.textContent = `${fromLang.flag} ${fromLang.name}`;
        if (colToHeader)   colToHeader.textContent   = `${toLang.flag} ${toLang.name}`;

        // Restart recognition if listening
        if (isListening) {
            const old = recognition;
            recognition = null;
            isListening = false;
            if (old) { try { old.abort(); } catch (e) { /* ok */ } }
            setTimeout(() => startListening(), 350);
        }
    }

    function updateChips() {
        if (!chipA || !chipB) return;
        const fromLang = getLang(fromCode);
        const toLang   = getLang(toCode);
        document.getElementById('chip-a-flag').textContent  = fromLang.flag;
        document.getElementById('chip-a-label').textContent = fromLang.name;
        document.getElementById('chip-b-flag').textContent  = toLang.flag;
        document.getElementById('chip-b-label').textContent = toLang.name;
        chipA.classList.add('active');
        chipB.classList.remove('active');
    }

    async function translateText(text, fromLang, toLang) {
        const pair = `${fromLang.memory}|${toLang.memory}`;
        const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${pair}`;
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

    // ---- Text-to-Speech ----
    // Tier 1: Google Cloud TTS via /api/tts (Vercel, key stays server-side)
    // Tier 2: Google Translate TTS (free, unofficial, client-side)
    // Tier 3: Native Web Speech API (offline fallback)

    function speak(text, ttsCode) {
        if (ttsAudio) { ttsAudio.pause(); ttsAudio.src = ''; ttsAudio = null; }
        if (window.speechSynthesis) window.speechSynthesis.cancel();
        isSpeaking = true;
        speakCloudTTS(text, ttsCode);
    }

    // Tier 1 — Google Cloud TTS via Vercel serverless proxy
    function speakCloudTTS(text, ttsCode) {
        const params = new URLSearchParams({ text, lang: ttsCode, rate: voicePrefs.speed });
        ttsAudio = new Audio(`/api/tts?${params}`);
        ttsAudio.onended = () => { isSpeaking = false; };
        ttsAudio.onerror = () => {
            console.warn('Cloud TTS unavailable, trying Google Translate TTS');
            speakGTTS(text, ttsCode);
        };
        ttsAudio.play().catch(() => speakGTTS(text, ttsCode));
    }

    // Tier 2 — Google Translate TTS (unofficial, ~200 char limit)
    function gttsCode(ttsTag) {
        const keepFull = ['zh-CN', 'zh-TW', 'pt-BR'];
        return keepFull.includes(ttsTag) ? ttsTag : ttsTag.split('-')[0];
    }

    function speakGTTS(text, ttsCode) {
        if (text.length > 200) { speakNative(text, ttsCode); return; }
        const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=${gttsCode(ttsCode)}&client=gtx`;
        ttsAudio = new Audio(url);
        ttsAudio.playbackRate = voicePrefs.speed;
        ttsAudio.onended = () => { isSpeaking = false; };
        ttsAudio.onerror = () => {
            console.warn('Google TTS failed, using native');
            speakNative(text, ttsCode);
        };
        ttsAudio.play().catch(() => speakNative(text, ttsCode));
    }

    // Tier 3 — Native Web Speech API
    function getBestVoice(ttsCode) {
        const voices = window.speechSynthesis.getVoices();
        return (
            voices.find(v => v.name.toLowerCase().includes('google') && v.lang === ttsCode) ||
            voices.find(v => v.lang === ttsCode) ||
            voices.find(v => v.lang.startsWith(ttsCode.slice(0, 2))) ||
            null
        );
    }

    function speakNative(text, ttsCode) {
        if (!window.speechSynthesis) { isSpeaking = false; return; }
        const utter = new SpeechSynthesisUtterance(text);
        utter.lang  = ttsCode;
        utter.rate  = voicePrefs.speed;
        utter.pitch = voicePrefs.pitch;
        const voice = getBestVoice(ttsCode);
        if (voice) utter.voice = voice;
        utter.onend   = () => { isSpeaking = false; };
        utter.onerror = () => { isSpeaking = false; };
        window.speechSynthesis.speak(utter);
    }

    // ---- Voice Settings Panel ----
    function openSettings() {
        speedSlider.value = voicePrefs.speed;
        pitchSlider.value = voicePrefs.pitch;
        speedValue.textContent = voicePrefs.speed.toFixed(2) + '×';
        pitchValue.textContent = voicePrefs.pitch.toFixed(1);
        settingsOverlay.classList.add('open');
    }

    function closeSettings() {
        settingsOverlay.classList.remove('open');
    }

    // ---- Preload voices ----
    if (window.speechSynthesis) {
        window.speechSynthesis.getVoices();
        window.speechSynthesis.onvoiceschanged = () => {
            window.speechSynthesis.getVoices();
        };
    }

    // ---- UI Helpers ----
    function setStatus(text) { statusText.textContent = text; }

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

    function scrollToTop() {
        requestAnimationFrame(() => { feedEl.scrollTop = 0; });
    }

    function escapeHtml(str) {
        const d = document.createElement('div');
        d.textContent = str;
        return d.innerHTML;
    }

    /**
     * Two-column message layout.
     * Left column = "from" language (source), Right column = "to" language (translation).
     * Each row shows both; speak button plays the translation.
     */
    function addMessage(sourceText, translatedText, fromLang, toLang) {
        hideEmptyState();

        const row = document.createElement('div');
        row.className = 'msg-row';

        const fromCell = document.createElement('div');
        fromCell.className = 'msg-cell col-en is-source';
        fromCell.innerHTML = escapeHtml(sourceText);

        const toCell = document.createElement('div');
        toCell.className = 'msg-cell col-vi is-translation';
        toCell.innerHTML = escapeHtml(translatedText);

        const speakerHTML = `
            <button class="speak-btn" aria-label="Listen" title="Listen">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                    <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8.5v7a4.49 4.49 0 0 0 2.5-3.5zM14 3.23v2.06a6.5 6.5 0 0 1 0 13.42v2.06A8.5 8.5 0 0 0 14 3.23z"/>
                </svg>
            </button>
        `;
        toCell.innerHTML += speakerHTML;

        row.appendChild(fromCell);
        row.appendChild(toCell);

        row.querySelector('.speak-btn').addEventListener('click', () => {
            speak(translatedText, toLang.tts);
        });

        feedEl.prepend(row);
        scrollToTop();
    }

    // ---- Speech Recognition ----
    function createRecognition() {
        if (!SpeechRecognition) return null;

        const fromLang = getLang(fromCode);

        const rec = new SpeechRecognition();
        rec.lang = fromLang.recognition;
        rec.interimResults = true;
        rec.continuous = false;   // one utterance per session — avoids result accumulation bug
        rec.maxAlternatives = 1;

        rec.onstart = () => {
            if (rec !== recognition) return;
            isListening = true;
            micBtn.classList.add('active');
            setStatus('Listening...');
        };

        rec.onresult = (event) => {
            if (rec !== recognition) return;
            // Ignore anything the mic picks up while TTS is playing (echo suppression)
            if (isSpeaking) return;

            let interim = '';
            let finalText = '';
            for (let i = event.resultIndex; i < event.results.length; i++) {
                const t = event.results[i][0].transcript;
                if (event.results[i].isFinal) finalText += t;
                else interim += t;
            }

            if (interim) showInterim(interim);

            if (finalText.trim()) {
                const text = finalText.trim();
                hideInterim();
                setStatus('Translating...');

                const snapFrom = getLang(fromCode);
                const snapTo   = getLang(toCode);

                translateText(text, snapFrom, snapTo).then((translated) => {
                    addMessage(text, translated, snapFrom, snapTo);
                    speak(translated, snapTo.tts);
                    setStatus(isListening ? 'Listening...' : 'Ready');
                });
            }
        };

        rec.onerror = (event) => {
            if (rec !== recognition) return;
            console.warn('Recognition error:', event.error);
            if (event.error === 'not-allowed') {
                setStatus('⚠ Mic denied');
                stopListening();
            } else if (event.error !== 'no-speech') {
                setStatus(`Error: ${event.error}`);
            }
        };

        rec.onend = () => {
            if (rec !== recognition) return;
            if (isListening) {
                // Fresh instance each time — prevents Chrome replaying accumulated results
                recognition = createRecognition();
                if (recognition) {
                    try { recognition.start(); } catch (e) { /* ok */ }
                }
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
        try { recognition.start(); } catch (e) { console.warn('Could not start:', e); }
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
    function unlockTTS() {
        if (ttsUnlocked || !window.speechSynthesis) return;
        ttsUnlocked = true;
        const silent = new SpeechSynthesisUtterance('');
        silent.volume = 0;
        window.speechSynthesis.speak(silent);
    }

    function toggleListening() {
        unlockTTS();
        if (isListening) stopListening();
        else startListening();
    }

    // ---- Clear ----
    function clearConversation() {
        feedEl.querySelectorAll('.msg-row').forEach(el => el.remove());
        if (emptyEl) emptyEl.style.display = '';
    }

    // ---- Populate Language Selects ----
    function buildLangOptions(selectEl) {
        selectEl.innerHTML = '';
        LANGS.forEach(lang => {
            const opt = document.createElement('option');
            opt.value = lang.code;
            opt.textContent = `${lang.flag} ${lang.name}`;
            selectEl.appendChild(opt);
        });
    }

    // ---- Init ----
    function init() {
        langFromSelect = document.getElementById('lang-from');
        langToSelect   = document.getElementById('lang-to');
        langSwapBtn    = document.getElementById('lang-swap');
        chipA          = document.getElementById('chip-a');
        chipB          = document.getElementById('chip-b');
        colFromHeader  = document.getElementById('col-from-header');
        colToHeader    = document.getElementById('col-to-header');

        feedEl     = document.getElementById('conversation-feed');
        emptyEl    = document.getElementById('empty-state');
        interimBar = document.getElementById('interim-bar');
        interimText = document.getElementById('interim-text');
        micBtn     = document.getElementById('mic-btn');
        clearBtn   = document.getElementById('clear-btn');
        statusText = document.getElementById('status-text');

        // Settings DOM
        settingsBtn     = document.getElementById('settings-btn');
        settingsOverlay = document.getElementById('settings-overlay');
        settingsClose   = document.getElementById('settings-close');
        speedSlider     = document.getElementById('voice-speed');
        pitchSlider     = document.getElementById('voice-pitch');
        speedValue      = document.getElementById('speed-value');
        pitchValue      = document.getElementById('pitch-value');

        // QR Share DOM
        const shareBtn  = document.getElementById('share-btn');
        const qrOverlay = document.getElementById('qr-overlay');
        const qrClose   = document.getElementById('qr-close');
        const openQR    = () => qrOverlay.classList.add('open');
        const closeQR   = () => qrOverlay.classList.remove('open');
        shareBtn.addEventListener('click', openQR);
        qrClose.addEventListener('click', closeQR);
        qrOverlay.addEventListener('click', (e) => { if (e.target === qrOverlay) closeQR(); });

        // Build language dropdowns
        buildLangOptions(langFromSelect);
        buildLangOptions(langToSelect);

        // Set initial languages (restore from localStorage if available)
        const saved = JSON.parse(localStorage.getItem('vb-lang-pair') || 'null');
        const initFrom = saved?.from || 'en';
        const initTo   = saved?.to   || 'vi';
        setLanguages(initFrom, initTo);

        // Language select events
        langFromSelect.addEventListener('change', () => {
            let newFrom = langFromSelect.value;
            // If same as toCode, automatically swap to
            if (newFrom === toCode) {
                const swap = fromCode; // use the old fromCode as the new to
                setLanguages(newFrom, swap);
            } else {
                setLanguages(newFrom, toCode);
            }
            saveLangPair();
        });

        langToSelect.addEventListener('change', () => {
            let newTo = langToSelect.value;
            if (newTo === fromCode) {
                const swap = toCode; // use the old toCode as the new from
                setLanguages(swap, newTo);
            } else {
                setLanguages(fromCode, newTo);
            }
            saveLangPair();
        });

        if (langSwapBtn) langSwapBtn.addEventListener('click', () => {
            setLanguages(toCode, fromCode);
            saveLangPair();
        });

        micBtn.addEventListener('click', toggleListening);
        clearBtn.addEventListener('click', clearConversation);

        // Chip-b tap = swap direction (Language B becomes the speaker)
        if (chipB) chipB.addEventListener('click', () => {
            setLanguages(toCode, fromCode);
            saveLangPair();
        });
        // Chip-a tap = re-confirm current speaker (pulse animation)
        if (chipA) chipA.addEventListener('click', () => {
            chipA.style.transform = 'scale(0.96)';
            setTimeout(() => { chipA.style.transform = ''; }, 150);
        });

        // Settings events
        settingsBtn.addEventListener('click', openSettings);
        settingsClose.addEventListener('click', closeSettings);
        settingsOverlay.addEventListener('click', (e) => {
            if (e.target === settingsOverlay) closeSettings();
        });

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

        // Keyboard: Space = toggle mic, Tab = swap languages, Escape = close panels
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
                setLanguages(toCode, fromCode);
                saveLangPair();
            }
        });
    }

    function saveLangPair() {
        localStorage.setItem('vb-lang-pair', JSON.stringify({ from: fromCode, to: toCode }));
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
