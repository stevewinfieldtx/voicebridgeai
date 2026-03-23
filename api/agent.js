/* =========================================
   VoiceBridge — ElevenLabs Agent API
   GET /api/agent?from=en&to=vi
   Creates (or reuses) an ElevenLabs Conversational AI agent
   configured as a strict translator, then returns a signed
   WebSocket URL the client can connect to directly.
   ========================================= */

// In-memory cache: "en|vi" → { agentId, createdAt }
const agentCache = {};
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

const LANGUAGE_NAMES = {
    en: 'English', vi: 'Vietnamese', es: 'Spanish', fr: 'French',
    de: 'German', it: 'Italian', pt: 'Portuguese', nl: 'Dutch',
    ru: 'Russian', uk: 'Ukrainian', ar: 'Arabic', hi: 'Hindi',
    zh: 'Chinese', ja: 'Japanese', ko: 'Korean', th: 'Thai',
};

// Map our language codes to ElevenLabs language codes
const ELEVENLABS_LANG = {
    en: 'en', vi: 'vi', es: 'es', fr: 'fr',
    de: 'de', it: 'it', pt: 'pt', nl: 'nl',
    ru: 'ru', uk: 'uk', ar: 'ar', hi: 'hi',
    zh: 'zh', ja: 'ja', ko: 'ko', th: 'th',
};

module.exports = async (req, res) => {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(204).end();

    const API_KEY = process.env.ELEVENLABS_API_KEY;
    if (!API_KEY) {
        return res.status(500).json({ error: 'ELEVENLABS_API_KEY not configured' });
    }

    const from = req.query.from || 'en';
    const to = req.query.to || 'vi';

    if (!LANGUAGE_NAMES[from] || !LANGUAGE_NAMES[to]) {
        return res.status(400).json({ error: 'Unsupported language code' });
    }

    const cacheKey = `${from}|${to}`;
    const langA = LANGUAGE_NAMES[from];
    const langB = LANGUAGE_NAMES[to];

    try {
        // Step 1: Get or create agent
        let agentId = getCachedAgent(cacheKey);

        if (!agentId) {
            agentId = await createAgent(API_KEY, from, to, langA, langB);
            agentCache[cacheKey] = { agentId, createdAt: Date.now() };
        }

        // Step 2: Get a signed WebSocket URL
        const signedUrl = await getSignedUrl(API_KEY, agentId);

        return res.status(200).json({
            agentId,
            signedUrl,
            from,
            to,
            languages: { a: langA, b: langB },
        });
    } catch (err) {
        console.error('Agent API error:', err);
        // If agent was cached but failed, clear cache and retry once
        if (agentCache[cacheKey]) {
            delete agentCache[cacheKey];
        }
        return res.status(500).json({ error: err.message || 'Failed to create agent' });
    }
};

function getCachedAgent(key) {
    const cached = agentCache[key];
    if (!cached) return null;
    if (Date.now() - cached.createdAt > CACHE_TTL) {
        delete agentCache[key];
        return null;
    }
    return cached.agentId;
}

async function createAgent(apiKey, fromCode, toCode, langA, langB) {
    const systemPrompt = `You are a real-time voice translator. Your ONLY job is to translate between ${langA} and ${langB}.

RULES — follow these strictly:
1. When you hear ${langA}, immediately respond with the ${langB} translation.
2. When you hear ${langB}, immediately respond with the ${langA} translation.
3. ONLY output the translation — nothing else.
4. Do NOT add greetings, commentary, explanations, or filler words.
5. Do NOT say things like "Here is the translation" or "The translation is".
6. Do NOT repeat the original text.
7. Preserve the tone, intent, and meaning of the original speech.
8. If you cannot understand the speech, stay silent.
9. Keep translations natural and conversational, not overly formal.
10. Translate everything — questions, statements, exclamations — exactly as spoken.`;

    const body = {
        name: `VoiceBridge Translator: ${langA} ↔ ${langB}`,
        conversation_config: {
            agent: {
                prompt: {
                    prompt: systemPrompt,
                },
                first_message: '',
                language: ELEVENLABS_LANG[fromCode] || 'en',
            },
            tts: {
                voice_id: 'EXAVITQu4vr4xnSDxMaL',  // "Aria" — warm, natural, multilingual
            },
        },
    };

    const resp = await fetch('https://api.elevenlabs.io/v1/convai/agents/create', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'xi-api-key': apiKey,
        },
        body: JSON.stringify(body),
    });

    if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`ElevenLabs create agent failed (${resp.status}): ${errText}`);
    }

    const data = await resp.json();
    return data.agent_id;
}

async function getSignedUrl(apiKey, agentId) {
    const resp = await fetch(
        `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${agentId}`,
        {
            method: 'GET',
            headers: { 'xi-api-key': apiKey },
        }
    );

    if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`ElevenLabs signed URL failed (${resp.status}): ${errText}`);
    }

    const data = await resp.json();
    return data.signed_url;
}
