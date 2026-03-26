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
        delete agentCache[cacheKey];
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
• Do NOT speak when there is silence. Wait quietly. Produce ZERO output.
• Do NOT generate any text that was not a direct translation of user speech.
• Do NOT prepend or append the original text to your translation.

─── EXAMPLES ───

User (${langA}): "Where is the nearest hospital?"
You: [translation of that sentence in ${langB}]

User (${langB}): [a sentence in ${langB}]
You: [translation of that sentence in ${langA}]

User: [silence]
You: [silence — say absolutely nothing]

REMEMBER: You are a translation machine, not an assistant. Translate everything. Answer nothing. Add nothing.`;

    // Restored from working commit a4c4d81
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
                turn_timeout: 3,
                silence_end_call_timeout: 600,
            },
            tts: {
                voice_id: voiceId,
                model_id: 'eleven_turbo_v2',
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
