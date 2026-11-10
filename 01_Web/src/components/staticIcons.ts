import { createElement, type ReactElement } from 'react'
import { Eye, EyeOff, Footprints, LocateFixed, PencilLine, Trash2, type LucideIcon, type LucideIconData } from 'lucide-react'

/**
 * 收藏页首开 (I-1): the icons of Collection's cards as SVG elements built once, when this module loads, with the markup
 * lucide renders for them. 3 500 cards show 3–4 icons each: as lucide components each icon was two components (its
 * forwardRef and lucide's Icon, which builds the attributes on every render) and 2–6 child elements that React created
 * and checked one by one; as one shared element it is a single SVG element whose children the browser parses.
 *
 * - The markup comes only from lucide's own icon data (the node list of each icon, its name and aliases) and lucide's
 *   default attributes; no data of the page ever goes into it.
 * - `dangerouslySetInnerHTML` is used here and only here, for that reason: its string is built from lucide's icon
 *   definitions at module load and is the same for every card.
 * - ./staticIcons.test.ts locks every icon (with the attributes the cards pass) to lucide's own output, byte for byte:
 *   a lucide upgrade that changes an icon fails the test instead of changing the cards silently.
 *
 * 收藏页余量 (A2′): the cards' icons draw their shapes with fewer child elements where that changes no pixel. The groups
 * of `CARD_ICON_GROUPS` become one path each (a line as `M x1 y1 L x2 y2`; a path keeps its data, a leading relative
 * moveto made absolute); a group of one stays the element lucide renders, in lucide's order. Two kinds of merge change
 * pixels and are never made: a circle drawn as arcs (it rasterizes differently), and strokes that overlap in one path
 * (their antialiasing is computed once instead of twice). The groups are, for each icon, the partition with the fewest
 * elements that drew lucide's exact pixels in Chromium in every colour scheme and sub-pixel offset tried (the batch's
 * icon lab, CI run 42788265298); the cards' screenshots equal those of lucide's markup. The cards keep 29 050 icon
 * children instead of 54 950. The `<svg>` element itself is lucide's, byte for byte (./staticIcons.test.ts).
 */

type IconNode = LucideIconData['node']

/** The icon data a lucide icon component renders with (lucide's createLucideIcon: its forwardRef passes `icon`). */
const iconData = (Icon: LucideIcon): LucideIconData =>
  (Icon as unknown as { render: (props: object, ref: null) => { props: { icon: LucideIconData } } }).render({}, null).props.icon

const escapeAttribute = (value: unknown) => String(value).replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`)

/** The children of the icon as markup: lucide's nodes are SVG elements with SVG attribute names (React's `key` aside). */
const markupOf = (nodes: IconNode): string => nodes.map(([tag, attributes, children]) => {
  const attributeText = Object.entries(attributes).filter(([name]) => name !== 'key').map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`).join('')
  return `<${tag}${attributeText}>${children ? markupOf(children) : ''}</${tag}>`
}).join('')

/** Groups of an icon's shapes (indexes into lucide's node list), each drawn as one element. */
export type ShapeGroups = readonly (readonly number[])[]

/**
 * One shape of a lucide icon as path data, to be joined with others in one path: a line, or a path (a leading relative
 * moveto `m x y …` becomes `M x y l …`: in a joined path it would start from where the previous shape ended). A circle
 * is refused: drawn as arcs it does not give the circle's pixels.
 */
export function shapePath([tag, attributes]: IconNode[number]): string {
  const value = (name: string) => String((attributes as Record<string, unknown>)[name])
  if (tag === 'line') return `M${value('x1')} ${value('y1')}L${value('x2')} ${value('y2')}`
  if (tag !== 'path') throw new Error(`a <${tag}> is not joined into a path`)
  const data = value('d').trim()
  if (!data.startsWith('m')) return data
  const end = data.slice(1).search(/[a-zA-Z]/)
  const head = (end < 0 ? data.slice(1) : data.slice(1, end + 1)).trim().split(/[ ,]+/).filter(Boolean)
  return `M${head[0]} ${head[1]}${head.length > 2 ? `l${head.slice(2).join(' ')}` : ''}${end < 0 ? '' : data.slice(end + 1)}`
}

/** The children of the icon with its shapes in `groups`: a group of one as lucide renders it, a larger one as one path. */
export function groupedMarkupOf(nodes: IconNode, groups: ShapeGroups): string {
  return groups.map((group) => (group.length === 1
    ? markupOf([nodes[group[0]]])
    : `<path d="${escapeAttribute(group.map((index) => shapePath(nodes[index])).join(''))}"></path>`)).join('')
}

/** The shape groups of the cards' icons (see the module comment; the indexes are lucide's node order). */
export const CARD_ICON_GROUPS = {
  locateFixed: [[0, 1, 2, 3], [4], [5]],
  footprints: [[0, 1], [2, 3]],
  pencilLine: [[0, 1], [2]],
  eye: [[0], [1]],
  trash2: [[0, 1, 2, 4], [3]],
  eyeOff: [[0, 1, 2], [3]],
} as const satisfies Record<string, ShapeGroups>

/** The icon data of a lucide icon (its node list, name and aliases). */
export const lucideIconData = (Icon: LucideIcon): LucideIconData => iconData(Icon)

/**
 * `<Icon aria-hidden="true" />` of lucide as one element: lucide's default attributes in lucide's order, its classes
 * (the name and the aliases), then aria-hidden. With `groups`, its shapes are drawn in those groups (A2′).
 */
export function staticIcon(Icon: LucideIcon, groups?: ShapeGroups): ReactElement {
  const icon = iconData(Icon)
  const viewBoxWidth = icon.size ?? icon.width ?? 24
  const viewBoxHeight = icon.size ?? icon.height ?? 24
  const className = ['lucide', ...(icon.name ? [`lucide-${icon.name}`] : []), ...(icon.aliases ?? []).filter((alias) => alias.trim() !== '').map((alias) => `lucide-${alias}`)].join(' ')
  return createElement('svg', {
    xmlns: 'http://www.w3.org/2000/svg',
    width: 24,
    height: 24,
    viewBox: `0 0 ${viewBoxWidth} ${viewBoxHeight}`,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    className,
    'aria-hidden': 'true',
    dangerouslySetInnerHTML: { __html: groups ? groupedMarkupOf(icon.node, groups) : markupOf(icon.node) },
  })
}

/** The icons of Collection's cards (./CollectionPage.tsx), each shared by all cards. */
export const cardIcons = {
  locateFixed: staticIcon(LocateFixed, CARD_ICON_GROUPS.locateFixed),
  footprints: staticIcon(Footprints, CARD_ICON_GROUPS.footprints),
  pencilLine: staticIcon(PencilLine, CARD_ICON_GROUPS.pencilLine),
  eye: staticIcon(Eye, CARD_ICON_GROUPS.eye),
  trash2: staticIcon(Trash2, CARD_ICON_GROUPS.trash2),
  eyeOff: staticIcon(EyeOff, CARD_ICON_GROUPS.eyeOff),
} as const
