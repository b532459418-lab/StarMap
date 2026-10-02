import { lazy, Suspense } from 'react'
import { ArrowUpRight, Check, Copy, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ReleaseUpdateState } from '../data/releaseUpdates'
import { useUiLocale } from '../i18n/useUiLocale'

const ReleaseMarkdown = lazy(() => import('./ReleaseMarkdown'))

type ReleaseUpdateButtonProps = {
  active: boolean
  state: ReleaseUpdateState
  onToggle: () => void
}

export function ReleaseUpdateButton({ active, state, onToggle }: ReleaseUpdateButtonProps) {
  const { t } = useTranslation('appShell')
  return (
    <button
      type="button"
      className="atlas-dock-button atlas-release-button pointer-events-auto"
      aria-label={t(active ? 'returnPrevious' : 'updates')}
      aria-current={active ? 'page' : undefined}
      title={t(active ? 'returnPrevious' : state.hasUnseenUpdate ? 'unseenUpdate' : 'updates')}
      data-update-available={state.hasUnseenUpdate ? 'true' : 'false'}
      onClick={onToggle}
    >
      <RefreshCw aria-hidden="true" className={state.status === 'checking' ? 'is-spinning' : ''} />
      {state.hasUnseenUpdate ? <span className="atlas-release-signal" aria-hidden="true" /> : null}
    </button>
  )
}

type ReleaseUpdatePageProps = {
  state: ReleaseUpdateState
}

export function ReleaseUpdatePage({ state }: ReleaseUpdatePageProps) {
  const { t } = useTranslation('appShell')
  const { locale } = useUiLocale()
  const statusCopy = state.status === 'checking'
    ? t('checking')
    : state.status === 'available' && state.release
      ? t('available', { version: state.release.tag_name })
      : state.status === 'current'
        ? state.message || t('current')
        : state.status === 'unconfigured'
          ? state.message || t('unconfigured')
          : state.message || t('waiting')

  const announcement = state.release?.body?.trim()
    || t('fallbackAnnouncement', { version: state.currentVersion })

  return (
    <div className="atlas-update-scroll selector-scrollbar h-full overflow-y-auto overscroll-contain">
      <div className="atlas-update-shell mx-auto w-full max-w-7xl px-5 pb-24 sm:px-8">
        <section className="update-command-panel">
          <div>
            <p className="journey-kicker">{t('releaseCenter')}</p>
            <h2>{t('updates')}</h2>
            <p>{t('introduction')}</p>
          </div>
          <div className="update-status-card" data-status={state.status}>
            <span className="update-status-light" aria-hidden="true" />
            <div>
              <p>{t('currentVersionValue', { version: state.currentVersion })}</p>
              <strong>{statusCopy}</strong>
            </div>
          </div>
        </section>

        <div className="update-content-grid">
          <section className="update-content-card update-guide-card">
            <p className="update-card-index">01</p>
            <p className="update-card-kicker">{t('guide')}</p>
            <h3>{t('updateGuide')}</h3>
            <ol>
              <li>{t('guideSave')}</li>
              <li>{t('guideRead')}</li>
              <li>{t('guideMerge')}</li>
              <li>{t('guideCheck')}</li>
            </ol>
          </section>

          <section className="update-content-card update-version-card">
            <p className="update-card-index">02</p>
            <p className="update-card-kicker">{t('versionNotes')}</p>
            <h3>{t('versionNotes')}</h3>
            <dl>
              <div><dt>{t('currentVersion')}</dt><dd>v{state.currentVersion}</dd></div>
              <div><dt>{t('latestVersion')}</dt><dd>{state.release?.tag_name ?? t('unpublished')}</dd></div>
              <div><dt>{t('publishedAt')}</dt><dd>{state.release?.published_at ? new Date(state.release.published_at).toLocaleDateString(locale) : '—'}</dd></div>
              <div><dt>{t('updateMethod')}</dt><dd>{t('manualMerge')}</dd></div>
            </dl>
            <p className="update-caution">
              {t('caution')}
            </p>
            <div className="update-page-actions">
              <button
                type="button"
                disabled={!state.release}
                onClick={() => void state.copyUpdatePrompt()}
              >
                {state.copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                {t(state.copied ? 'copied' : 'copyUpdatePrompt')}
              </button>
              <button
                type="button"
                disabled={state.status === 'checking'}
                onClick={() => void state.checkForUpdates(true)}
              >
                <RefreshCw aria-hidden="true" />
                {t('recheck')}
              </button>
            </div>
          </section>

          <section className="update-content-card update-announcement-card">
            <p className="update-card-index">03</p>
            <p className="update-card-kicker">{t('announcement')}</p>
            <h3>{t('announcement')}</h3>
            <div className="update-release-copy">
              <Suspense fallback={<p className="update-release-loading">{t('formatting')}</p>}>
                <ReleaseMarkdown source={announcement} />
              </Suspense>
            </div>
            {state.release ? (
              <a className="update-release-link" href={state.release.html_url} target="_blank" rel="noreferrer">
                {t('viewRelease')} <ArrowUpRight aria-hidden="true" />
              </a>
            ) : null}
          </section>
        </div>
      </div>
    </div>
  )
}
