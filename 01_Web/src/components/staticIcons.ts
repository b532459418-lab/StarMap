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

/**
 * `<Icon aria-hidden="true" />` of lucide as one element: lucide's default attributes in lucide's order, its classes
 * (the name and the aliases), then aria-hidden.
 */
export function staticIcon(Icon: LucideIcon): ReactElement {
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
    dangerouslySetInnerHTML: { __html: markupOf(icon.node) },
  })
}

/** The icons of Collection's cards (./CollectionPage.tsx), each shared by all cards. */
export const cardIcons = {
  locateFixed: staticIcon(LocateFixed),
  footprints: staticIcon(Footprints),
  pencilLine: staticIcon(PencilLine),
  eye: staticIcon(Eye),
  trash2: staticIcon(Trash2),
  eyeOff: staticIcon(EyeOff),
} as const
