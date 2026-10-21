/**
 * Labels of a drone item whose file name may be missing (3C-5B spec §2.6; review of 3C-5A §6). The derived `fileName`
 * is the asset's `originalFileName`, which a public export never carries, so the UI falls back instead of showing
 * `undefined` or a lone "· resolution". With a file name, both labels are exactly what they were.
 */
import type { DroneMediaItem } from '../data/derive/droneMedia.ts'

/**
 * The line under the viewer's title (`title`, the heading): "<file name> · <resolution>". Without a file name the
 * fallback would be the title, which the heading already shows (review of 3C-5B: a drone item without a title of its
 * own falls back to its city), so the line is the resolution alone; only without a title it is the type name ("Drone
 * Aerial Photo", "Drone 360° Panorama") and the resolution.
 */
export function droneMediaMetaLine(item: Pick<DroneMediaItem, 'fileName' | 'resolution'>, title: string, typeName: string): string {
  if (!item.fileName && title) return item.resolution || title
  const name = item.fileName || typeName
  return item.resolution ? `${name} · ${item.resolution}` : name
}

/** The globe marker's name: the English title and the file name, or the title alone without a file name. */
export function droneMarkerName(item: Pick<DroneMediaItem, 'titleEn' | 'fileName'>): string {
  return item.fileName ? `${item.titleEn} ${item.fileName}` : item.titleEn
}
