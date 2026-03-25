/* =========================================
   TalkBridge — ElevenLabs Agent API
   GET /api/agent?from=en&to=vi&gender=female
   Creates (or reuses) an ElevenLabs Conversational AI
   agent configured as a strict bidirectional translator,
   then returns a signed WebSocket URL.
   ========================================= */

const agentCache = {};
const CACHE_TTL = 30 * 60 * 1000; // 30 min

const LANG = {
    en: 'English', vi: 'Vietnamese', es: 'Spanish', fr: 'French',
    de: 'German',  it: 'Italian',    pt: 'Portuguese', nl: 'Dutch',
    ru: 'Russian', uk: 'Ukrainian',  ar: 'Arabic',  hi: 'Hindi',
    zh: 'Chinese', ja: 'Japanese',   ko: 'Korean',  th: 'Thai',
};

const VOICES = {
    male:   'nPczCjzI2devNBz1zQrb', // Brian
    female: 'EXAVITQu4vr4xnSDxMaL', // Aria
};

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(204).end();

    const API_KEY = process.env.ELEVENLABS_API_KEY;
    if (!API_KEY) return res.status(500).json({ error: 'ELEVENLABS_API_KEY not set' });

    const from   = req.query.from || 'en';
    const to     = req.query.to   || 'vi';
    const gender = req.query.gender === 'male' ? 'male' : 'female';

    if (!LANG[from] || !LANG[to]) {
        return res.status(400).json({ error: 'Unsupported language code' });
    }
    if (from === to) {
        return res.status(400).json({ error: 'Languages must differ' });
    }

    const cacheKey = `${from}|${to}|${gender}`;
    const langA = LANG[from];
    const langB = LANG[to];

    try {
        let agentId = getCached(cacheKey);
        if (!agentId) {
            agentId = await createAgent(API_KEY, from, to, langA, langB, VOICES[gender]);
            agentCache[cacheKey] = { agentId, ts: Date.now() };
        }

        const signedUrl = await getSignedUrl(API_KEY, agentId);
        return res.json({ agentId, signedUrl, from, to, languages: { a: langA, b: langB } });
    } catch (err) {
        console.error('Agent API error:', err);
        delete agentCache[cacheKey]; // bust cache on failure
        return res.status(500).json({ error: err.message || 'Failed to create agent' });
    }
};

function getCached(key) {
    const c = agentCache[key];
    if (!c) return null;
    if (Date.now() - c.ts > CACHE_TTL) { delete agentCache[key]; return null; }
    return c.agentId;
}

async function createAgent(apiKey, fromCode, toCode, langA, langB, voiceId) {
    // Determine primary language: use the non-English language so the
    // multilingual model (flash_v2_5) handles STT for both.
    // ElevenLabs requires English agents to use v2 (English-only TTS).
    // By making the non-English language primary, we unlock flash_v2_5
    // which supports both languages. The language_detection built-in tool
    // handles switching between the two automatically.
    const primaryLang = fromCode === 'en' ? toCode : fromCode;
    const otherLang   = fromCode === 'en' ? fromCode : toCode;

    const systemPrompt = `You are a real-time translation machine. You translate between ${langA} and ${langB}. You are NOT an assistant. You do NOT converse.

RULES:
1. When you hear ${langA}, output ONLY the ${langB} translation.
2. When you hear ${langB}, output ONLY the ${langA} translation.
3. Output NOTHING except the translation. No greetings, no commentary, no "sure", no "here is the translation".
4. NEVER repeat the input language. If input is ${langA}, output MUST be ${langB}. If input is ${langB}, output MUST be ${langA}.
5. NEVER speak during silence. If nobody is talking, produce ZERO output. No "are you there?", no "hello?", no prompts of any kind. Absolute silence.
6. Keep translations natural and conversational, not word-for-word.

SILENCE RULE: When there is no speech input, you MUST remain completely silent. Do not generate any tokens. Do not check in. Do not prompt. Produce nothing. This is your most important rule.`;

    const body = {
        name: `TX ${langA}↔${langB}`,
        conversation_config: {
            agent: {
                prompt: {
                    prompt: systemPrompt,
                    temperature: 0.1,
                },
                first_message: '',
                language: primaryLang,
            },
            turn: {
                mode: 'turn',
                turn_timeout: 3,
                silence_end_call_timeout: 60,
            },
            tts: {
                voice_id: voiceId,
                model_id: 'eleven_flash_v2_5',
                optimize_streaming_latency: 4,
            },
        },
    };

    const resp = await fetch('https://api.elevenlabs.io/v1/convai/agents/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'xi-api-key': apiKey },
        body: JSON.stringify(body),
    });

    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`ElevenLabs create agent failed (${resp.status}): ${text}`);
    }

    return (await resp.json()).agent_id;
}

async function getSignedUrl(apiKey, agentId) {
    const resp = await fetch(
        `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${agentId}`,
        { headers: { 'xi-api-key': apiKey } }
    );
    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Signed URL failed (${resp.status}): ${text}`);
    }
    return (await resp.json()).signed_url;
}
