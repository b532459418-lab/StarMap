import { useTranslation } from 'react-i18next'
import { Check, Plus, Settings2, Undo2, X } from 'lucide-react'

type LocalEditorToolbarProps = {
  editing: boolean
  busy?: boolean
  label: string
  onToggle: () => void
  onReset?: () => void
  onSave?: () => void
  onAdd?: () => void
}

export function LocalEditorToolbar({
  editing,
  busy = false,
  label,
  onToggle,
  onReset,
  onSave,
  onAdd,
}: LocalEditorToolbarProps) {
  const { t } = useTranslation(['details', 'editor', 'journey'])
  return (
    <div className="atlas-local-editor-actions" onClick={(event) => event.stopPropagation()}>
      {editing ? (
        <>
          {onReset ? (
            <button type="button" onClick={onReset} disabled={busy} aria-label={t('editor:undoFor', { label })} title={t('editor:undoTitle')}>
              <Undo2 />
            </button>
          ) : null}
          {onAdd ? (
            <button type="button" onClick={onAdd} disabled={busy} aria-label={t('editor:addFor', { label })} title={t('editor:add')}>
              <Plus />
            </button>
          ) : null}
          {onSave ? (
            <button type="button" data-primary="true" onClick={onSave} disabled={busy} aria-label={t('editor:saveFor', { label })} title={t('editor:save')}>
              <Check />
            </button>
          ) : null}
        </>
      ) : null}
      <button
        type="button"
        data-active={editing}
        onClick={onToggle}
        disabled={busy}
        aria-label={editing ? t('editor:exitFor', { label }) : t('editor:editFor', { label })}
        title={editing ? t('editor:exitEdit') : t('editor:localEdit')}
      >
        {editing ? <X /> : <Settings2 />}
      </button>
    </div>
  )
}
