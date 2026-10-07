import { clipboard, nativeImage, type NativeImage } from 'electron';
import { open } from 'node:fs/promises';
import { AssistantError, MAX_IMAGE_BYTES, type ImageQuestion, type QuestionInput } from '../../packages/core';

export function prepareImage(image: NativeImage): ImageQuestion {
  if (image.isEmpty()) throw new AssistantError('image', 'Image is empty or unreadable. Choose PNG, JPEG or WebP');
  const { width, height } = image.getSize();
  if (width <= 0 || height <= 0 || width * height > 40_000_000) throw new AssistantError('size', 'Image dimensions are too large (40 megapixels maximum)');
  const scale = Math.min(1, 3072 / Math.max(width, height), Math.sqrt(4_000_000 / (width * height)));
  const resized = scale < 1 ? image.resize({ width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), quality: 'best' }) : image;
  const png = resized.toPNG();
  if (png.length <= MAX_IMAGE_BYTES) return { image: { mimeType: 'image/png', data: png } };
  const jpeg = resized.toJPEG(85);
  if (jpeg.length > MAX_IMAGE_BYTES) throw new AssistantError('size', 'Image is too large. Crop the question and try again');
  return { image: { mimeType: 'image/jpeg', data: jpeg } };
}
export async function readClipboardQuestion(): Promise<QuestionInput> {
  const items = await clipboard.read();
  for (const item of items) {
    const type = ['image/png', 'image/jpeg', 'image/webp'].find(type => item.types.includes(type));
    if (!type) continue;
    const blob = await item.getType(type);
    if (!(blob instanceof Blob) || blob.size > 20_000_000) throw new AssistantError('size', 'Copied image is too large (20 MB maximum)');
    return prepareImage(nativeImage.createFromBuffer(Buffer.from(await blob.arrayBuffer())));
  }
  const item = items.find(item => item.types.includes('text/plain'));
  return item ? (await item.getType('text/plain')).text() : '';
}
export async function readImageFile(path: string): Promise<ImageQuestion> {
  const file = await open(path, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 20_000_000) throw new AssistantError('size', 'Choose an image file of 20 MB or less');
    const data = Buffer.alloc(Number(info.size) + 1);
    const { bytesRead } = await file.read(data, 0, data.length, 0);
    if (bytesRead > info.size) throw new AssistantError('image', 'Image changed while reading. Try again');
    return prepareImage(nativeImage.createFromBuffer(data.subarray(0, bytesRead)));
  } finally { await file.close(); }
}
