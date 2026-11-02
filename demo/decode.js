// The game's pictures decoded off its frames (internal/imgdec's ptDecodeImage, game.html): a PNG's bytes in,
// its pixels out, premultiplied (Go's image.RGBA, which the game hands to Ebitengine as they are); shrunk to max on
// its longer side when it is longer (a fight's units' pages: their textures a quarter, drawn small).
// One canvas, shrunk back to a pixel after each picture: its backing store goes at once, not at the worker's next
// collection (the page makes the worker anew now and then too).
const canvas = new OffscreenCanvas(1, 1);
const ctx = canvas.getContext("2d", { willReadFrequently: true });
self.onmessage = async (e) => {
  const { id, bytes, max } = e.data;
  try {
    const bitmap = await createImageBitmap(new Blob([bytes]), { premultiplyAlpha: "none", colorSpaceConversion: "none" });
    const k = max > 0 ? Math.min(1, max / Math.max(bitmap.width, bitmap.height)) : 1;
    canvas.width = Math.round(bitmap.width * k);
    canvas.height = Math.round(bitmap.height * k);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const w = canvas.width, h = canvas.height;
    const d = ctx.getImageData(0, 0, w, h).data;
    canvas.width = canvas.height = 1;
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3];
      if (a !== 255) {
        d[i] = (d[i] * a + 127) / 255;
        d[i + 1] = (d[i + 1] * a + 127) / 255;
        d[i + 2] = (d[i + 2] * a + 127) / 255;
      }
    }
    const pixels = new Uint8Array(d.buffer);
    self.postMessage({ id, w, h, pixels }, [pixels.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  }
};
