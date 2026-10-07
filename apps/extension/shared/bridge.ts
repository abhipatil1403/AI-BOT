import { BASE_URL } from '../../../packages/protocol';
import { stateSchema, type AssistantState } from '../../../packages/schemas';
export async function bridgeRequest(path: string, method = 'GET', body?: unknown): Promise<unknown> {
  const stored = await chrome.storage.local.get('pairingToken');
  if (typeof stored.pairingToken !== 'string' || !/^[a-f0-9]{64}$/.test(stored.pairingToken)) throw new Error('Pair the desktop companion in extension settings');
  let res: Response;
  try { res = await fetch(`${BASE_URL}${path}`, { method, cache: 'no-store', headers: { Authorization: `Bearer ${stored.pairingToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(4000) }); }
  catch { throw new Error('Desktop companion is not running'); }
  if (res.status === 401) throw new Error('Pairing token is invalid. Pair again in extension settings');
  if (!res.ok) throw new Error('Desktop connection failed');
  return res.json();
}
export async function getState(): Promise<AssistantState> { return stateSchema.parse(await bridgeRequest('/v1/state')); }
