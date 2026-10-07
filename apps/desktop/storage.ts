import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { configSchema, defaultConfig, type Config } from '../../packages/schemas';
import { AssistantError } from '../../packages/core';

export interface Cipher { isEncryptionAvailable(): boolean; encryptString(value: string): Buffer; decryptString(value: Buffer): string }
export class Storage {
  constructor(private readonly directory: string, private readonly cipher: Cipher) { mkdirSync(directory, { recursive: true }); }
  private read(name: string): unknown {
    try { return JSON.parse(readFileSync(join(this.directory, name), 'utf8')); }
    catch { return undefined; }
  }
  private write(name: string, value: unknown): void {
    const path = join(this.directory, name);
    writeFileSync(`${path}.tmp`, JSON.stringify(value), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  }
  loadConfig(): Config {
    const parsed = configSchema.safeParse(this.read('config.json'));
    return parsed.success ? parsed.data : { ...defaultConfig };
  }
  saveConfig(config: Config): void { this.write('config.json', configSchema.parse(config)); }
  hasSecret(name: string): boolean {
    const data = this.read('vault.json');
    return !!(data && typeof data === 'object' && typeof (data as Record<string, unknown>)[name] === 'string');
  }
  getSecret(name: string): string | undefined {
    if (!this.cipher.isEncryptionAvailable()) throw new AssistantError('storage', 'Secure credential storage is unavailable');
    const data = this.read('vault.json');
    const encoded = data && typeof data === 'object' ? (data as Record<string, unknown>)[name] : undefined;
    if (typeof encoded !== 'string') return undefined;
    try { return this.cipher.decryptString(Buffer.from(encoded, 'base64')); }
    catch { throw new AssistantError('storage', 'Saved credential cannot be decrypted. Save it again'); }
  }
  setSecret(name: string, value: string): void {
    if (!this.cipher.isEncryptionAvailable()) throw new AssistantError('storage', 'Secure credential storage is unavailable');
    const raw = this.read('vault.json');
    const data = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    data[name] = this.cipher.encryptString(value).toString('base64');
    this.write('vault.json', data);
  }
  removeSecret(name: string): void {
    if (!existsSync(join(this.directory, 'vault.json'))) return;
    const raw = this.read('vault.json');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    const data = raw as Record<string, unknown>; delete data[name]; this.write('vault.json', data);
  }
}
