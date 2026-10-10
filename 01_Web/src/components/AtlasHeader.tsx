import { LanguageSelector } from './LanguageSelector'
import { useUiLocale } from '../i18n/useUiLocale'
import { repositoryPreviewActive } from '../data/appData'

export type AtlasPage = 'map' | 'journey' | 'collection' | 'about'

type AtlasHeaderProps = {
  activePage: AtlasPage
  onPageChange: (page: AtlasPage) => void
  /** 当前页面已滚离顶部：标题换上玻璃背景，避免与下面滚过的内容叠在一起。 */
  scrolled?: boolean
  /** 当前页面滚动条的宽度（px）：玻璃背景右侧让出这一段，不压暗经典滚动条。 */
  scrollbarWidth?: number
}

const navItems: { id: AtlasPage }[] = [
  { id: 'map' },
  { id: 'journey' },
  { id: 'collection' },
]

export function AtlasHeader({ activePage, onPageChange, scrolled, scrollbarWidth = 0 }: AtlasHeaderProps) {
  const { t } = useUiLocale()
  return (
    <header
      className="atlas-app-header cesium-lab-title hero-glass-layer absolute left-[50vw] top-4 z-50 w-[min(760px,calc(100vw-32px))] -translate-x-1/2 px-6 py-4 text-center sm:px-8"
      data-page="map"
      data-active-page={activePage}
      data-scrolled={scrolled ? 'true' : 'false'}
      style={{ '--atlas-page-scrollbar': `${scrollbarWidth}px` } as React.CSSProperties}
    >
      <h1 className="text-4xl font-semibold tracking-normal text-slate-950 sm:text-5xl">
        StarMap
      </h1>
      <p className="mx-auto mt-2 max-w-2xl text-sm leading-6 text-white sm:text-base">
        {t('subtitle')}
      </p>
      {repositoryPreviewActive && (
        <p role="status" data-repository-readonly-preview className="mx-auto mt-2 text-sm leading-6 text-slate-950">
          {t('repositoryReadonlyPreview')}
        </p>
      )}
      <div className="atlas-header-controls">
        <nav
          className="atlas-tabs mx-auto mt-4 inline-flex items-center gap-1 rounded-full border border-white/70 bg-white/50 p-1 text-sm font-medium text-slate-500 shadow-sm backdrop-blur-xl"
          aria-label={t('navigation')}
        >
          {navItems.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => onPageChange(item.id)}
              aria-current={activePage === item.id ? 'page' : undefined}
              className={`rounded-full px-4 py-2 transition ${
                activePage === item.id
                  ? 'bg-slate-950 text-white shadow-[0_12px_30px_rgba(15,23,42,0.16)]'
                  : 'hover:bg-white/70 hover:text-slate-950'
              }`}
            >
              {t(item.id)}
            </button>
          ))}
        </nav>
        <LanguageSelector />
      </div>
    </header>
  )
}
