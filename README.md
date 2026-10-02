# SEV7N FOLD AI · The Aurelia Hotel

## Local setup

1. Copy `.env.example` to `.env.local`.
2. Add your Google AI Studio key as `GEMINI_API_KEY` in `.env.local`. Keep it server-side; never add a `NEXT_PUBLIC_` prefix.
3. Start the app with `npm run dev` and open the local address printed in the terminal.
4. Choose **Start call** and allow microphone access. The browser needs localhost or HTTPS for microphone use.

The call screen uses Gemini Live for real-time audio input and spoken audio output. A short-lived, one-use session token is created by `/api/gemini/live-token`; the permanent API key stays on the server. The voice agent currently answers only the hotel details listed in that route and cannot access live reservations or perform bookings.

## Vercel demo setup

Import the project into Vercel and set `GEMINI_API_KEY` in the project's Environment Variables for Preview and Production. Optionally set `GEMINI_LIVE_MODEL` (defaults to `gemini-3.8-live`), then redeploy. Microphone access works on the Vercel HTTPS domain. Keep the Gemini key out of the repository and browser bundle.

For a public client-facing release, add request authentication/rate limiting to the token endpoint and confirm the hotel's approved content and booking workflows before sharing the link. The current demo does not connect to booking, payment, guest records, or hotel staff systems.
