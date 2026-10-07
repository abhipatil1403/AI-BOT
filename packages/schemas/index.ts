import { z } from 'zod';

export const languages = ['python', 'c', 'cpp', 'java', 'javascript', 'typescript', 'go'] as const;
export const shortcutSchema = z.string().regex(/^(?:Ctrl\+)(?:Alt\+)?(?:Shift\+)?(?:[A-Z0-9]|F(?:[1-9]|1[0-2]))$/, 'Use Ctrl+[Alt+][Shift+] followed by a letter, digit or F1–F12.');
export const configSchema = z.object({
  provider: z.enum(['groq', 'gemini']).default('groq'),
  language: z.enum(languages).default('python'),
  duration: z.union([z.literal(2), z.literal(3), z.literal(5), z.literal(10), z.literal(15), z.literal(0)]).default(5),
  explanations: z.boolean().default(false),
  comments: z.boolean().default(false),
  shortcut: shortcutSchema.default('Ctrl+V'),
  visibility: z.enum(['always', 'minimized', 'sharing']).default('always'),
  sharing: z.boolean().default(false),
  captureProtection: z.boolean().default(true),
  position: z.enum(['bottom-right', 'bottom-left', 'top-right', 'top-left']).default('bottom-right')
}).strict();
export type Config = z.infer<typeof configSchema>;
export const defaultConfig = configSchema.parse({});
// A browser iframe cannot have its own Windows display affinity.
export function hideBrowserOverlay(config: Config): boolean {
  return config.sharing && (config.visibility === 'sharing' || config.captureProtection);
}
export const answerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('mcq'), answer: z.string().regex(/^[A-H1-8]$/), text: z.string().max(2000).optional(), explanation: z.string().max(4000).optional() }).strict(),
  z.object({ type: z.literal('descriptive'), answer: z.string().trim().min(1).max(20000) }).strict(),
  z.object({ type: z.literal('code'), language: z.enum(languages), code: z.string().min(1).max(50000).refine(value => /\S/.test(value)) }).strict()
]);
export type Answer = z.infer<typeof answerSchema>;
export type AnswerType = Answer['type'];
export const stateSchema = z.object({
  phase: z.enum(['idle', 'processing', 'ready', 'error']),
  requestId: z.number().int().nonnegative(),
  answer: answerSchema.optional(),
  error: z.string().max(200).optional(),
  updatedAt: z.number(),
  config: configSchema
}).strict();
export type AssistantState = z.infer<typeof stateSchema>;
export const copyRequestSchema = z.object({ requestId: z.number().int().nonnegative() }).strict();

const cookieValue = z.string().min(1).max(8192).regex(/^[\x21-\x7e]+$/).refine(v => !/[;,]/.test(v), 'Invalid cookie value');
const cookieName = z.string().regex(/^[A-Za-z0-9_-]+$/).max(128);
const cookieRecord = z.record(cookieName, cookieValue);
const cookieArray = z.array(z.object({ name: cookieName, value: cookieValue, domain: z.string().optional() }).passthrough()).max(100);
function parseCookieHeader(input: string): Record<string, string> {
  if (/[\r\n]/.test(input)) throw new Error('Use a single Cookie header, without other HTTP headers');
  const header = input.trim().replace(/^Cookie:[\t ]*/i, '');
  const parts = header.split(';');
  if (parts.at(-1)?.trim() === '') parts.pop();
  if (!parts.length || parts.length > 100) throw new Error('Invalid Cookie header');
  const entries: [string, string][] = [];
  const names = new Set<string>();
  for (const part of parts) {
    const pair = part.trim(); const separator = pair.indexOf('=');
    if (separator < 1) throw new Error('Use Cookie header entries in name=value format');
    const name = pair.slice(0, separator); const value = pair.slice(separator + 1);
    if (!cookieName.safeParse(name).success || !cookieValue.safeParse(value).success) throw new Error('Invalid cookie name or value');
    if (names.has(name)) throw new Error('Duplicate cookie name');
    names.add(name); entries.push([name, value]);
  }
  return Object.fromEntries(entries);
}
export function parseCookies(input: string): Record<string, string> {
  if (input.length > 65536) throw new Error('Cookie input is too large');
  const trimmed = input.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    const cookies = parseCookieHeader(input);
    if (!cookies['__Secure-1PSID']) throw new Error('Missing __Secure-1PSID session cookie');
    return cookies;
  }
  let raw: unknown;
  try { raw = JSON.parse(trimmed); } catch { throw new Error('Cookie JSON is incomplete or invalid'); }
  const record = cookieRecord.safeParse(raw);
  let cookies: Record<string, string>;
  if (record.success) cookies = record.data;
  else {
    const array = cookieArray.safeParse(raw);
    if (!array.success) throw new Error('Use a cookie name/value object or an array of cookie objects');
    if (array.data.some(c => c.domain && !/^\.?google\.com$|^\.?gemini\.google\.com$/.test(c.domain))) throw new Error('Only Google session cookies are accepted');
    cookies = Object.fromEntries(array.data.map(c => [c.name, c.value]));
  }
  if (!cookies['__Secure-1PSID']) throw new Error('Missing __Secure-1PSID session cookie');
  return cookies;
}
