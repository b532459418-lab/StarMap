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
  const [notice, setNotice] = useState('')
  const countryCode = countryOption?.countryCode

  // 与 InfoCard 的城市检索同一个端点；国家代码来自上面选中的国家。
  const searchCityOptions = useCallback((query: string, signal: AbortSignal) => {
    if (!countryCode) return Promise.reject(new Error('请先选择国家。'))
    return searchLocalCities(query, countryCode, signal)
  }, [countryCode])

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
        setNotice('请填写城市名称及有效经纬度。')
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
    setNotice('正在添加…')
    try {
      await addLocalWantToGo({ place, note: note.trim() || undefined })
      reloadAfterLocalSave()
    } catch (error) {
      // 例如重复添加时服务端返回「这个地方已在想去列表中。」（FR-WTG-8）。
      setNotice(error instanceof Error ? error.message : '添加失败。')
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
            <p>想去 · Want to Go</p>
            <h2 id={titleId}>添加想去的地方</h2>
          </div>
          <button
            type="button"
            className="atlas-wtg-dialog-close"
            aria-label="关闭添加想去的地方"
            disabled={busy}
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </button>
        </header>

        <form ref={formRef} className="atlas-local-editor-form atlas-wtg-dialog-form" onSubmit={submit}>
          <div className="atlas-wtg-kind" role="radiogroup" aria-label="类型">
            {([['city', '城市'], ['country', '整个国家']] as const).map(([value, label]) => (
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
            label="国家"
            placeholder="输入中文、English、CN…"
            selected={countryOption}
            search={searchLocalCountries}
            onSelect={selectCountry}
            minQueryLength={0}
            getMeta={(option) => `${option.countryCode}${option.region ? ` · ${option.region}` : ''}`}
          />

          {kind === 'city' && isManualCityEntry ? (
            <div className="atlas-local-editor-form-grid">
              <label className="atlas-local-editor-date-field">
                <span>城市中文名</span>
                <input required disabled={cityFieldsDisabled} value={manualCity.nameZh} onChange={(event) => setManualCity((value) => ({ ...value, nameZh: event.target.value }))} />
              </label>
              <label className="atlas-local-editor-date-field">
                <span>英文名（可选）</span>
                <input disabled={cityFieldsDisabled} value={manualCity.nameEn} onChange={(event) => setManualCity((value) => ({ ...value, nameEn: event.target.value }))} />
              </label>
              <label className="atlas-local-editor-date-field">
                <span>纬度（-90～90）</span>
                <input required disabled={cityFieldsDisabled} type="number" min="-90" max="90" step="any" value={manualCity.lat} onChange={(event) => setManualCity((value) => ({ ...value, lat: event.target.value }))} />
              </label>
              <label className="atlas-local-editor-date-field">
                <span>经度（-180～180）</span>
                <input required disabled={cityFieldsDisabled} type="number" min="-180" max="180" step="any" value={manualCity.lng} onChange={(event) => setManualCity((value) => ({ ...value, lng: event.target.value }))} />
              </label>
            </div>
          ) : null}

          {kind === 'city' && !isManualCityEntry && countryOption ? (
            <LocationSearchField
              // 换国家时重置检索框里的文字与候选。
              key={countryOption.countryCode}
              label="城市"
              placeholder="输入中文或 English，至少 2 个字…"
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
              <label htmlFor={disabledCityInputId}>城市</label>
              <div className="atlas-location-search-input-wrap">
                <Search aria-hidden="true" />
                <input id={disabledCityInputId} type="search" disabled placeholder="请先选择国家" />
              </div>
            </div>
          ) : null}

          {kind === 'city' && !countryOption ? (
            <p className="atlas-wtg-hint">请先选择国家，再检索或填写城市。</p>
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
              {isManualCityEntry ? '返回在线检索' : '搜索不到？手动填写坐标'}
            </button>
          ) : null}

          {kind === 'city' && !isManualCityEntry ? (
            <p className="atlas-local-editor-attribution">
              城市检索需要联网：优先使用 Cesium ion geocode；无权限、无结果或超时后回退{' '}
              <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a>。
            </p>
          ) : null}

          <label className="atlas-local-editor-date-field atlas-wtg-note">
            <span>备注（可选）</span>
            <textarea
              value={note}
              maxLength={noteMaxLength}
              rows={3}
              placeholder="为什么想去？"
              onChange={(event) => setNote(event.target.value)}
            />
            <small>{note.length}/{noteMaxLength}</small>
          </label>

          {notice ? <p className="atlas-local-editor-notice atlas-wtg-dialog-notice" role="status">{notice}</p> : null}

          <button type="submit" disabled={!canSubmit}>确认添加</button>
        </form>
      </section>
    </div>
  )
}
