// Photo Sphere Viewer treats captions as HTML; media titles remain plain user text.
export function panoramaCaption(title: string): string {
  return title.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

export const panoramaLanguageKeys = [
  'zoom', 'zoomOut', 'zoomIn', 'moveUp', 'moveDown', 'moveLeft', 'moveRight',
  'description', 'download', 'fullscreen', 'loading', 'menu', 'close',
  'twoFingers', 'ctrlZoom', 'loadError', 'webglError',
] as const
