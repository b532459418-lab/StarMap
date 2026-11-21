import assert from 'node:assert/strict'
import test from 'node:test'
import { Cartesian3, GeometryInstance, Matrix3, Matrix4, PolylineGeometry, PrimitiveCollection } from 'cesium'
import type { Geometry, GeometryAttribute, GeometryAttributes, Material } from 'cesium'
import { createSkyPolylineBatch } from './skyPolylinePrimitives.ts'

function material() {
  let destroyed = false
  let calls = 0
  // CPU ownership tests only. The single-layer browser comparison uses the real Fabric material.
  const value = {
    uniforms: { phase: 0 },
    isDestroyed: () => destroyed,
    destroy() { assert.equal(destroyed, false); destroyed = true; calls++; return undefined },
  } as unknown as Material
  return { value, calls: () => calls }
}
const positions = () => Cartesian3.fromDegreesArrayHeights([-4, 12, 78500000, 0, 13, 78500000, 4, 12, 78500000])
function descriptor(batch: ReturnType<typeof createSkyPolylineBatch>) {
  return (batch.resources[0].primitive.geometryInstances as GeometryInstance).geometry as unknown as PolylineGeometry
}
function attributes(geometry: Geometry) {
  const value = geometry.attributes as GeometryAttributes & { expandAndWidth?: GeometryAttribute }
  assert(value.position && value.st && value.expandAndWidth)
  return { position: value.position, st: value.st, expandAndWidth: value.expandAndWidth }
}

test('straight high-altitude segments keep their original positions, width and independent ST', () => {
  const parent = new PrimitiveCollection(), m = material(), points = positions()
  const batch = createSkyPolylineBatch(parent, [{ positions: points, width: 244, createMaterial: () => m.value }])
  const geometry = PolylineGeometry.createGeometry(descriptor(batch))!
  // GEODESIC would generate432 vertices for these same3 points. NONE has8.
  const values = attributes(geometry)
  assert.equal(values.position.values.length / 3, 8)
  assert.equal(geometry.indices!.length, 12)
  assert.deepEqual([...new Set(Array.from(values.st.values))].sort(), [0, 0.5, 1])
  const widths = Array.from(values.expandAndWidth.values).filter((_v, i) => i % 2 === 1)
  assert(widths.every(v => Math.abs(v) === 244))
  assert(geometry.boundingSphere && Number.isFinite(geometry.boundingSphere.radius))
  assert.equal(batch.resources[0].primitive.compressVertices, false)
  assert.equal(batch.resources[0].primitive.asynchronous, false)
  points[0].x = 0
  assert.deepEqual(attributes(PolylineGeometry.createGeometry(descriptor(batch))!).position.values, values.position.values)
  batch.destroy(); parent.destroy()
})

test('rotation and phase updates retain geometry, primitive, material and matrix identities', () => {
  const parent = new PrimitiveCollection(), m = material()
  let created = 0
  const batch = createSkyPolylineBatch(parent, [{ positions: positions(), width: 44, createMaterial: () => { created++; return m.value } }])
  const { primitive, material: heldMaterial } = batch.resources[0]
  const geometry = primitive.geometryInstances, matrix = primitive.modelMatrix
  for (let i = 0; i < 40; i++) {
    const transform = Matrix4.fromRotationTranslation(Matrix3.fromRotationZ(i / 10))
    batch.setModelMatrix(transform)
    m.value.uniforms.phase = i * 0.82
    assert(Matrix4.equals(primitive.modelMatrix, transform))
    assert.equal(primitive.modelMatrix, matrix)
    assert.equal(primitive.geometryInstances, geometry)
    assert.equal(batch.resources[0].primitive, primitive)
    assert.equal(batch.resources[0].material, heldMaterial)
  }
  assert.equal(created, 1)
  batch.destroy(); parent.destroy()
})

test('transparent depth state, culling and picking keep their original defaults', () => {
  const parent = new PrimitiveCollection(), m = material()
  const batch = createSkyPolylineBatch(parent, [{ positions: positions(), width: 44, createMaterial: () => m.value }])
  const primitive = batch.resources[0].primitive
  assert.equal(primitive.appearance!.renderState.depthTest.enabled, true)
  assert.equal(primitive.appearance!.renderState.depthMask, false)
  assert.equal(primitive.appearance!.translucent, true)
  assert.equal(primitive.cull, true)
  assert.equal(primitive.allowPicking, true)
  batch.destroy(); parent.destroy()
})

test('an empty owner keeps its scene insertion slot; later paths have separate materials', () => {
  const parent = new PrimitiveCollection(), first = material(), second = material()
  const batch = createSkyPolylineBatch(parent)
  const later = parent.add(new PrimitiveCollection())
  batch.add([{ positions: positions(), width: 44, createMaterial: () => first.value }, { positions: positions(), width: 72, createMaterial: () => second.value }])
  assert.equal(parent.get(0), batch.collection)
  assert.equal(parent.get(1), later)
  first.value.uniforms.phase = 9
  assert.equal(second.value.uniforms.phase, 0)
  batch.destroy(); parent.destroy()
})

test('normal removal destroys every primitive and material exactly once', () => {
  const parent = new PrimitiveCollection(), a = material(), b = material()
  const batch = createSkyPolylineBatch(parent, [a, b].map(m => ({ positions: positions(), width: 44, createMaterial: () => m.value })))
  const held = batch.resources
  batch.destroy(); batch.destroy()
  assert.equal(parent.length, 0)
  assert(held.every(r => r.primitive.isDestroyed()))
  assert.deepEqual([a.calls(), b.calls()], [1, 1])
  assert.throws(() => batch.setModelMatrix(Matrix4.IDENTITY), /destroyed/)
  parent.destroy()
})

test('scene destruction first still releases materials without accessing destroyed collections', () => {
  const parent = new PrimitiveCollection(), m = material()
  const batch = createSkyPolylineBatch(parent, [{ positions: positions(), width: 44, createMaterial: () => m.value }])
  const primitive = batch.resources[0].primitive
  parent.destroy()
  assert.equal(primitive.isDestroyed(), true)
  assert.equal(m.calls(), 0) // Primitive itself does not own appearance.material.
  batch.destroy(); batch.destroy()
  assert.equal(m.calls(), 1)
})

test('a parent that retains removed primitives does not leave this owner alive', () => {
  const parent = new PrimitiveCollection({ destroyPrimitives: false }), m = material()
  const batch = createSkyPolylineBatch(parent, [{ positions: positions(), width: 44, createMaterial: () => m.value }])
  const child = batch.collection, primitive = batch.resources[0].primitive
  batch.destroy()
  assert(child.isDestroyed() && primitive.isDestroyed())
  assert.equal(m.calls(), 1)
  parent.destroy()
})

test('a failed later material factory rolls back only that addition, leaving earlier layers valid', () => {
  const parent = new PrimitiveCollection(), a = material(), b = material(), failure = new Error('factory failed')
  const batch = createSkyPolylineBatch(parent, [{ positions: positions(), width: 44, createMaterial: () => a.value }])
  assert.throws(() => batch.add([{ positions: positions(), width: 72, createMaterial: () => b.value }, { positions: positions(), width: 96, createMaterial: () => { throw failure } }]), e => e === failure)
  assert.equal(batch.resources.length, 1)
  assert.equal(batch.collection.length, 1)
  assert.deepEqual([a.calls(), b.calls()], [0, 1])
  batch.destroy(); parent.destroy()
})

test('an initial factory failure removes the scene insertion and releases its successful prefix', () => {
  const parent = new PrimitiveCollection(), m = material()
  assert.throws(() => createSkyPolylineBatch(parent, [{ positions: positions(), width: 44, createMaterial: () => m.value }, { positions: positions(), width: 72, createMaterial: () => { throw new Error('failed') } }]), /failed/)
  assert.equal(parent.length, 0)
  assert.equal(m.calls(), 1)
  parent.destroy()
})

test('a throwing scene insertion listener cannot leak an already inserted owner', () => {
  const parent = new PrimitiveCollection()
  parent.primitiveAdded.addEventListener(() => { throw new Error('insertion failed') })
  assert.throws(() => createSkyPolylineBatch(parent), /insertion failed/)
  assert.equal(parent.length, 0)
  parent.destroy()
})

test('thin, non-finite and invalid-position inputs are refused without adopting them', () => {
  const parent = new PrimitiveCollection()
  for (const width of [0.95, 0, -1, NaN, Infinity]) assert.throws(() => createSkyPolylineBatch(parent, [{ positions: positions(), width, createMaterial: () => { throw new Error('should not be called') } }]), /width/)
  for (const points of [[], [new Cartesian3()], [new Cartesian3(NaN, 0, 0), new Cartesian3()]]) assert.throws(() => createSkyPolylineBatch(parent, [{ positions: points, width: 44, createMaterial: () => { throw new Error('should not be called') } }]), /positions/)
  assert.equal(parent.length, 0)
  parent.destroy()
})

test('one material cannot be shared by independently owned layers or destroyed twice', () => {
  const parent = new PrimitiveCollection(), m = material()
  const batch = createSkyPolylineBatch(parent, [{ positions: positions(), width: 44, createMaterial: () => m.value }])
  assert.throws(() => batch.add([{ positions: positions(), width: 72, createMaterial: () => m.value }]), /shared/)
  assert.equal(m.calls(), 0)
  batch.destroy()
  assert.equal(m.calls(), 1)
  parent.destroy()
})

test('a remounted owner has independent resources and cannot revive a destroyed batch', () => {
  const parent = new PrimitiveCollection(), a = material(), b = material()
  const first = createSkyPolylineBatch(parent, [{ positions: positions(), width: 44, createMaterial: () => a.value }])
  first.destroy()
  const next = createSkyPolylineBatch(parent, [{ positions: positions(), width: 44, createMaterial: () => b.value }])
  assert.throws(() => first.add([]), /destroyed/)
  assert.equal(b.calls(), 0)
  assert.equal(parent.length, 1)
  next.destroy(); parent.destroy()
})
