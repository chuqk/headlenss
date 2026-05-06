// 画像アップロードの共通ヘルパー (chat / tmux 両モードで利用)。
// サーバ側 POST /api/uploads は raw バイナリを受け取って path を返す。

export type UploadResult = { path: string; bytes: number };

export async function uploadImage(blob: Blob | File): Promise<UploadResult> {
  const headers: Record<string, string> = {
    'Content-Type': blob.type || 'application/octet-stream',
  };
  // File なら filename を渡して拡張子推定の保険にする
  if (blob instanceof File && blob.name) {
    headers['X-Filename'] = blob.name;
  }
  const res = await fetch('/api/uploads', {
    method: 'POST',
    headers,
    body: blob,
  });
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as UploadResult;
}

/** ペーストイベントの clipboardData から画像ファイルだけを抽出 */
export function extractImagesFromClipboard(items: DataTransferItemList): File[] {
  const images: File[] = [];
  for (const item of Array.from(items)) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const f = item.getAsFile();
      if (f) images.push(f);
    }
  }
  return images;
}

/** 配列から画像ファイルだけ取り出す(input[type=file] / drop event 用) */
export function filterImageFiles(files: FileList | File[]): File[] {
  return Array.from(files).filter((f) => f.type.startsWith('image/'));
}
