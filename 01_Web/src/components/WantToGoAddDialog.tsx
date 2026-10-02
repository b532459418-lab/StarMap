import { useLocalizedNotice } from '../i18n/useLocalizedNotice'
import { useTranslation } from 'react-i18next'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Search, X } from 'lucide-react'
import { addLocalWantToGo, reloadAfterLocalSave, searchLocalCities, searchLocalCountries } from '../data/localEditorApi'
import type { CitySearchOption, CountrySearchOption, LocalWantToGoInput } from '../data/localEditorApi'
import { LocationSearchField } from './LocationSearchField'

type WantToGoAddDialogProps = {
  open: boolean
  onClose: () => void
}

type PlaceKind = LocalWantToGoInput['place']['kind']

const noteMaxLength = 200

const emptyManualCity = { nameZh: '', nameEn: '', lat: '', lng: '' }

/**
 * 「添加想去的地方」对话框（PRD FR-WTG-3 / §7 F1）。只在私人模式下由 App 挂载。
 *
 * 关闭时整个内容卸载，下次打开是一张干净的表单。写入只走 localEditorApi（D26）；
 * 成功后整页刷新（reloadAfterLocalSave），失败把服务端的 error 留在对话框里，不关闭（F1 第 4 步）。
 */
export function WantToGoAddDialog({ open, onClose }: WantToGoAddDialogProps) {
  return open ? <WantToGoAddDialogContent onClose={onClose} /> : null
}

function WantToGoAddDialogContent({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation(['details', 'editor', 'journey'])
  const titleId = useId()
  const disabledCityInputId = useId()
  const formRef = useRef<HTMLFormElement>(null)
  const [kind, setKind] = useState<PlaceKind>('city')
  const [countryOption, setCountryOption] = useState<CountrySearchOption>()
  const [cityOption, setCityOption] = useState<CitySearchOption>()
  const [isManualCityEntry, setIsManualCityEntry] = useState(false)
  const [manualCity, setManualCity] = useState(emptyManualCity)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useLocalizedNotice()
  const countryCode = countryOption?.countryCode

  // 与 InfoCard 的城市检索同一个端点；国家代码来自上面选中的国家。
  const searchCityOptions = useCallback((query: string, signal: AbortSignal) => {
    if (!countryCode) return Promise.reject(new Error(t('editor:selectCountryFirst')))
    return searchLocalCities(query, countryCode, signal)
  }, [countryCode, t])

  // 打开时焦点进入第一个输入框（国家检索）。
  useEffect(() => {
    formRef.current?.querySelector<HTMLInputElement>('input')?.focus()
  }, [])

  // Esc 关闭；提交中不响应。检索框的候选列表开着时，第一下 Esc 只收起列表。
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || busy) return
      const target = event.target as HTMLElement | null
      if (target?.getAttribute('role') === 'combobox' && target.getAttribute('aria-expanded') === 'true') return
      onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [busy, onClose])

  const selectCountry = (option?: CountrySearchOption) => {
    setCountryOption(option)
    // 换国家后原来的城市候选已不属于它。
    setCityOption(undefined)
    setNotice('')
  }

  // 城市相关输入在"没选国家"或"提交中"时禁用：国家代码是想去条目的必填项。
  const cityFieldsDisabled = !countryOption || busy
  const isCityReady = isManualCityEntry
    ? Boolean(manualCity.nameZh.trim() && manualCity.lat.trim() && manualCity.lng.trim())
    : Boolean(cityOption)
  const canSubmit = !busy && Boolean(countryOption) && (kind === 'country' || isCityReady)

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!countryOption || !canSubmit) return

    let place: LocalWantToGoInput['place']
    if (kind === 'country') {
      place = {
        kind: 'country',
        nameZh: countryOption.nameZh,
        nameEn: countryOption.nameEn,
        countryCode: countryOption.countryCode,
        lat: countryOption.centerLat,
        lng: countryOption.centerLng,
      }
    } else {
      // 手动坐标的校验规则与 InfoCard 的手动城市一致。
      const manualLat = Number(manualCity.lat)
      const manualLng = Number(manualCity.lng)
      const city = isManualCityEntry
        ? {
            nameZh: manualCity.nameZh.trim(),
            nameEn: (manualCity.nameEn || manualCity.nameZh).trim(),
            lat: manualLat,
            lng: manualLng,
          }
        : cityOption
      if (
        !city?.nameZh
        || !city.nameEn
        || (isManualCityEntry && (!manualCity.lat.trim() || !manualCity.lng.trim()))
        || !Number.isFinite(city.lat)
        || !Number.isFinite(city.lng)
        || city.lat < -90
        || city.lat > 90
        || city.lng < -180
        || city.lng > 180
      ) {
        setNotice({ key: 'editor:invalidCity' })
        return
      }
      place = {
        kind: 'city',
        nameZh: city.nameZh,
        nameEn: city.nameEn,
        countryCode: countryOption.countryCode,
        lat: city.lat,
        lng: city.lng,
      }
    }

    setBusy(true)
    setNotice({ key: 'editor:adding' })
    try {
      await addLocalWantToGo({ place, note: note.trim() || undefined })
      reloadAfterLocalSave()
    } catch (error) {
      // 例如重复添加时服务端返回「这个地方已在想去列表中。」（FR-WTG-8）。
      setNotice(error instanceof Error ? error.message : { key: 'editor:addFailed' })
      setBusy(false)
    }
  }

  return (
    <div
      className="atlas-wtg-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
    >
      <section className="atlas-wtg-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="atlas-wtg-dialog-header">
          <div>
            <p>{t('editor:wantToGo')}</p>
            <h2 id={titleId}>{t('editor:addWantToGo')}</h2>
          </div>
          <button
            type="button"
            className="atlas-wtg-dialog-close"
            aria-label={t('editor:closeAdd')}
            disabled={busy}
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </button>
        </header>

        <form ref={formRef} className="atlas-local-editor-form atlas-wtg-dialog-form" onSubmit={submit}>
          <div className="atlas-wtg-kind" role="radiogroup" aria-label={t('editor:kind')}>
            {([['city', t('editor:city')], ['country', t('editor:wholeCountry')]] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={kind === value}
                data-active={kind === value}
                disabled={busy}
                onClick={() => {
                  setKind(value)
                  setNotice('')
                }}
              >
                {label}
              </button>
            ))}
          </div>

          <LocationSearchField
            label={t('editor:country')}
            placeholder={t('editor:countrySearch')}
            selected={countryOption}
            search={searchLocalCountries}
            onSelect={selectCountry}
            minQueryLength={0}
            getMeta={(option) => `${option.countryCode}${option.region ? ` · ${option.region}` : ''}`}
          />

          {kind === 'city' && isManualCityEntry ? (
            <div className="atlas-local-editor-form-grid">
              <label className="atlas-local-editor-date-field">
                <span>{t('editor:cityNameZh')}</span>
                <input required disabled={cityFieldsDisabled} value={manualCity.nameZh} onChange={(event) => setManualCity((value) => ({ ...value, nameZh: event.target.value }))} />
              </label>
              <label className="atlas-local-editor-date-field">
                <span>{t('editor:englishName')}</span>
                <input disabled={cityFieldsDisabled} value={manualCity.nameEn} onChange={(event) => setManualCity((value) => ({ ...value, nameEn: event.target.value }))} />
              </label>
              <label className="atlas-local-editor-date-field">
                <span>{t('editor:latitudeRange')}</span>
                <input required disabled={cityFieldsDisabled} type="number" min="-90" max="90" step="any" value={manualCity.lat} onChange={(event) => setManualCity((value) => ({ ...value, lat: event.target.value }))} />
              </label>
              <label className="atlas-local-editor-date-field">
                <span>{t('editor:longitudeRange')}</span>
                <input required disabled={cityFieldsDisabled} type="number" min="-180" max="180" step="any" value={manualCity.lng} onChange={(event) => setManualCity((value) => ({ ...value, lng: event.target.value }))} />
              </label>
            </div>
          ) : null}

          {kind === 'city' && !isManualCityEntry && countryOption ? (
            <LocationSearchField
              // 换国家时重置检索框里的文字与候选。
              key={countryOption.countryCode}
              label={t('editor:city')}
              placeholder={t('editor:citySearch')}
              selected={cityOption}
              search={searchCityOptions}
              onSelect={setCityOption}
              minQueryLength={2}
              searchOnSubmit
              getMeta={(option) => option.detail}
            />
          ) : null}

          {kind === 'city' && !isManualCityEntry && !countryOption ? (
            // 未选国家时城市检索不可用：外观与 LocationSearchField 相同，但输入框禁用。
            <div className="atlas-location-search">
              <label htmlFor={disabledCityInputId}>{t('editor:city')}</label>
              <div className="atlas-location-search-input-wrap">
                <Search aria-hidden="true" />
                <input id={disabledCityInputId} type="search" disabled placeholder={t('editor:chooseCountryPlaceholder')} />
              </div>
            </div>
          ) : null}

          {kind === 'city' && !countryOption ? (
            <p className="atlas-wtg-hint">{t('editor:chooseCountryHint')}</p>
          ) : null}

          {kind === 'city' ? (
            <button
              type="button"
              className="atlas-local-editor-mode-toggle"
              disabled={cityFieldsDisabled}
              onClick={() => {
                setIsManualCityEntry((value) => !value)
                setCityOption(undefined)
                setManualCity(emptyManualCity)
                setNotice('')
              }}
            >
              {isManualCityEntry ? t('editor:onlineSearch') : t('editor:manualSearch')}
            </button>
          ) : null}

          {kind === 'city' && !isManualCityEntry ? (
            <p className="atlas-local-editor-attribution">
              {t('editor:searchAttribution')}{' '}
              <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a>{t('editor:attributionEnd')}
            </p>
          ) : null}

          <label className="atlas-local-editor-date-field atlas-wtg-note">
            <span>{t('editor:note')}</span>
            <textarea
              value={note}
              maxLength={noteMaxLength}
              rows={3}
              placeholder={t('editor:notePlaceholder')}
              onChange={(event) => setNote(event.target.value)}
            />
            <small>{note.length}/{noteMaxLength}</small>
          </label>

          {notice ? <p className="atlas-local-editor-notice atlas-wtg-dialog-notice" role="status">{notice}</p> : null}

          <button type="submit" disabled={!canSubmit}>{t('editor:confirmAdd')}</button>
        </form>
      </section>
    </div>
  )
}
