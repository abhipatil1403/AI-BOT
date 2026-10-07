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
  position: z.enum(['bottom-right', 'bottom-left', 'top-right', 'top-left']).default('bottom-right')
}).strict();
export type Config = z.infer<typeof configSchema>;
export const defaultConfig = configSchema.parse({});
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
export function parseCookies(json: string): Record<string, string> {
  if (json.length > 65536) throw new Error('Cookie JSON is too large');
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { throw new Error('Enter valid cookie JSON'); }
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
