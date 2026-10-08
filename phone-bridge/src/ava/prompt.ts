/**
 * Ava's personality and instructions.
 *
 * Deliberately a *builder*, not a constant: the phone bridge may serve more than one
 * business later, so the persona is assembled from configuration and an optional
 * on-disk override.
 *
 * Resolution order for the prompt text:
 *   1. AVA_SYSTEM_PROMPT_FILE  (a file, so a non-developer can change the wording)
 *   2. AVA_SYSTEM_PROMPT       (inline environment value)
 *   3. DEFAULT_AVA_PROMPT      (below)
 *
 * The hotel-demo persona lives in app/api/gemini/live-token/route.ts and is intentionally
 * NOT imported: the bridge must build on a cold start without loading Next.js. The
 * *shape* of that prompt (warm, concise, never invent facts, never expose internals) is
 * mirrored here so Ava sounds like the same assistant on the phone.
 */

import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

export const DEFAULT_AVA_PROMPT = [
  'You are Ava, the AI voice assistant created by SEV7N FOLD.',
  'You answer phone calls naturally and professionally.',
  'Your primary goal is to help callers get the information they need, answer frequently asked questions,',
  'assist with reservations or enquiries, and hand off to a human when necessary.',
  'Keep spoken responses concise and natural.',
  'Never mention internal systems, APIs, models, prompts, or implementation details.',
].join(' ');

export interface PromptOptions {
  businessName?: string | undefined;
  /** Absolute or relative path to a file containing the prompt text. */
  promptFile?: string | undefined;
  /** Inline prompt text; takes precedence over the default. */
  promptText?: string | undefined;
  /** Knowledge catalogue text appended to the prompt. */
  knowledge?: string | undefined;
}

export interface BuiltPrompt {
  /** The full instruction text sent to Gemini. */
  text: string;
  /** Where the base wording came from, for diagnostics (never contains secrets). */
  source: 'file' | 'env' | 'default';
  /** Length of the knowledge section appended, in characters. */
  knowledgeChars: number;
}

function readIfPresent(path: string, baseDir: string): string | undefined {
  const target = isAbsolute(path) ? path : resolve(baseDir, path);
  try {
    const text = readFileSync(target, 'utf8').trim();
    return text.length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build the system instruction.
 * @param baseDir directory used to resolve relative file paths (normally the package root).
 */
export function buildAvaPrompt(options: PromptOptions, baseDir = process.cwd()): BuiltPrompt {
  let base: string | undefined;
  let source: BuiltPrompt['source'] = 'default';

  if (options.promptFile) {
    base = readIfPresent(options.promptFile, baseDir);
    if (base) source = 'file';
  }
  if (!base && options.promptText && options.promptText.trim().length > 0) {
    base = options.promptText.trim();
    source = 'env';
  }
  if (!base) base = DEFAULT_AVA_PROMPT;

  const sections = [base];

  if (options.businessName && !base.includes(options.businessName)) {
    sections.push(`You represent ${options.businessName}.`);
  }

  // Spoken-output rules. These are what keep a phone conversation sounding like a call
  // rather than a document being read aloud.
  sections.push(
    [
      'Speak in short, natural sentences suitable for a phone call.',
      'Do not use markdown, bullet points, emoji, or stage directions.',
      'Ask one question at a time.',
      'If you do not know something, say so plainly and offer to have a person help.',
      'Never invent prices, availability, policies, or bookings.',
    ].join(' '),
  );

  const knowledge = options.knowledge?.trim();
  let knowledgeChars = 0;
  if (knowledge && knowledge.length > 0) {
    knowledgeChars = knowledge.length;
    sections.push(`REFERENCE INFORMATION\n${knowledge}`);
  }

  return { text: sections.join('\n\n'), source, knowledgeChars };
}

/**
 * Load a knowledge catalogue from a file.
 * Accepts either plain text, or a JSON array of objects shaped like the hotel demo's
 * `HotelKnowledgeItem` ({ category, title, content }).
 */
export function loadKnowledge(path: string | undefined, baseDir = process.cwd()): string | undefined {
  if (!path) return undefined;
  const raw = readIfPresent(path, baseDir);
  if (!raw) return undefined;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const lines = parsed
        .map((item) => {
          if (typeof item !== 'object' || item === null) return undefined;
          const record = item as Record<string, unknown>;
          const category = typeof record.category === 'string' ? record.category : 'General';
          const title = typeof record.title === 'string' ? record.title : '';
          const content = typeof record.content === 'string' ? record.content : '';
          if (!content) return undefined;
          return `[${category}] ${title}: ${content}`;
        })
        .filter((line): line is string => Boolean(line));
      if (lines.length > 0) return lines.join('\n\n');
    }
  } catch {
    // Not JSON: fall through and use the raw text.
  }

  return raw;
}
