/**
 * The root error boundary's notice (robustness batch, design §2.5), in both languages. Plain data: the notice reads it
 * directly (../components/RootCrashNotice.tsx), never through i18n, because it shows when the part that failed may be
 * the i18n layer itself. It is registered as the `appCrash` namespace too, so the i18n check keeps zh and en aligned.
 */
export const appCrashResources = {
  zh: {
    title: 'StarMap 出错了，页面没能显示。',
    detail: '重新加载页面通常可以恢复。已经保存的数据不受影响，还没有保存的修改可能会丢失。',
    technicalDetails: '技术细节',
    reload: '重新加载页面',
  },
  en: {
    title: 'StarMap ran into a problem and could not show the page.',
    detail: 'Reloading usually fixes it. Saved data is not affected; changes you had not saved may be lost.',
    technicalDetails: 'Technical details',
    reload: 'Reload page',
  },
}
