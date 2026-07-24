export function calculateUpdateProgress(
  downloadedBytes: number,
  totalBytes?: number,
): number | null {
  if (!totalBytes || totalBytes <= 0) return null;
  const percentage = Math.round((downloadedBytes / totalBytes) * 100);
  return Math.max(0, Math.min(100, percentage));
}
