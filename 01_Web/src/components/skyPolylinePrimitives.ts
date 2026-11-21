import {
  ArcType,
  BlendingState,
  Cartesian3,
  GeometryInstance,
  Matrix4,
  PolylineGeometry,
  PolylineMaterialAppearance,
  Primitive,
  PrimitiveCollection,
} from 'cesium'
import type { Material } from 'cesium'

export type SkyPolylineSpec = {
  positions: readonly Cartesian3[]
  width: number
  createMaterial: () => Material
}

type SkyPolylineResource = { primitive: Primitive; material: Material }

/** A scene-local owner for static, independently shaded wide paths. No geometry work occurs on rotation. */
export function createSkyPolylineBatch(parent: PrimitiveCollection, initial: readonly SkyPolylineSpec[] = []) {
  const collection = new PrimitiveCollection()
  const resources: SkyPolylineResource[] = []
  let disposed = false

  function release(resource: SkyPolylineResource) {
    let failure: unknown
    try {
      if (!collection.isDestroyed() && collection.contains(resource.primitive)) collection.remove(resource.primitive)
    } catch (error) { failure = error }
    try {
      if (!resource.primitive.isDestroyed()) resource.primitive.destroy()
    } catch (error) { failure ??= error }
    try {
      if (!resource.material.isDestroyed()) resource.material.destroy()
    } catch (error) { failure ??= error }
    if (failure) throw failure
  }

  function destroy() {
    if (disposed) return
    disposed = true
    let failure: unknown
    // The scene may have destroyed this container already. Only isDestroyed is then valid.
    try {
      if (!parent.isDestroyed() && parent.contains(collection)) parent.remove(collection)
    } catch (error) { failure = error }
    try {
      if (!collection.isDestroyed()) collection.destroy()
    } catch (error) { failure ??= error }
    for (const resource of resources) {
      try { release(resource) } catch (error) { failure ??= error }
    }
    resources.length = 0
    if (failure) throw failure
  }

  function add(specs: readonly SkyPolylineSpec[]) {
    if (disposed || collection.isDestroyed()) throw new Error('Sky polyline batch is destroyed')
    const pending: SkyPolylineResource[] = []
    try {
      for (const spec of specs) {
        if (!Number.isFinite(spec.width) || spec.width < 1) throw new Error('A sky wide path needs a finite width of at least one pixel')
        if (spec.positions.length < 2 || spec.positions.some(p => ![p.x, p.y, p.z].every(Number.isFinite))) {
          throw new Error('A sky path needs at least two finite positions')
        }
        const material = spec.createMaterial()
        if (material.isDestroyed()) throw new Error('Sky material is destroyed')
        // Each path owns its material; sharing would couple phase and destruction between layers.
        if ([...resources, ...pending].some(r => r.material === material)) throw new Error('Sky materials must not be shared')
        let primitive: Primitive | undefined
        try {
          primitive = new Primitive({
            geometryInstances: new GeometryInstance({
              geometry: new PolylineGeometry({
                positions: spec.positions.map(p => Cartesian3.clone(p)),
                width: spec.width,
                arcType: ArcType.NONE,
                vertexFormat: PolylineMaterialAppearance.VERTEX_FORMAT,
              }),
            }),
            appearance: new PolylineMaterialAppearance({
              material,
              translucent: true,
              renderState: { depthTest: { enabled: true }, depthMask: false, blending: BlendingState.ALPHA_BLEND },
            }),
            asynchronous: false,
            compressVertices: false,
          })
          pending.push({ primitive, material })
          collection.add(primitive)
        } catch (error) {
          // A constructor can fail before a resource exists; preserve the original creation error.
          if (!primitive) {
            try { if (!material.isDestroyed()) material.destroy() } catch { /* creation error takes precedence */ }
          }
          throw error
        }
      }
      resources.push(...pending)
    } catch (error) {
      for (const resource of pending) {
        try { release(resource) } catch { /* keep the creation error, while attempting every release */ }
      }
      throw error
    }
  }

  const batch = {
    collection,
    get resources(): readonly SkyPolylineResource[] { return resources.slice() },
    add,
    setModelMatrix(matrix: Matrix4) {
      if (disposed || collection.isDestroyed()) throw new Error('Sky polyline batch is destroyed')
      for (const { primitive } of resources) Matrix4.clone(matrix, primitive.modelMatrix)
    },
    destroy,
  }
  try {
    parent.add(collection)
    add(initial)
    return batch
  } catch (error) {
    try { destroy() } catch { /* keep the original creation/addition error */ }
    throw error
  }
}
