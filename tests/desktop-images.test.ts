import { describe, expect, it, vi } from 'vitest';
import type { NativeImage } from 'electron';
const mocks = vi.hoisted(() => ({ read: vi.fn(), createFromBuffer: vi.fn() }));
vi.mock('electron', () => ({ clipboard: { read: mocks.read }, nativeImage: { createFromBuffer: mocks.createFromBuffer } }));
import { prepareImage, readClipboardQuestion } from '../apps/desktop/images';
function native(width = 500, height = 300, pngSize = 20): NativeImage {
  const image = { isEmpty: () => false, getSize: () => ({ width, height }), toPNG: () => Buffer.alloc(pngSize), toJPEG: vi.fn(() => Buffer.alloc(10)), resize: vi.fn() };
  image.resize.mockReturnValue({ ...image, getSize: () => ({ width: 1000, height: 1000 }) });
  return image as unknown as NativeImage;
}
describe('desktop image acquisition', () => {
  it('normalizes large screenshots and rejects excessively large dimensions', () => {
    const image = native(4000, 4000); prepareImage(image);
    expect(image.resize).toHaveBeenCalledWith({ width: 2000, height: 2000, quality: 'best' });
    expect(() => prepareImage(native(8000, 8000))).toThrow('dimensions');
  });
  it('compresses oversized PNGs and rejects empty decoded images', () => {
    const image = native(500, 300, 4_000_001);
    expect(prepareImage(image).image.mimeType).toBe('image/jpeg'); expect(image.toJPEG).toHaveBeenCalledWith(85);
    expect(() => prepareImage({ isEmpty: () => true } as NativeImage)).toThrow('unreadable');
  });
  it('prefers actual image bytes over an accompanying copied URL', async () => {
    const getType = vi.fn().mockResolvedValue(new Blob(['synthetic image'], { type: 'image/png' }));
    mocks.read.mockResolvedValue([{ types: ['text/plain', 'image/png'], getType }]); mocks.createFromBuffer.mockReturnValue(native());
    expect(await readClipboardQuestion()).toHaveProperty('image.mimeType', 'image/png');
    expect(getType).toHaveBeenCalledExactlyOnceWith('image/png');
  });
  it('reads text from the same snapshot and ignores unsupported clipboard formats', async () => {
    mocks.read.mockResolvedValue([{ types: ['text/plain'], getType: () => Promise.resolve(new Blob(['Question?'])) }]);
    expect(await readClipboardQuestion()).toBe('Question?');
    mocks.read.mockResolvedValue([{ types: ['application/octet-stream'] }]); expect(await readClipboardQuestion()).toBe('');
  });
});
