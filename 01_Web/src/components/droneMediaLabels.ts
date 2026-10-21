/**
 * Labels of a drone item whose file name may be missing (3C-5B spec §2.6; review of 3C-5A §6). The derived `fileName`
 * is the asset's `originalFileName`, which a public export never carries, so the UI falls back instead of showing
 * `undefined` or a lone "· resolution". With a file name, both labels are exactly what they were.
 */
import type { DroneMediaItem } from '../data/derive/droneMedia.ts'

/**
 * The line under the viewer's title: the file name, or else the title, or else the type name ("Drone Aerial Photo",
 * "Drone 360° Panorama"), then " · " and the resolution when there is one.
 */
export function droneMediaMetaLine(item: Pick<DroneMediaItem, 'fileName' | 'resolution'>, title: string, typeName: string): string {
  const name = item.fileName || title || typeName
  return item.resolution ? `${name} · ${item.resolution}` : name
}

/** The globe marker's name: the English title and the file name, or the title alone without a file name. */
export function droneMarkerName(item: Pick<DroneMediaItem, 'titleEn' | 'fileName'>): string {
  return item.fileName ? `${item.titleEn} ${item.fileName}` : item.titleEn
}
