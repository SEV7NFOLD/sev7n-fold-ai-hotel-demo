import { MOCK_KNOWLEDGE } from '@/lib/mock-data';

const model = process.env.GEMINI_LIVE_MODEL || 'gemini-3.8-live';

const hotelContext = MOCK_KNOWLEDGE.map((item) => `[${item.category}] ${item.title}: ${item.content}`).join('\n\n');
const systemInstruction = `You are Ava, the warm, concise voice concierge for The Aurelia Hotel case-study in Victoria Island, Lagos. Speak naturally, with a calm and welcoming tone. Keep replies conversational and brief. Use the case-study catalogue below to answer questions; when helpful, suggest a relevant option from it and ask one natural follow-up question. Do not repeatedly answer with a generic promise to check back. If a fact is missing, say which detail needs confirmation, offer a relevant known alternative, and ask what the guest prefers. The prices and amenities are illustrative demo assumptions, not approved real-hotel facts: call prices indicative, never present them as a final quote, and do not imply these details are verified operating information. Do not claim live availability, create or confirm bookings, charge payments, send messages, or contact staff.\n\nCASE-STUDY KNOWLEDGE CATALOGUE\n${hotelContext}`;

export async function POST(request: Request) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return Response.json({ error: 'Gemini is not configured yet. Add GEMINI_API_KEY to the server environment.' }, { status: 503 });
  }

  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) {
    return Response.json({ error: 'Request origin is not allowed.' }, { status: 403 });
  }

  const now = Date.now();
  const config = {
    responseModalities: ['AUDIO'],
    systemInstruction: { parts: [{ text: systemInstruction }] },
    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
  };

  try {
    const response = await fetch('https://generativelanguage.googleapis.com/v1beta/auth_tokens', {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        uses: 1,
        expireTime: new Date(now + 30 * 60 * 1000).toISOString(),
        newSessionExpireTime: new Date(now + 60 * 1000).toISOString(),
      }),
      cache: 'no-store',
    });

    const payload = await response.json();
    if (!response.ok || typeof payload.name !== 'string') {
      const detail = typeof payload.error?.message === 'string' ? payload.error.message.slice(0, 240) : 'Unknown error';
      console.error('Gemini token provisioning failed:', response.status, detail);
      return Response.json({ error: `Gemini could not start a voice session (${response.status}): ${detail}` }, { status: 502 });
    }

    return Response.json({ token: payload.name, model: `models/${model}`, config }, {
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    });
  } catch (error) {
    console.error('Gemini token provisioning request failed:', error);
    return Response.json({ error: 'Could not reach Gemini. Please try again.' }, { status: 502 });
  }
}
