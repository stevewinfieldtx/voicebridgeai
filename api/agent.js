/* =========================================
   TalkBridge — ElevenLabs Agent API
   GET /api/agent?from=en&to=vi
   Creates (or reuses) an ElevenLabs Conversational AI agent
   configured as a strict translator, then returns a signed
   WebSocket URL the client can connect to directly.
   ========================================= */

// In-memory cache: "en|vi" → { agentId, createdAt }
const agentCache = {};
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes — agents are config, not sessions

const LANGUAGE_NAMES = {
    en: 'English', vi: 'Vietnamese', es: 'Spanish', fr: 'French',
    de: 'German', it: 'Italian', pt: 'Portuguese', nl: 'Dutch',
    ru: 'Russian', uk: 'Ukrainian', ar: 'Arabic', hi: 'Hindi',
    zh: 'Chinese', ja: 'Japanese', ko: 'Korean', th: 'Thai',
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

    const from   = req.query.from   || 'en';
    const to     = req.query.to     || 'vi';
    const gender = req.query.gender === 'male' ? 'male' : 'female';

    // ElevenLabs multilingual voice IDs
    const VOICE_ID = gender === 'male'
        ? 'nPczCjzI2devNBz1zQrb'   // Brian — natural US male
        : 'EXAVITQu4vr4xnSDxMaL';  // Aria  — natural US female

    if (!LANGUAGE_NAMES[from] || !LANGUAGE_NAMES[to]) {
        return res.status(400).json({ error: 'Unsupported language code' });
    }

    const cacheKey = `${from}|${to}|${gender}`;
    const langA = LANGUAGE_NAMES[from];
    const langB = LANGUAGE_NAMES[to];

    try {
        // Step 1: Get or create agent
        let agentId = getCachedAgent(cacheKey);

        if (!agentId) {
            agentId = await createAgent(API_KEY, from, to, langA, langB, VOICE_ID);
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

async function createAgent(apiKey, fromCode, toCode, langA, langB, voiceId) {
    const systemPrompt = `ROLE: Translation Machine
TYPE: Strict bidirectional voice translator
PAIR: ${langA} ↔ ${langB}
MODE: Translate only. Never converse.

─── HARD RULES (violating any rule is a critical failure) ───

1. DETECT the input language, then OUTPUT the translation in the OTHER language.
   • ${langA} input → ${langB} output.
   • ${langB} input → ${langA} output.

2. OUTPUT = translated sentence ONLY. Nothing before it, nothing after it.

3. NEVER output in the SAME language as the input. If someone speaks ${langA}, your entire response must be in ${langB}. If someone speaks ${langB}, your entire response must be in ${langA}.

4. NEVER repeat, echo, or parrot back the original words. Your output must be the translation, not a copy.

5. Keep the original meaning, tone, and register. Translate naturally — not word-for-word.

6. If you hear a greeting like "hello" in ${langA}, translate it to the equivalent greeting in ${langB}. Do NOT reply with a greeting in ${langA}. Do NOT add anything beyond the translation.

─── FORBIDDEN (never do any of these) ───

• Do NOT answer questions — translate them.
• Do NOT hold a conversation — translate what is said.
• Do NOT add commentary, explanations, or notes.
• Do NOT say phrases like: "Sure!", "Here is the translation", "Of course", "Let me translate that", "I'd be happy to help".
• Do NOT ask the user anything — no "How can I help you?", no "Are you still there?", no "What would you like to translate?".
• Do NOT speak when there is silence. Wait quietly.
• Do NOT generate any text that was not a direct translation of user speech.
• Do NOT prepend or append the original text to your translation.

─── EXAMPLES ───

User (${langA}): "Where is the nearest hospital?"
You: [translation of that sentence in ${langB}]

User (${langB}): [a sentence in ${langB}]
You: [translation of that sentence in ${langA}]

User: [silence]
You: [silence — say nothing]

REMEMBER: You are a translation machine, not an assistant. Translate everything. Answer nothing. Add nothing.`;

    const body = {
        name: `TalkBridge TX: ${langA} ↔ ${langB}`,
        conversation_config: {
            agent: {
                prompt: {
                    prompt: systemPrompt,
                    temperature: 0.1,
                },
                first_message: '',
                language: fromCode,
            },
            turn: {
                mode: 'turn',
                silence_end_call_timeout: 600,
            },
            tts: {
                voice_id: voiceId,
                model_id: 'eleven_flash_v2_5',
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
