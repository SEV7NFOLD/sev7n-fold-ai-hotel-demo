'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export type LiveStatus = 'CONNECTING' | 'LISTENING' | 'THINKING' | 'SPEAKING' | 'ERROR';

type LiveToken = { token: string; model: string; config: Record<string, unknown>; error?: string };

function base64ToBytes(value: string) {
  const binary = window.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function pcm16ToFloat32(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Float32Array(Math.floor(bytes.byteLength / 2));
  for (let index = 0; index < samples.length; index += 1) samples[index] = view.getInt16(index * 2, true) / 32768;
  return samples;
}

function float32ToBase64(samples: Float32Array, inputRate: number) {
  const outputLength = Math.floor(samples.length * 16000 / inputRate);
  const bytes = new Uint8Array(outputLength * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < outputLength; index += 1) {
    const start = index * inputRate / 16000;
    const end = Math.min(samples.length, (index + 1) * inputRate / 16000);
    let total = 0;
    for (let cursor = Math.floor(start); cursor < end; cursor += 1) total += samples[cursor] || 0;
    const sample = total / Math.max(1, Math.ceil(end) - Math.floor(start));
    view.setInt16(index * 2, Math.max(-1, Math.min(1, sample)) * (sample < 0 ? 32768 : 32767), true);
  }
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
  }
  return window.btoa(binary);
}

export function useGeminiLive() {
  const [status, setStatus] = useState<LiveStatus>('CONNECTING');
  const [muted, setMuted] = useState(false);
  const [speakerEnabled, setSpeakerEnabled] = useState(true);
  const [message, setMessage] = useState('Connecting to Ava…');
  const [error, setError] = useState('');
  const socketRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const silentGainRef = useRef<GainNode | null>(null);
  const speakerGainRef = useRef<GainNode | null>(null);
  const playheadRef = useRef(0);
  const mutedRef = useRef(false);
  const speakerEnabledRef = useRef(true);
  const stoppedRef = useRef(false);
  const sourcesRef = useRef(new Set<AudioBufferSourceNode>());

  const stop = useCallback(() => {
    stoppedRef.current = true;
    if (socketRef.current && socketRef.current.readyState < WebSocket.CLOSING) socketRef.current.close();
    socketRef.current = null;
    processorRef.current?.disconnect();
    sourceRef.current?.disconnect();
    silentGainRef.current?.disconnect();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    sourcesRef.current.forEach((source) => { try { source.stop(); } catch {} });
    sourcesRef.current.clear();
    void contextRef.current?.close();
    contextRef.current = null;
  }, []);

  useEffect(() => {
    stoppedRef.current = false;
    let active = true;

    const connect = async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone access needs a secure connection (HTTPS) and a supported browser.');
        const context = new AudioContext();
        contextRef.current = context;
        void context.resume();
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        if (!active || stoppedRef.current) { stream.getTracks().forEach((track) => track.stop()); return; }
        streamRef.current = stream;

        const tokenResponse = await fetch('/api/gemini/live-token', { method: 'POST', cache: 'no-store' });
        const tokenData = await tokenResponse.json() as LiveToken;
        if (!tokenResponse.ok || !tokenData.token) throw new Error(tokenData.error || 'Could not start the Gemini voice session.');
        if (!active || stoppedRef.current) return;

        await context.resume();
        const speakerGain = context.createGain();
        speakerGain.gain.value = speakerEnabledRef.current ? 1 : 0;
        speakerGain.connect(context.destination);
        speakerGainRef.current = speakerGain;

        const socket = new WebSocket(`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=${encodeURIComponent(tokenData.token)}`);
        socket.binaryType = 'arraybuffer';
        socketRef.current = socket;

        socket.onopen = () => {
          const config = tokenData.config as {
            responseModalities: string[];
            speechConfig: unknown;
            systemInstruction: unknown;
            inputAudioTranscription: unknown;
            outputAudioTranscription: unknown;
          };
          socket.send(JSON.stringify({
            setup: {
              model: tokenData.model,
              generationConfig: {
                responseModalities: config.responseModalities,
                speechConfig: config.speechConfig,
              },
              systemInstruction: config.systemInstruction,
              inputAudioTranscription: config.inputAudioTranscription,
              outputAudioTranscription: config.outputAudioTranscription,
            },
          }));
        };
        socket.onmessage = async (event) => {
          let rawMessage: string;
          if (typeof event.data === 'string') rawMessage = event.data;
          else if (event.data instanceof Blob) rawMessage = await event.data.text();
          else if (event.data instanceof ArrayBuffer) rawMessage = new TextDecoder().decode(event.data);
          else {
            setStatus('ERROR');
            setError('Gemini sent a voice response in an unsupported format.');
            return;
          }

          let packet: {
            setupComplete?: unknown;
            serverContent?: {
              modelTurn?: { parts?: Array<{ inlineData?: { data?: string } }> };
              inputTranscription?: { text?: string };
              outputTranscription?: { text?: string };
              turnComplete?: boolean;
              interrupted?: boolean;
            };
            error?: { message?: string };
          };
          try {
            packet = JSON.parse(rawMessage) as typeof packet;
          } catch {
            setStatus('ERROR');
            setError('Gemini sent an unreadable voice response. Please restart the call.');
            socket.close();
            return;
          }
          if (packet.error) {
            setStatus('ERROR');
            setError(packet.error.message || 'Gemini ended the voice session.');
            return;
          }
          if (packet.setupComplete) {
            setStatus('LISTENING');
            setMessage('Listening…');
            socket.send(JSON.stringify({ clientContent: { turns: [{ role: 'user', parts: [{ text: 'Welcome me warmly to The Aurelia Hotel and ask how you can help.' }] }], turnComplete: true } }));

            const input = context.createMediaStreamSource(stream);
            const processor = context.createScriptProcessor(4096, 1, 1);
            const silentGain = context.createGain();
            silentGain.gain.value = 0;
            input.connect(processor);
            processor.connect(silentGain);
            silentGain.connect(context.destination);
            sourceRef.current = input;
            processorRef.current = processor;
            silentGainRef.current = silentGain;
            processor.onaudioprocess = (audioEvent) => {
              if (mutedRef.current || socket.readyState !== WebSocket.OPEN) return;
              socket.send(JSON.stringify({ realtimeInput: { audio: { data: float32ToBase64(audioEvent.inputBuffer.getChannelData(0), context.sampleRate), mimeType: 'audio/pcm;rate=16000' } } }));
            };
          }

          const content = packet.serverContent;
          if (!content) return;
          if (content.inputTranscription?.text) {
            setStatus('THINKING');
            setMessage(content.inputTranscription.text);
          }
          if (content.outputTranscription?.text) setMessage(content.outputTranscription.text);
          if (content.modelTurn?.parts?.length) {
            for (const part of content.modelTurn.parts) {
              const audioData = part.inlineData?.data;
              if (!audioData) continue;
              setStatus('SPEAKING');
              const pcm = pcm16ToFloat32(base64ToBytes(audioData));
              const buffer = context.createBuffer(1, pcm.length, 24000);
              buffer.copyToChannel(pcm, 0);
              const audioSource = context.createBufferSource();
              audioSource.buffer = buffer;
              audioSource.connect(speakerGain);
              audioSource.onended = () => sourcesRef.current.delete(audioSource);
              audioSource.start(Math.max(context.currentTime, playheadRef.current));
              playheadRef.current = Math.max(context.currentTime, playheadRef.current) + buffer.duration;
              sourcesRef.current.add(audioSource);
            }
          }
          if (content.interrupted) {
            sourcesRef.current.forEach((audioSource) => { try { audioSource.stop(); } catch {} });
            sourcesRef.current.clear();
            playheadRef.current = context.currentTime;
          }
          if (content.turnComplete) {
            setStatus('LISTENING');
            setMessage((current) => current || 'Listening…');
          }
        };
        socket.onerror = () => {
          if (active && !stoppedRef.current) {
            setStatus('ERROR');
            setError('The Gemini voice connection failed before the call was ready. Check the server response and connection details.');
          }
        };
        socket.onclose = (event) => {
          if (active && !stoppedRef.current) {
            setStatus('ERROR');
            const reason = event.reason?.trim();
            const explanation = event.code === 1006
              ? 'The secure Gemini connection ended before setup completed.'
              : event.code === 1008
                ? 'Gemini rejected the call setup.'
                : 'Gemini closed the voice connection.';
            setError(`${explanation} Close code ${event.code}.${reason ? ` ${reason}` : ''}`);
          }
        };
      } catch (cause) {
        if (!active || stoppedRef.current) return;
        setStatus('ERROR');
        setError(cause instanceof Error ? cause.message : 'Could not start the voice call.');
      }
    };

    void connect();
    return () => { active = false; stop(); };
  }, [stop]);

  const toggleMute = useCallback(() => {
    setMuted((current) => { mutedRef.current = !current; return !current; });
  }, []);
  const toggleSpeaker = useCallback(() => {
    setSpeakerEnabled((current) => {
      const next = !current;
      speakerEnabledRef.current = next;
      if (speakerGainRef.current) speakerGainRef.current.gain.value = next ? 1 : 0;
      return next;
    });
  }, []);

  return { status, muted, speakerEnabled, message, error, toggleMute, toggleSpeaker };
}
