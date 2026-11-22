import { useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { isCalendarDate } from '../worldgraph/timeFilter'

type EditorDateInputProps = {
  label: string
  value: string
  onChange: (value: string) => void
  min?: string
  required?: boolean
  disabled?: boolean
  readOnly?: boolean
}

const monthNumbers = Array.from({ length: 12 }, (_, index) => index + 1)
const dayNumbers = Array.from({ length: 31 }, (_, index) => index + 1)
const twoDigits = (value: number) => String(value).padStart(2, '0')

function initialDate(value: string, min?: string) {
  if (isCalendarDate(value)) return value
  const now = new Date()
  const today = `${now.getFullYear()}-${twoDigits(now.getMonth() + 1)}-${twoDigits(now.getDate())}`
  return isCalendarDate(min) && min > today ? min : today
}

export function EditorDateInput({ label, value, onChange, min, required, disabled, readOnly }: EditorDateInputProps) {
  // Meizu's Chromium 105 date dialog paints both actions white on white even on an unstyled page.
  const usePagePicker = !readOnly && typeof navigator !== 'undefined'
    && /\bMZBrowser\/12\.11\.0\b/.test(navigator.userAgent)
    && /\bChrome\/105\./.test(navigator.userAgent)
  if (usePagePicker) {
    return <PageDatePicker {...{ label, value, onChange, min, required, disabled }} />
  }
  return <input type="date" {...{ value, min, required, disabled, readOnly }} onChange={(event) => onChange(event.target.value)} />
}

function PageDatePicker({ label, value, onChange, min, required, disabled }: EditorDateInputProps) {
  const { t } = useTranslation('editor')
  const id = useId()
  const picker = useRef<HTMLDialogElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const monthField = useRef<HTMLSelectElement>(null)
  const [draft, setDraft] = useState({ year: '', month: '01', day: '01' })
  const selected = `${draft.year.padStart(4, '0')}-${draft.month}-${draft.day}`
  const valid = isCalendarDate(selected) && (!min || selected >= min)

  function openPicker() {
    if (disabled || !picker.current || document.querySelector('.atlas-editor-date-dialog[open]')) return
    const [year, month, day] = initialDate(value, min).split('-')
    setDraft({ year, month, day })
    picker.current.showModal()
    monthField.current?.focus()
  }

  function choose(next: string) {
    onChange(next)
    picker.current?.close()
  }

  return <>
    <button ref={trigger} type="button" className="atlas-editor-date-trigger" aria-label={`${label}: ${value || t('datePickerChoose')}`} aria-haspopup="dialog"
      disabled={disabled} onClick={openPicker}>{value || t('datePickerChoose')}</button>
    {/* Keep the form's native required and minimum validation. The dialog is the visible editor. */}
    <input type="date" hidden tabIndex={-1} {...{ value, min, required, disabled }}
      onChange={(event) => onChange(event.target.value)} onInvalid={(event) => {
        event.preventDefault()
        openPicker()
      }} />
    {createPortal(
      <dialog ref={picker} className="atlas-editor-date-dialog" aria-labelledby={id} onClose={() => trigger.current?.focus({ preventScroll: true })}
        onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
        <h2 id={id}>{label}</h2>
        <div className="atlas-editor-date-parts">
          <label>{t('datePickerYear')}
            <input type="text" inputMode="numeric" maxLength={4} value={draft.year}
              onChange={(event) => setDraft({ ...draft, year: event.target.value.replace(/\D/g, '') })} />
          </label>
          <label>{t('datePickerMonth')}
            <select ref={monthField} value={draft.month} onChange={(event) => setDraft({ ...draft, month: event.target.value })}>
              {monthNumbers.map((month) => <option key={month} value={twoDigits(month)}>{month}</option>)}
            </select>
          </label>
          <label>{t('datePickerDay')}
            <select value={draft.day} onChange={(event) => setDraft({ ...draft, day: event.target.value })}>
              {dayNumbers.map((day) => <option key={day} value={twoDigits(day)}
                disabled={!isCalendarDate(`${draft.year.padStart(4, '0')}-${draft.month}-${twoDigits(day)}`)}>{day}</option>)}
            </select>
          </label>
        </div>
        <div className="atlas-editor-date-actions">
          {!required && value ? <button type="button" onClick={() => choose('')}>{t('datePickerClear')}</button> : null}
          <button type="button" onClick={() => picker.current?.close()}>{t('datePickerCancel')}</button>
          <button type="button" disabled={!valid} onClick={() => choose(selected)}>{t('datePickerConfirm')}</button>
        </div>
      </dialog>, document.body)}
  </>
}
