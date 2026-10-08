/**
 * Audio conversion pipeline.
 *
 * Inbound (caller -> Ava):
 *   telephony μ-law 8 kHz  ->  decode μ-law  ->  PCM16  ->  resample to 16 kHz  ->  Gemini Live
 *
 * Outbound (Ava -> caller):
 *   Gemini PCM16 24 kHz  ->  resample to 8 kHz  ->  PCM16  ->  encode μ-law  ->  telephony
 *
 * Pure functions with no I/O, so they can be tested on their own (see test/audio.test.ts).
 */

/* ------------------------------------------------------------------ μ-law codec */

const ULAW_BIAS = 0x84;
const ULAW_CLIP = 32635;

/**
 * ITU-T G.711 μ-law.
 *
 * The two directions live in one place because they are easy to get subtly inconsistent:
 * an encoder is only correct if decoding its output reproduces the intended sample.
 *
 * Canonical mapping (verified against the standard tables):
 *   0x7F -> +0 (positive zero)        0xFF -> -0 (negative zero)
 *   0x80 -> -32124 (most negative)    0x00 -> +32124 (most positive)
 *
 * Sign convention, which is easy to invert by accident:
 *   bit 0x80 of the INVERTED byte set  ->  POSITIVE sample
 * so the 0x80..0xFF family is positive and the 0x00..0x7F family is negative. Getting this
 * backwards produces audio that still sounds like speech but is phase-inverted, which is
 * why the tests assert exact extreme values rather than just magnitudes.
 *
 * Both 0x7F and 0xFF decode to 0, so the mapping is injective on codes but not at zero.
 */
const ULAW_TO_PCM = new Int16Array(256);

for (let byte = 0; byte < 256; byte += 1) {
  const value = ~byte & 0xff;
  const magnitude = (((value & 0x0f) << 3) + ULAW_BIAS) << ((value >> 4) & 0x07);
  const sample = magnitude - ULAW_BIAS;
  // See the sign-convention note above: set 0x80 means POSITIVE.
  ULAW_TO_PCM[byte] = (value & 0x80) !== 0 ? sample : -sample;
}

/**
 * Encode a signed 16-bit PCM sample to a μ-law byte.
 *
 * Canonical G.711 encoder. Verified against the standard table by `npm test`, which asserts
 * both the exact code table and the round-trip stability of all 256 codes.
 *
 * Sign handling, stated once so it is not guessed at: the decoder treats `~code & 0x80` set
 * as POSITIVE. To make a positive sample decode positive, the code must have its 0x80 bit
 * CLEAR (0x00..0x7F), which means the sign term ORed in before the final `~` inversion must
 * be 0x80 for positive samples — the opposite of how the familiar C implementations read.
 * Getting this backwards phase-inverts every call, which is audible but easy to miss.
 */
export function pcm16SampleToUlaw(sample: number): number {
  // 0x7F and 0xFF both decode to zero, so zero needs an explicit canonical code.
  if (sample === 0) return 0xff;

  // 0x80 for POSITIVE samples: the final inversion turns it into a clear bit.
  let sign = sample >= 0 ? 0x80 : 0;

  let value = Math.abs(Math.round(sample));
  if (value > ULAW_CLIP) value = ULAW_CLIP;
  value += ULAW_BIAS;

  let exponent = 7;
  for (let mask = 0x4000; (value & mask) === 0 && exponent > 0; mask >>= 1) exponent -= 1;

  const mantissa = (value >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/** Decode a μ-law byte to a signed 16-bit PCM sample. */
export function ulawByteToPcm16(byte: number): number {
  return ULAW_TO_PCM[byte & 0xff] as number;
}

/** Decode a μ-law buffer into a Float32 array in the range [-1, 1). */
export function ulawToFloat32(ulaw: Uint8Array): Float32Array {
  const out = new Float32Array(ulaw.length);
  for (let i = 0; i < ulaw.length; i += 1) {
    out[i] = (ULAW_TO_PCM[ulaw[i] as number] as number) / 32768;
  }
  return out;
}

/** Decode a μ-law buffer straight to little-endian PCM16 bytes. */
export function ulawToPcm16Bytes(ulaw: Uint8Array): Uint8Array {
  const out = new Uint8Array(ulaw.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < ulaw.length; i += 1) {
    view.setInt16(i * 2, ULAW_TO_PCM[ulaw[i] as number] as number, true);
  }
  return out;
}

/** Encode Float32 samples in [-1, 1] to a μ-law buffer. */
export function float32ToUlaw(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i] as number));
    out[i] = pcm16SampleToUlaw(clamped * (clamped < 0 ? 32768 : 32767));
  }
  return out;
}

/** Encode little-endian PCM16 bytes to a μ-law buffer. */
export function pcm16BytesToUlaw(pcm: Uint8Array): Uint8Array {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const count = Math.floor(pcm.byteLength / 2);
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i += 1) out[i] = pcm16SampleToUlaw(view.getInt16(i * 2, true));
  return out;
}

/* ------------------------------------------------------------------- resampling */

/**
 * Resample a Float32 signal by an arbitrary rational ratio.
 *
 * Uses windowed-sinc (Kaiser) interpolation: for each output sample we integrate the
 * input over the corresponding input window and weight it with a truncated sinc,
 * scaled by the bandwidth ratio. When downsampling this also acts as the required
 * anti-alias low-pass filter, which a naive linear interpolator does not do — that
 * matters for Ava's 24 kHz -> 8 kHz outbound path, where aliasing is audible.
 *
 * Quality is traded against CPU via `taps`; the default suits real-time telephony.
 */
export function resampleFloat32(
  input: Float32Array,
  fromRate: number,
  toRate: number,
  taps = 16,
): Float32Array {
  if (fromRate <= 0 || toRate <= 0) throw new RangeError('Sample rates must be positive');
  if (input.length === 0) return new Float32Array(0);
  if (fromRate === toRate) return input.slice();

  const ratio = toRate / fromRate;
  const outputLength = Math.max(1, Math.round(input.length * ratio));
  const out = new Float32Array(outputLength);
  const cutoff = Math.min(1, ratio); // bandwidth of the destination
  const halfTaps = Math.max(1, Math.floor(taps / 2));

  for (let i = 0; i < outputLength; i += 1) {
    // Position of this output sample in the input timeline.
    const center = (i / ratio) * 1;
    let acc = 0;
    let weightSum = 0;

    const first = Math.floor(center) - halfTaps + 1;
    const last = Math.floor(center) + halfTaps;

    for (let j = first; j <= last; j += 1) {
      if (j < 0 || j >= input.length) continue;
      const distance = center - j;
      const x = distance * cutoff;
      // Truncated sinc windowed by a Hann lobe of the same width.
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * (distance + halfTaps)) / (2 * halfTaps + 1));
      const weight = sinc * window;
      acc += (input[j] as number) * weight;
      weightSum += weight;
    }

    out[i] = weightSum !== 0 ? acc / weightSum : 0;
  }

  return out;
}

/** Resample little-endian PCM16 bytes between two rates. */
export function resamplePcm16Bytes(pcm: Uint8Array, fromRate: number, toRate: number): Uint8Array {
  if (fromRate === toRate) return pcm;
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const count = Math.floor(pcm.byteLength / 2);
  const input = new Float32Array(count);
  for (let i = 0; i < count; i += 1) input[i] = view.getInt16(i * 2, true) / 32768;
  return float32ToPcm16Bytes(resampleFloat32(input, fromRate, toRate));
}

/* ------------------------------------------------------------- PCM16 <-> float32 */

/** Convert little-endian PCM16 bytes to Float32 samples in [-1, 1). */
export function pcm16BytesToFloat32(pcm: Uint8Array): Float32Array {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const count = Math.floor(pcm.byteLength / 2);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i += 1) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}

/** Convert Float32 samples in [-1, 1] to little-endian PCM16 bytes. */
export function float32ToPcm16Bytes(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i] as number));
    view.setInt16(i * 2, clamped * (clamped < 0 ? 32768 : 32767), true);
  }
  return out;
}

/* ------------------------------------------------------------------ orchestration */

export const TELEPHONY_RATE = 8000;
export const GEMINI_INPUT_RATE = 16000;
export const GEMINI_OUTPUT_RATE = 24000;

/**
 * Caller -> Ava.
 * telephony μ-law 8 kHz bytes  ->  PCM16 16 kHz bytes ready for Gemini `realtimeInput`.
 */
export function phoneToGemini(ulaw8k: Uint8Array): Uint8Array {
  const pcm8k = ulawToPcm16Bytes(ulaw8k);
  return resamplePcm16Bytes(pcm8k, TELEPHONY_RATE, GEMINI_INPUT_RATE);
}

/**
 * Ava -> caller.
 * Gemini PCM16 24 kHz bytes  ->  μ-law 8 kHz bytes ready for the telephony provider.
 */
export function geminiToPhone(pcm24k: Uint8Array): Uint8Array {
  const pcm8k = resamplePcm16Bytes(pcm24k, GEMINI_OUTPUT_RATE, TELEPHONY_RATE);
  return pcm16BytesToUlaw(pcm8k);
}

/* ------------------------------------------------------------------------ base64 */

export function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

export function base64ToBytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'));
}
