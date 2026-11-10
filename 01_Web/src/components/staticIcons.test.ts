import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Eye, EyeOff, Footprints, LocateFixed, PencilLine, Trash2 } from 'lucide-react'
import { CARD_ICON_GROUPS, cardIcons, groupedMarkupOf, lucideIconData, shapePath, staticIcon } from './staticIcons.ts'

// 收藏页首开 (I-1): every icon of Collection's cards, with the attributes the cards pass (aria-hidden="true"), is the
// markup lucide renders. 收藏页余量 (A2′): its `<svg>` element still is, byte for byte; its children draw lucide's shapes
// in the groups of CARD_ICON_GROUPS (a group of one as lucide renders that shape, a larger group as one path).
const used = [
  ['locateFixed', LocateFixed],
  ['footprints', Footprints],
  ['pencilLine', PencilLine],
  ['eye', Eye],
  ['trash2', Trash2],
  ['eyeOff', EyeOff],
] as const

const lucideMarkup = (Icon: (typeof used)[number][1]) => renderToStaticMarkup(createElement(Icon, { 'aria-hidden': 'true' }))
const openingTag = (markup: string) => markup.slice(0, markup.indexOf('>') + 1)
const children = (markup: string) => markup.slice(markup.indexOf('>') + 1, markup.lastIndexOf('</svg>'))

for (const [key, Icon] of used) {
  test(`the card icon ${key}: lucide's <svg> element, byte for byte, and its shapes in their groups`, () => {
    const lucide = lucideMarkup(Icon)
    const mine = renderToStaticMarkup(cardIcons[key])
    assert.equal(openingTag(mine), openingTag(lucide))
    assert.equal(children(mine), groupedMarkupOf(lucideIconData(Icon).node, CARD_ICON_GROUPS[key]))
    // Without groups the element is lucide's markup, byte for byte (I-1).
    assert.equal(renderToStaticMarkup(staticIcon(Icon)), lucide)
  })

  test(`the card icon ${key}: every shape once, circles never joined, a lone shape as lucide renders it`, () => {
    const nodes = lucideIconData(Icon).node
    const groups = CARD_ICON_GROUPS[key]
    assert.deepEqual(groups.flat().sort((a, b) => a - b), nodes.map((_, index) => index))
    assert.deepEqual(groups.map((group) => group[0]), [...groups.map((group) => group[0])].sort((a, b) => a - b))
    for (const group of groups) {
      if (group.length > 1) assert.ok(group.every((index) => nodes[index][0] !== 'circle'), `${key}: a circle in ${JSON.stringify(group)}`)
      else {
        const [tag, attributes] = nodes[group[0]]
        const props = Object.fromEntries(Object.entries(attributes).filter(([name]) => name !== 'key'))
        assert.ok(children(renderToStaticMarkup(cardIcons[key])).includes(renderToStaticMarkup(createElement(tag, props))))
      }
    }
  })
}

// The children of each card icon as they are now: a lucide upgrade that changes an icon's shapes (or their order) fails
// here, and the groups must then be checked again for identical pixels (the batch's icon lab, see ./staticIcons.ts).
const snapshot = {
  locateFixed: '<path d="M2 12L5 12M19 12L22 12M12 2L12 5M12 19L12 22"></path><circle cx="12" cy="12" r="7"></circle><circle cx="12" cy="12" r="3"></circle>',
  footprints: '<path d="M4 16v-2.38C4 11.5 2.97 10.5 3 8c.03-2.72 1.49-6 4.5-6C9.37 2 10 3.8 10 5.5c0 3.11-2 5.66-2 8.68V16a2 2 0 1 1-4 0ZM20 20v-2.38c0-2.12 1.03-3.12 1-5.62-.03-2.72-1.49-6-4.5-6C14.63 6 14 7.8 14 9.5c0 3.11 2 5.66 2 8.68V20a2 2 0 1 0 4 0Z"></path><path d="M16 17h4M4 13h4"></path>',
  pencilLine: '<path d="M13 21h8M15 5l4 4"></path><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"></path>',
  eye: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"></path><circle cx="12" cy="12" r="3"></circle>',
  trash2: '<path d="M10 11v6M14 11v6M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><path d="M3 6h18"></path>',
  eyeOff: '<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49M14.084 14.158a3 3 0 0 1-4.242-4.242M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"></path><path d="m2 2 20 20"></path>',
} as const

test('the children of the card icons, as they are now', () => {
  for (const [key] of used) assert.equal(children(renderToStaticMarkup(cardIcons[key])), snapshot[key], key)
})

test('a shape joined into a path: lines, paths, a leading relative moveto; circles are refused', () => {
  assert.equal(shapePath(['line', { x1: '2', y1: '12', x2: '5', y2: '12' }]), 'M2 12L5 12')
  assert.equal(shapePath(['path', { d: 'M16 17h4' }]), 'M16 17h4')
  // `m15 5 4 4` is a moveto and a relative lineto; joined after another shape it must not start from that shape's end.
  assert.equal(shapePath(['path', { d: 'm15 5 4 4' }]), 'M15 5l4 4')
  assert.equal(shapePath(['path', { d: 'm2 2' }]), 'M2 2')
  assert.equal(shapePath(['path', { d: 'm2,2 3,1c1 1 2 2 3 3' }]), 'M2 2l3 1c1 1 2 2 3 3')
  assert.throws(() => shapePath(['circle', { cx: '12', cy: '12', r: '3' }]), /circle/)
})

test('the cards use exactly these icons (one shared element each)', () => {
  assert.deepEqual(Object.keys(cardIcons).sort(), used.map(([key]) => key).sort())
  assert.deepEqual(Object.keys(CARD_ICON_GROUPS).sort(), used.map(([key]) => key).sort())
  // An alias of the icon is a class too (Trash2 is lucide's "trash" with the alias "trash-2").
  assert.match(renderToStaticMarkup(cardIcons.trash2), /class="lucide lucide-trash lucide-trash-2"/)
})
