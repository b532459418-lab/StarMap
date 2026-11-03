import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Eye, EyeOff, Footprints, LocateFixed, PencilLine, Trash2 } from 'lucide-react'
import { cardIcons, staticIcon } from './staticIcons.ts'

// 收藏页首开 (I-1): every icon of Collection's cards, with the attributes the cards pass (aria-hidden="true"), is the
// markup lucide renders, byte for byte.
const used = [
  ['locateFixed', LocateFixed],
  ['footprints', Footprints],
  ['pencilLine', PencilLine],
  ['eye', Eye],
  ['trash2', Trash2],
  ['eyeOff', EyeOff],
] as const

for (const [key, Icon] of used) {
  test(`the card icon ${key} is lucide's markup, byte for byte`, () => {
    const lucide = renderToStaticMarkup(createElement(Icon, { 'aria-hidden': 'true' }))
    assert.equal(renderToStaticMarkup(cardIcons[key]), lucide)
    assert.equal(renderToStaticMarkup(staticIcon(Icon)), lucide)
  })
}

test('the cards use exactly these icons (one shared element each)', () => {
  assert.deepEqual(Object.keys(cardIcons).sort(), used.map(([key]) => key).sort())
  // An alias of the icon is a class too (Trash2 is lucide's "trash" with the alias "trash-2").
  assert.match(renderToStaticMarkup(cardIcons.trash2), /class="lucide lucide-trash lucide-trash-2"/)
})
