// The game's pictures decoded off its frames (internal/imgdec's ptDecodeImage, game.html): a PNG's bytes in,
// its pixels out, premultiplied (Go's image.RGBA, which the game hands to Ebitengine as they are).
self.onmessage = async (e) => {
  const { id, bytes } = e.data;
  try {
    const bitmap = await createImageBitmap(new Blob([bytes]), { premultiplyAlpha: "none", colorSpaceConversion: "none" });
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3];
      if (a !== 255) {
        d[i] = (d[i] * a + 127) / 255;
        d[i + 1] = (d[i + 1] * a + 127) / 255;
        d[i + 2] = (d[i + 2] * a + 127) / 255;
      }
    }
    const pixels = new Uint8Array(d.buffer);
    self.postMessage({ id, w: canvas.width, h: canvas.height, pixels }, [pixels.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  }
};
