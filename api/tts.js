// Vercel Serverless Function — ElevenLabs TTS proxy
// ELEVENLABS_API_KEY is set in Vercel environment variables (never in client code)

// ElevenLabs Multilingual v2 voice — "Aria" (warm, natural female)
// Handles all 16 VoiceBridge languages natively
const DEFAULT_VOICE_ID = '9BWtsMINqrJLrRacOk9x';

// Map BCP-47 tts codes → ElevenLabs language_code (ISO 639-1 + region)
// Only needed when the BCP-47 tag differs from what ElevenLabs expects
const LANG_MAP = {
    'en-US': 'en',
    'vi-VN': 'vi',
    'es-ES': 'es',
    'fr-FR': 'fr',
    'de-DE': 'de',
    'it-IT': 'it',
    'pt-BR': 'pt',
    'nl-NL': 'nl',
    'ru-RU': 'ru',
    'uk-UA': 'uk',
    'ar-SA': 'ar',
    'hi-IN': 'hi',
    'zh-CN': 'zh',
    'ja-JP': 'ja',
    'ko-KR': 'ko',
    'th-TH': 'th',
};

module.exports = async function handler(req, res) {
    // Allow GET (browser audio src) and POST (programmatic)
    if (req.method !== 'GET' && req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // Accept params from query string (GET) or body (POST)
    const params = req.method === 'GET' ? req.query : { ...req.query, ...req.body };
    const { text, lang } = params;

    if (!text || !lang) {
        return res.status(400).json({ error: 'Missing required params: text, lang' });
    }

    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) {
        return res.status(503).json({ error: 'TTS not configured on server' });
    }

    const voiceId = DEFAULT_VOICE_ID;
    const elLang  = LANG_MAP[lang] || lang.slice(0, 2);

    // Clamp text to 5000 chars (ElevenLabs limit)
    const safeText = text.slice(0, 5000);

    try {
        const elRes = await fetch(
            `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
            {
                method: 'POST',
                headers: {
                    'xi-api-key': apiKey,
                    'Content-Type': 'application/json',
                    'Accept': 'audio/mpeg',
                },
                body: JSON.stringify({
                    text: safeText,
                    model_id: 'eleven_multilingual_v2',
                    language_code: elLang,
                    voice_settings: {
                        stability: 0.5,
                        similarity_boost: 0.75,
                        style: 0.0,
                        use_speaker_boost: true,
                    },
                }),
            }
        );

        if (!elRes.ok) {
            const errBody = await elRes.text();
            let errMsg;
            try { errMsg = JSON.parse(errBody)?.detail?.message || errBody; } catch { errMsg = errBody; }
            return res.status(elRes.status).json({ error: errMsg });
        }

        // Stream the MP3 audio back to the client
        const arrayBuffer = await elRes.arrayBuffer();
        const audioBuffer = Buffer.from(arrayBuffer);

        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.send(audioBuffer);

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};
