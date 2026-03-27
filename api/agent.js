/* =========================================
   TalkBridge — OpenAI Realtime Token API
   GET /api/agent?from=en&to=vi

   Returns an ephemeral token for the OpenAI
   Realtime API + the translation system prompt.
   All voice config happens client-side via
   session.update — no server-side agent needed.
   ========================================= */

const LANG = {
    en: 'English', vi: 'Vietnamese', es: 'Spanish', fr: 'French',
    de: 'German',  it: 'Italian',    pt: 'Portuguese', nl: 'Dutch',
    ru: 'Russian', uk: 'Ukrainian',  ar: 'Arabic',  hi: 'Hindi',
    zh: 'Chinese', ja: 'Japanese',   ko: 'Korean',  th: 'Thai',
};

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(204).end();

    const API_KEY = process.env.OPENAI_API_KEY;
    if (!API_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY not set' });

    const from = req.query.from || 'en';
    const to   = req.query.to   || 'vi';

    if (!LANG[from] || !LANG[to]) {
        return res.status(400).json({ error: 'Unsupported language code' });
    }
    if (from === to) {
        return res.status(400).json({ error: 'Languages must differ' });
    }

    const langA = LANG[from];
    const langB = LANG[to];

    const systemPrompt = buildPrompt(langA, langB);

    try {
        // Request ephemeral client secret from OpenAI (GA endpoint)
        const resp = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${API_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
<<<<<<< HEAD
                session: {
                    type: 'realtime',
                    model: 'gpt-4o-realtime-preview',
                    instructions: systemPrompt,
                    audio: {
                        output: {
                            voice: 'coral',
                        },
                    },
                    input_audio_transcription: {
                        model: 'whisper-1',
                    },
                    turn_detection: {
                        type: 'server_vad',
                        threshold: 0.5,
                        prefix_padding_ms: 300,
                        silence_duration_ms: 500,
                    },
=======
                model: 'gpt-4o-realtime-preview',
                voice: 'coral',
                instructions: systemPrompt,
                input_audio_transcription: {
                    model: 'whisper-1',
                },
                turn_detection: {
                    type: 'server_vad',
                    threshold: 0.5,
                    prefix_padding_ms: 300,
                    silence_duration_ms: 500,
>>>>>>> 82533878c542a7905382e51314f6bd0d1b47e709
                },
            }),
        });

        if (!resp.ok) {
            const text = await resp.text();
            throw new Error(`OpenAI session failed (${resp.status}): ${text}`);
        }

        const data = await resp.json();

        return res.json({
            ephemeralKey: data.value || data.client_secret?.value || data.client_secret,
            model: 'gpt-4o-realtime-preview',
            from,
            to,
            languages: { a: langA, b: langB },
            systemPrompt,
        });
    } catch (err) {
        console.error('Agent API error:', err);
        return res.status(500).json({ error: err.message || 'Failed to create session' });
    }
};

function buildPrompt(langA, langB) {
    return `ROLE: Translation Machine
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
}
