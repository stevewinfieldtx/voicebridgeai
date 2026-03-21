// Vercel Serverless Function — Google Cloud TTS proxy
// GOOGLE_API_KEY is set in Vercel environment variables (never in client code)

// Best available Neural2 / WaveNet voice per language
const VOICE_MAP = {
    'en-US': 'en-US-Neural2-F',
    'vi-VN': 'vi-VN-Wavenet-A',
    'es-ES': 'es-ES-Neural2-A',
    'fr-FR': 'fr-FR-Neural2-A',
    'de-DE': 'de-DE-Neural2-A',
    'it-IT': 'it-IT-Neural2-A',
    'pt-BR': 'pt-BR-Neural2-A',
    'nl-NL': 'nl-NL-Wavenet-A',
    'ru-RU': 'ru-RU-Wavenet-A',
    'uk-UA': 'uk-UA-Wavenet-A',
    'ar-SA': 'ar-XA-Wavenet-A',
    'hi-IN': 'hi-IN-Neural2-A',
    'zh-CN': 'cmn-CN-Wavenet-A',
    'ja-JP': 'ja-JP-Neural2-B',
    'ko-KR': 'ko-KR-Neural2-A',
    'th-TH': 'th-TH-Neural2-C',
};

module.exports = async function handler(req, res) {
    // Only allow GET
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { text, lang, rate } = req.query;

    if (!text || !lang) {
        return res.status(400).json({ error: 'Missing required params: text, lang' });
    }

    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) {
        return res.status(503).json({ error: 'TTS not configured on server' });
    }

    const voiceName  = VOICE_MAP[lang];
    const speakRate  = Math.min(Math.max(parseFloat(rate) || 1.0, 0.25), 4.0);

    const body = {
        input: { text },
        voice: {
            languageCode: lang,
            ...(voiceName
                ? { name: voiceName }
                : { ssmlGender: 'FEMALE' }),
        },
        audioConfig: {
            audioEncoding: 'MP3',
            speakingRate: speakRate,
        },
    };

    try {
        const gRes = await fetch(
            `https://texttospeech.googleapis.com/v1/text:synthesize?key=${apiKey}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            }
        );

        const data = await gRes.json();

        if (!gRes.ok) {
            return res.status(gRes.status).json({ error: data.error?.message || 'Google TTS error' });
        }

        const audioBuffer = Buffer.from(data.audioContent, 'base64');
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Cache-Control', 'public, max-age=86400'); // cache identical phrases for 1 day
        res.send(audioBuffer);

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};
