// Vercel Serverless Function — OpenAI TTS proxy
// OPENAI_API_KEY is set in Vercel environment variables

module.exports = async function handler(req, res) {
    if (req.method !== 'GET' && req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const params = req.method === 'GET' ? req.query : { ...req.query, ...req.body };
    const { text, lang } = params;

    if (!text || !lang) {
        return res.status(400).json({ error: 'Missing required params: text, lang' });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        return res.status(503).json({ error: 'TTS not configured on server' });
    }

    // Clamp text to 4096 chars (OpenAI TTS limit)
    const safeText = text.slice(0, 4096);

    // Pick voice — OpenAI voices: alloy, ash, ballad, coral, echo, fable,
    // nova, onyx, sage, shimmer. 'nova' is warm and natural.
    const voice = params.voice || 'nova';

    try {
        const oaiRes = await fetch('https://api.openai.com/v1/audio/speech', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: 'tts-1',
                input: safeText,
                voice: voice,
                response_format: 'mp3',
                speed: 1.0,
            }),
        });

        if (!oaiRes.ok) {
            const errBody = await oaiRes.text();
            return res.status(oaiRes.status).json({ error: errBody });
        }

        const arrayBuffer = await oaiRes.arrayBuffer();
        const audioBuffer = Buffer.from(arrayBuffer);

        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.send(audioBuffer);

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};
