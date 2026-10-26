/**
 * 图像压缩。只在浏览器里用（依赖 Canvas / createImageBitmap），不参与测试。
 *
 * 原图永不离开设备：压缩后的字节才会进加密流程。
 * 一组照片逐张独立压缩（长边 720px、JPEG q=0.7），不拼图、不裁切。
 */

import { toStorage } from './binary';
import { bytesToBase64 } from './base64';

export const MAX_EDGE = 720;
export const JPEG_QUALITY = 0.7;

export interface CompressedImage {
  bytes: Uint8Array;
  mime: string;
  width: number;
  height: number;
}

async function loadBitmap(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(file);
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('图片解码失败'));
      img.src = url;
    });
    return img;
  } finally {
    // 交给 GC 前先撤销，避免内存泄漏；img 已经解码完成，撤销不影响绘制
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/** 压缩并返回尺寸信息（原有的完整能力，保留）。 */
export async function compressImageWithMeta(file: File): Promise<CompressedImage> {
  const source = await loadBitmap(file);
  const sw = 'width' in source ? source.width : 0;
  const sh = 'height' in source ? source.height : 0;
  if (!sw || !sh) throw new Error('无法读取图片尺寸');

  const scale = Math.min(1, MAX_EDGE / Math.max(sw, sh));
  const width = Math.max(1, Math.round(sw * scale));
  const height = Math.max(1, Math.round(sh * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('当前浏览器不支持 Canvas 2D');
  ctx.drawImage(source as CanvasImageSource, 0, 0, width, height);
  if ('close' in source && typeof source.close === 'function') source.close();

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY),
  );
  if (!blob) throw new Error('图片压缩失败');

  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { bytes, mime: 'image/jpeg', width, height };
}

/**
 * 压缩单张照片，只返回字节。
 * 这层的输入永远是单张 File——照片组的循环在 pack 的调用方（Tab2）里做，
 * 这样每张照片都是独立的压缩结果、独立的字节数组。
 */
export async function compressImage(file: File): Promise<Uint8Array> {
  const { bytes } = await compressImageWithMeta(file);
  return bytes;
}

/**
 * 批量压缩（Trip 编辑器用）。
 *
 * 逐张串行：并发跑 Canvas 压缩在低端机上很容易 OOM，
 * 而且用户一次最多选 5 张，串行的总耗时可以接受。
 * 单张失败会被跳过，返回值与输入等长，失败位置是 null。
 */
export async function compressImageBatch(files: File[]): Promise<Array<Uint8Array | null>> {
  const out: Array<Uint8Array | null> = [];
  for (const file of files) {
    try {
      out.push(await compressImage(file));
    } catch {
      out.push(null);
    }
  }
  return out;
}

export function bytesToObjectUrl(bytes: Uint8Array, mime: string): string {
  const copy = toStorage(bytes);
  return URL.createObjectURL(new Blob([copy], { type: mime }));
}

/**
 * 转成 data URL。弹窗里的照片组用这个，省掉对象 URL 的回收管理，
 * 720px/q0.7 的图每张约 50–80KB，5 张也就几百 KB。
 */
export function bytesToDataUrl(bytes: Uint8Array, mime = 'image/jpeg'): string {
  return `data:${mime};base64,${bytesToBase64(bytes)}`;
}
