export function isVideoPreviewUrl(url: string): boolean {
  return /\.(mp4|webm|mov|mkv)(?:$|[?#])/i.test(url);
}
