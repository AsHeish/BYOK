const MAX_SCREENSHOT_DIMENSION = 1280;
const SCREENSHOT_JPEG_QUALITY = 0.6;

export function isVisibleOwnedTab(
  trackedTabIds: readonly number[],
  activeTabId: number,
  visibleTabId?: number,
): boolean {
  return visibleTabId === activeTabId && trackedTabIds.includes(activeTabId);
}

export async function captureAndResizeVisibleTab(windowId: number): Promise<string> {
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
    format: "jpeg",
    quality: Math.round(SCREENSHOT_JPEG_QUALITY * 100),
  });
  const sourceBlob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(sourceBlob);

  try {
    const scale = Math.min(1, MAX_SCREENSHOT_DIMENSION / Math.max(bitmap.width, bitmap.height));
    if (scale === 1) {
      return dataUrl;
    }

    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Could not create a screenshot resize context.");
    }
    context.drawImage(bitmap, 0, 0, width, height);
    const resizedBlob = await canvas.convertToBlob({
      type: "image/jpeg",
      quality: SCREENSHOT_JPEG_QUALITY,
    });
    return blobToDataUrl(resizedBlob);
  } finally {
    bitmap.close();
  }
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return `data:${blob.type};base64,${btoa(binary)}`;
}
