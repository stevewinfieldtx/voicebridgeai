/* =========================================
   TalkBridge — Multi-Language Edition
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
    let lastSpokenText = '';   // fingerprint of last TTS output — used to reject echo

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
        // Google Translate free endpoint — strictly translates, never responds conversationally.
        // dt=t returns only translation segments; sl/tl are ISO-639-1 codes.
        const sl  = fromLang.memory.split('-')[0];  // e.g. "en-US" → "en"
        const tl  = toLang.memory.split('-')[0];
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${tl}&dt=t&q=${encodeURIComponent(text)}`;
        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            // Google returns: [ [ ["translated","original",...]  ], ... ]
            const translated = data[0]
                .filter(seg => seg && seg[0])
                .map(seg => seg[0])
                .join('');
            if (!translated) throw new Error('Empty translation');
            return translated;
        } catch (err) {
            console.error('Translation error:', err);
            // Fallback: MyMemory
            try {
                const pair = `${fromLang.memory}|${toLang.memory}`;
                const fb = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${pair}`);
                if (fb.ok) {
                    const d = await fb.json();
                    if (d.responseStatus === 200 && d.responseData?.translatedText) return d.responseData.translatedText;
                }
            } catch (_) { /* ignore fallback errors */ }
            return `[Error: ${err.message}]`;
        }
    }

    // ---- Text-to-Speech (ElevenLabs via /api/tts) ----

    function resumeMicAfterTTS() {
        isSpeaking = false;
        if (isListening) {
            // 1500 ms gives room reverb and speaker ring-down time to fully decay
            // before the mic goes live again — prevents the echo-translate loop.
            setTimeout(() => {
                if (isSpeaking) return; // another TTS started in the meantime
                recognition = createRecognition();
                if (recognition) {
                    try { recognition.start(); } catch (e) { /* ok */ }
                }
            }, 1500);
        }
    }

    // Fuzzy echo guard: returns true if transcript is too similar to what we just spoke.
    // Normalises both strings and checks for substring or high char-overlap.
    function isEchoOfTTS(transcript) {
        if (!lastSpokenText) return false;
        const norm = s => s.toLowerCase().replace(/[^a-z0-9\u00C0-\u024F\u0100-\u017F]/g, ' ').replace(/\s+/g, ' ').trim();
        const a = norm(transcript);
        const b = norm(lastSpokenText);
        if (!a || !b) return false;
        // Substring match
        if (b.includes(a) || a.includes(b)) return true;
        // Character-overlap ratio (rough Jaccard on trigrams)
        const tri = s => new Set([...Array(Math.max(0,s.length-2))].map((_,i)=>s.slice(i,i+3)));
        const tA = tri(a), tB = tri(b);
        if (!tA.size || !tB.size) return false;
        let intersection = 0;
        tA.forEach(t => { if (tB.has(t)) intersection++; });
        const union = tA.size + tB.size - intersection;
        return (intersection / union) >= 0.55;
    }

    function speak(text, ttsCode) {
        // Stop any in-progress TTS
        if (ttsAudio) { ttsAudio.pause(); ttsAudio.src = ''; ttsAudio = null; }
        if (window.speechSynthesis) window.speechSynthesis.cancel();

        if (!text) { isSpeaking = false; return; }

        // Store fingerprint so onresult can reject echoes
        lastSpokenText = text;

        // Kill mic immediately — don't wait for onresult's isSpeaking check
        if (recognition) {
            const old = recognition;
            recognition = null;
            try { old.abort(); } catch (e) { /* ok */ }
        }

        isSpeaking = true;

        // Build server TTS URL
        const params = new URLSearchParams({ text, lang: ttsCode });
        const url = `/api/tts?${params.toString()}`;

        ttsAudio = new Audio(url);
        ttsAudio.onended = resumeMicAfterTTS;
        ttsAudio.onerror = () => {
            // Fallback to browser TTS if server fails
            console.warn('ElevenLabs TTS failed, falling back to browser TTS');
            ttsAudio = null;
            if (window.speechSynthesis) {
                const utter = new SpeechSynthesisUtterance(text);
                utter.lang = ttsCode;
                utter.rate = voicePrefs.speed;
                utter.pitch = voicePrefs.pitch;
                utter.onend = resumeMicAfterTTS;
                utter.onerror = resumeMicAfterTTS;
                window.speechSynthesis.speak(utter);
            } else {
                resumeMicAfterTTS();
            }
        };

        ttsAudio.play().catch(() => {
            // Autoplay blocked or network error — try fallback
            ttsAudio.onerror();
        });
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
        return row;   // return DOM node for tagging
    }

    // ---- Room integration hooks (used by room.js) ----
    // Expose addMessage so room.js can render remote messages
    window._vb = window._vb || {};
    window._vb.addMessage = function (src, tr, fromLang, toLang, opts) {
        const row = addMessage(src, tr, fromLang, toLang);
        if (opts?.remote) row.classList.add('remote-msg');
        return row;
    };
    window._vb.getLang = getLang;
    window._vb.speak = speak;          // room.js uses this for auto-play
    // Hook: called after every local translate+speak so room can broadcast
    window._vb.onLocalMessage = null;   // room.js sets this

    // ---- Speech Recognition ----
    function createRecognition() {
        if (!SpeechRecognition) return null;

        const fromLang = getLang(fromCode);

        const rec = new SpeechRecognition();
        rec.lang = fromLang.recognition;
        rec.interimResults = true;
        rec.continuous = false;   // one utterance per session — avoids result accumulation bug
        rec.maxAlternatives = 1;

        let processed = false;  // guard: only ever translate once per session

        rec.onstart = () => {
            if (rec !== recognition) return;
            isListening = true;
            micBtn.classList.add('active');
            setStatus('Listening...');
        };

        rec.onresult = (event) => {
            if (rec !== recognition) return;
            if (isSpeaking) return;
            if (processed) return;  // already handled this utterance

            // Collect all text first so we can echo-check before deciding to translate
            let allText = '';
            for (let i = 0; i < event.results.length; i++) {
                allText += event.results[i][0].transcript;
            }
            if (isEchoOfTTS(allText)) {
                // This transcript looks like our own TTS output — silently discard
                return;
            }

            let interim = '';
            let finalText = '';
            for (let i = event.resultIndex; i < event.results.length; i++) {
                const t = event.results[i][0].transcript;
                if (event.results[i].isFinal) finalText += t;
                else interim += t;
            }

            if (interim) showInterim(interim);

            if (finalText.trim()) {
                processed = true;   // lock out any further results from this session
                const text = finalText.trim();
                hideInterim();
                setStatus('Translating...');

                // ── IMMEDIATELY kill mic so onend can't restart during async translation ──
                isSpeaking = true;   // block onend from restarting
                if (recognition) {
                    const old = recognition;
                    recognition = null;
                    try { old.abort(); } catch (e) { /* ok */ }
                }

                const snapFrom = getLang(fromCode);
                const snapTo   = getLang(toCode);

                translateText(text, snapFrom, snapTo).then((translated) => {
                    addMessage(text, translated, snapFrom, snapTo);
                    speak(translated, snapTo.tts);   // speak() will resume recognition when done
                    setStatus(isListening ? 'Listening...' : 'Ready');
                    // Broadcast to room if connected
                    if (window._vb.onLocalMessage) {
                        window._vb.onLocalMessage(text, translated, snapFrom.code, snapTo.code);
                    }
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
            // If TTS is playing, don't restart — speak()'s callback will handle it
            if (isSpeaking) return;
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

        // QR Share DOM (optional — QR is embedded in settings panel, no standalone overlay needed)
        const shareBtn  = document.getElementById('share-btn');
        const qrOverlay = document.getElementById('qr-overlay');
        const qrClose   = document.getElementById('qr-close');
        if (shareBtn && qrOverlay && qrClose) {
            const openQR  = () => qrOverlay.classList.add('open');
            const closeQR = () => qrOverlay.classList.remove('open');
            shareBtn.addEventListener('click', openQR);
            qrClose.addEventListener('click', closeQR);
            qrOverlay.addEventListener('click', (e) => { if (e.target === qrOverlay) closeQR(); });
        }

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
                const roomOv = document.getElementById('room-overlay');
                if (roomOv && roomOv.classList.contains('open')) { roomOv.classList.remove('open'); return; }
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
