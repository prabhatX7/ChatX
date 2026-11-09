// Photos sent from the "Photos & videos" option are made smaller when they are big, like WhatsApp does. Anything sent
// with the "Document" option is never touched: the exact original bytes go out.

const MIN_BYTES = 1.5 * 1024 * 1024; // smaller pictures are already small; leave them exactly as they are
const MAX_EDGE = 2048; // longest side in pixels (plenty for any screen)
const QUALITY = 0.85;

/** Returns a smaller copy of a big JPEG / PNG / WebP photo, or the very same file when that is not worth it. */
export async function optimizeImage(file) {
  try {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size < MIN_BYTES) return file;
    if (typeof createImageBitmap !== 'function') return file;
    const bmp = await createImageBitmap(file); // also applies the camera's rotation
    const scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = Object.assign(document.createElement('canvas'), { width: w, height: h });
    canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
    bmp.close?.();
    // PNG may have transparency, so it becomes WebP (which keeps it); photos become JPEG.
    const type = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/webp';
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, QUALITY));
    if (!blob || blob.type !== type || blob.size >= file.size) return file;
    const ext = type === 'image/jpeg' ? 'jpg' : 'webp';
    return new File([blob], `${file.name.replace(/\.[^.]+$/, '')}.${ext}`, { type, lastModified: file.lastModified });
  } catch {
    return file;
  }
}
