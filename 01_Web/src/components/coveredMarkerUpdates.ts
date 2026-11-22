import * as Cesium from 'cesium'

type MarkerVisualizer = Cesium.BillboardVisualizer | Cesium.LabelVisualizer | Cesium.PointVisualizer

// Cesium 1.147.0 exports VERSION at runtime but omits it from its declarations.
const version = (Cesium as typeof Cesium & { VERSION?: string }).VERSION

/** Keep the default data source's markers current without revisiting them every frame while covered. */
export function bindCoveredMarkerUpdates(viewer: Cesium.Viewer): (() => void) | undefined {
  if (version !== '1.147.0' || viewer.isDestroyed()) return undefined

  // Viewer doesn't pass the public visualizersCallback option to DataSourceDisplay. Keep this internal dependency
  // scoped to the tested Cesium version and this viewer's default data source.
  const source = viewer.dataSourceDisplay?.defaultDataSource
  if (!source || source.entities !== viewer.entities) return undefined
  const internal = (source as Cesium.CustomDataSource & { _visualizers?: unknown })._visualizers
  if (!Array.isArray(internal)) return undefined

  const visualizers: unknown[] = internal
  const markers = [Cesium.BillboardVisualizer, Cesium.LabelVisualizer, Cesium.PointVisualizer].map((type) =>
    visualizers.find((visualizer): visualizer is MarkerVisualizer => visualizer instanceof type),
  )
  if (!markers.every((marker): marker is MarkerVisualizer => Boolean(marker && !marker.isDestroyed()
    && typeof marker.update === 'function' && !Object.hasOwn(marker, 'update') && Object.isExtensible(marker)))) return undefined

  const entities = source.entities
  const remove = markers.map((marker) => {
    const update = marker.update
    let releasedWhileHidden = false
    const wrapped = (time: Cesium.JulianDate) => {
      const showing = entities.show
      if (!showing && releasedWhileHidden) return true
      // The first hidden update releases any visible primitives. On return, update from the current entities.
      const ready = update.call(marker, time)
      releasedWhileHidden = !showing && ready
      return ready
    }
    // Cesium's destroyObject replaces enumerable methods on the retired visualizer.
    Object.defineProperty(marker, 'update', { value: wrapped, configurable: true, enumerable: true, writable: true })
    return () => {
      if (marker.update === wrapped) Reflect.deleteProperty(marker, 'update')
    }
  })

  return () => {
    if (!viewer.isDestroyed()) for (const restore of remove) restore()
  }
}
