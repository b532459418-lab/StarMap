// Cesium sorts a copy of its camera and screen-space input modifiers during Viewer setup.
if (typeof Array.prototype.toSorted !== 'function') {
  Object.defineProperty(Array.prototype, 'toSorted', {
    configurable: true,
    writable: true,
    value: function toSorted<T>(this: ArrayLike<T>, compare?: (left: T, right: T) => number): T[] {
      if (compare !== undefined && typeof compare !== 'function') throw new TypeError('Invalid sort comparator')
      if (this == null) throw new TypeError('Array.prototype.toSorted requires a receiver')

      // Read by index, including holes as undefined, without using the receiver's iterator or sort method.
      const copy = Array.from({ length: this.length }, (_, index) => this[index])
      return copy.sort(compare)
    },
  })
}
