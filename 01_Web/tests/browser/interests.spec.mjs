import { test, expect, openMap, openCollection } from './helpers.mjs'
import { createBrowserFixture } from '../../scripts/browser-fixture.mjs'

const claim = (value) => ({ rank: 'normal', mainsnak: { datavalue: { value } } })
const item = (id, label, claims = {}) => ({ id, labels: { en: { value: label } }, claims })
const sampleEntities = {
  Q155653: item('Q155653', 'Before Sunrise', { P57: [claim({ id: 'Q1' })], P577: [claim({ time: '+1995-01-01T00:00:00Z' })] }),
  Q2263744: item('Q2263744', 'Sobrino de Botín', {
    P31: [claim({ id: 'Q11707' })], P625: [claim({ latitude: 40.4136, longitude: -3.7082, globe: 'http://www.wikidata.org/entity/Q2' })],
  }),
  Q132858911: item('Q132858911', '2025 Tokyo Marathon', {
    P641: [claim({ id: 'Q100348482' })], P585: [claim({ time: '+2025-03-02T00:00:00Z', precision: 11 })],
  }),
  Q1: item('Q1', 'Synthetic director'),
}

test.beforeEach(async () => { await createBrowserFixture(process.env.STARMAP_BROWSER_TEST_ROOT) })

test('three interests share preview, save, filtering and the map in the personal app', async ({ page }) => {
  await page.route('https://www.wikidata.org/w/api.php?**', (route) => {
    if (process.env.STARMAP_INTEREST_LIVE === '1') return route.continue()
    const ids = new URL(route.request().url()).searchParams.get('ids').split('|')
    const entities = Object.fromEntries(ids.flatMap((id) => {
      const row = sampleEntities[id === 'Q20464692' ? 'Q155653' : id]
      return row ? [[row.id, row]] : []
    }))
    return route.fulfill({ headers: { 'Access-Control-Allow-Origin': '*' }, json: { entities } })
  })
  await openMap(page)
  await openCollection(page)
  const openInterests = () => page.getByRole('button', { name: 'Interests', exact: true }).click()
  await openInterests()
  const cards = page.locator('.interest-card')
  const save = async () => {
    const answer = page.waitForResponse((response) => response.url().endsWith('/__travelatlas/editor/interests') && response.request().method() === 'POST')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    const response = await answer
    const body = await response.json()
    expect(response.ok(), JSON.stringify(body)).toBe(true)
    await expect(page.getByRole('region', { name: 'Edit interest' })).toHaveCount(0)
    return body
  }
  const importItem = async (kind, id, configure) => {
    await page.getByRole('button', { name: 'Add interest', exact: true }).click()
    await page.getByRole('combobox', { name: 'Template', exact: true }).selectOption(kind)
    await page.getByRole('button', { name: 'Fill from a link' }).click()
    await page.getByLabel('Wikidata URL').fill('https://www.wikidata.org/wiki/' + id)
    await page.getByRole('button', { name: 'Preview import' }).click()
    await expect(page.getByText('Wikidata fields are ready to review before saving.')).toBeVisible()
    const name = await page.getByLabel('Name', { exact: true }).inputValue()
    expect(name).not.toBe('')
    if (configure) await configure()
    return { name, ...await save() }
  }
  const food = await importItem('food', 'Q2263744', async () => {
    await page.getByRole('region', { name: 'Edit interest' }).getByRole('combobox', { name: 'Status' }).selectOption('done')
    await page.getByLabel('My notes').fill('Test first visit')
  })
  const movie = await importItem('movie', 'Q155653', async () => {
    await page.getByRole('combobox', { name: 'Viewing place' }).selectOption({ label: 'Reykjavik' })
    await page.getByLabel('Viewing date').fill('2026-11-08')
    await page.getByLabel('My rating (0–5)').fill('4')
  })
  const race = await importItem('race', 'Q132858911', async () => {
    await page.getByRole('combobox', { name: 'Place for this activity' }).selectOption({ label: 'Nuuk' })
    await page.getByLabel('Finish time').fill('03:58:12')
  })
  expect(new Set([food.entityId, movie.entityId, race.entityId]).size).toBe(3)
  await expect(cards).toHaveCount(3)

  const duplicate = await importItem('movie', 'Q20464692')
  expect(duplicate).toMatchObject({ entityId: movie.entityId, existingMatch: true, unchanged: true })
  await expect(cards).toHaveCount(3)
  const film = page.locator('#interest-' + movie.id)
  await film.getByRole('button', { name: 'Add viewing' }).click()
  await page.getByLabel('Viewing date').fill('2026-11-09')
  const second = await save()
  await expect(page.locator('#interest-' + second.id).getByRole('button', { name: 'View on map' })).toHaveCount(0)
  await page.locator('#interest-' + food.id).getByRole('button', { name: 'Add visit' }).click()
  await page.getByLabel('Visit date').fill('2026-11-10')
  await page.getByLabel('My notes').fill('Test second visit')
  const repeat = await save()
  expect(repeat.entityId).toBe(food.entityId)

  await film.getByRole('button', { name: 'View on map' }).click()
  await expect(page.locator('.atlas-experience')).toHaveAttribute('data-page', 'map')
  await expect.poll(() => page.evaluate(() => window.__travelAtlasDebugCamera?.getCameraCommandState()))
    .toMatchObject({ source: 'place', status: 'completed' })
  await openCollectionFromMap(page)

  await page.getByRole('combobox', { name: 'Layer', exact: true }).selectOption({ label: 'Marathons' })
  await expect(cards).toHaveCount(1)
  await expect(cards.first()).toContainText('03:58:12')
  await page.getByRole('button', { name: 'Show list' }).click()
  await expect(page.locator('.interest-list .interest-card')).toHaveCount(1)
  await page.reload()
  await openInterests()
  await expect(cards).toHaveCount(5)
  await expect(page.locator('#interest-' + food.id)).toContainText('Test first visit')
  await expect(page.locator('#interest-' + repeat.id)).toContainText('Test second visit')
  await expect(film).toContainText('4 / 5')
  await expect(page.locator('#interest-' + race.id)).toContainText('03:58:12')
  await page.getByRole('button', { name: 'Want to Go', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Places you want to go', exact: true })).toBeVisible()
})

async function openCollectionFromMap(page) {
  await page.getByRole('navigation').getByRole('button', { name: 'Collection', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Interest collection', exact: true })).toBeVisible()
}
