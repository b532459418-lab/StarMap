/**
 * V2 写入的事务骨架（v2write/transaction.ts）与错误码（v2write/errors.ts）的单元测试（RFC-LOC-1 PR3b-2 规格 §2.1、§2.4、§2.5、§3）。
 *
 * 运行方式：npm test。零依赖：Node 24 自带类型剥离，只用 node:test + node:assert/strict。
 */

/// <reference types="node" />

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { readV2 } from '../canonical/v2Reader.ts'
import { V2_FILE_KEYS, validateV2Files, type V2Files } from '../canonical/v2Schema.ts'
import { V2WriteError, V2_WRITE_ERROR_CODES, errorBody, messageFor } from './errors.ts'
import {
  completeForWrite,
  danglingPlaceRefs,
  emptyV2FilesForWrite,
  integrityProblems,
  placeRefs,
  removeUnreferencedPlaces,
  runV2Transaction,
} from './transaction.ts'
import { WRITE_NOW, migratedFiles, placeNamed, testContext } from './v2write.fixture.ts'

const assertV2Error = (run: () => unknown, code: string, check?: (error: V2WriteError) => void) => {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof V2WriteError, String(error))
    assert.equal(error.code, code, error.message)
    check?.(error)
    return true
  })
}

// ---------------------------------------------------------------------------
// 错误码
// ---------------------------------------------------------------------------

test('错误码：每个码都有一句非空的中文文案；V2WriteError 的 message 就是文案，响应体为 { ok: false, error, code, params? }', () => {
  for (const code of V2_WRITE_ERROR_CODES) {
    const message = messageFor(code, { field: 'country' })
    assert.ok(message.length > 0, code)
    assert.match(message, /\p{Script=Han}/u, code)
  }
  const error = new V2WriteError('E_REQUIRED', { field: 'country' })
  assert.equal(error.message, '请填写国家中文名。')
  assert.deepEqual(errorBody(error), { ok: false, error: '请填写国家中文名。', code: 'E_REQUIRED', params: { field: 'country' } })
  assert.deepEqual(errorBody(new V2WriteError('E_WTG_EXISTS')), { ok: false, error: '这个地方已在想去列表中。', code: 'E_WTG_EXISTS' })
})

test('错误码：旧模式有对应情形的码沿用旧文案（逐字）', () => {
  assert.equal(messageFor('E_CITY_EXISTS'), '这个城市已经存在；如需增加一次新的行程，请使用行程编辑，而不是重复添加城市。')
  assert.equal(messageFor('E_COUNTRY_EXISTS'), '这个国家已经存在于国家足迹中。')
  assert.equal(messageFor('E_COUNTRY_NOT_IN_CATALOG'), '没有找到这个国家，请从候选列表中选择。')
  assert.equal(messageFor('E_CONVERT_CITY_IN_FOOTPRINT'), '这个城市已经在足迹里了。如果只是想从想去列表移除，请使用隐藏或彻底删除。')
  assert.equal(messageFor('E_DATE_FORMAT', { field: 'visitedDate' }), '首次到访日期必须使用 YYYY-MM-DD。')
  assert.equal(messageFor('E_NUMBER_INVALID', { field: 'lat' }), '纬度无效。')
  assert.equal(messageFor('E_WTG_DELETE_NOT_HIDDEN', { ids: ['a', 'b'] }), '只能彻底删除已隐藏的想去记录。以下记录不符合条件：a、b')
  assert.equal(
    messageFor('E_COUNTRY_HAS_MEDIA', { cities: [{ placeId: 'x', name: '雷克雅未克', count: 2 }] }),
    '以下城市仍有照片或无人机影像：雷克雅未克（2 个媒体）。请先在对应城市中彻底删除这些媒体。',
  )
  // PR3b-3：媒体沿用旧模式上传、导入、删除的文案。
  assert.equal(messageFor('E_MEDIA_LOCATION_NOT_FOUND'), '找不到对应的国家和城市，请先把城市加入旅行数据。')
  assert.equal(messageFor('E_MEDIA_DELETE_NOT_HIDDEN'), '只能彻底删除当前城市中已经隐藏的照片或无人机影像。')
  assert.equal(messageFor('E_MEDIA_SOURCE_MISSING', { id: 'media-0011223344556677' }), '找不到媒体 media-0011223344556677 对应的投递箱原图，已停止删除。')
  assert.equal(messageFor('E_MEDIA_UPLOAD_REJECTED', { reason: '单个文件不能超过 250 MiB。' }), '单个文件不能超过 250 MiB。')
})

// ---------------------------------------------------------------------------
// 空文件模板
// ---------------------------------------------------------------------------

test('全新 V2 目录的空文件：足迹 schema_version 2、private-local、显示规则全空；想去 local-only；合法且读出来是空的', () => {
  const empty = emptyV2FilesForWrite(WRITE_NOW)
  assert.deepEqual(validateV2Files(empty), [])
  assert.deepEqual(integrityProblems(empty), [])
  assert.equal(empty.travel.schema_version, 2)
  assert.equal(empty.travel.privacy_level, 'private-local')
  assert.deepEqual(empty.travel.display, { homeHiddenCountryIds: [], originCountryIds: [], regionCountryIds: [], regionIncludes: [], navigationHiddenCityIds: [] })
  assert.equal(empty.wantToGo.privacy_level, 'local-only')
  assert.equal(empty.places.schema_version, 1)
  assert.equal(empty.editorState.schemaVersion, 2)
  assert.equal(empty.media.schemaVersion, 3)
  const canonical = readV2(empty)
  assert.equal(canonical.places.length + canonical.travel.records.length + canonical.wantToGo.items.length + canonical.media.items.length, 0)
})

test('completeForWrite：缺的文件补空模板，在的文件深拷贝（不共享引用，包括不合法的）', () => {
  const files = migratedFiles()
  const completed = completeForWrite({ places: files.places, travel: { broken: true } }, WRITE_NOW)
  assert.deepEqual(Object.keys(completed), V2_FILE_KEYS)
  assert.deepEqual(completed.places, files.places)
  assert.notEqual(completed.places, files.places)
  assert.deepEqual(completed.travel, { broken: true })
  assert.deepEqual(completed.wantToGo, emptyV2FilesForWrite(WRITE_NOW).wantToGo)
})

// ---------------------------------------------------------------------------
// 地点引用与完整性
// ---------------------------------------------------------------------------

test('placeRefs 覆盖全部地点引用的位置；danglingPlaceRefs 找出每一处悬空引用', () => {
  const files = migratedFiles()
  const iceland = placeNamed(files, 'Iceland').id
  const reykjavik = placeNamed(files, 'Reykjavik').id
  files.travel.display = {
    ...files.travel.display,
    homeHiddenCountryIds: [iceland],
    originCountryIds: [iceland],
    regionCountryIds: [iceland],
    navigationHiddenCityIds: [reykjavik],
  }
  files.editorState = {
    ...files.editorState,
    addedCountries: [{ placeId: iceland }],
    hiddenCountryIds: [iceland],
    cityOrderByCountry: { [iceland]: [reykjavik] },
    mediaOrderByCity: { [reykjavik]: ['photo-reykjavik-1'] },
    droneOrderByCity: { [reykjavik]: [] },
  }
  const wheres = new Set(placeRefs(files).map((ref) => ref.where.replace(/\(.*\)$/, '').replace(/\..*$/, '')))
  for (const where of [
    'partOf', 'display', 'records', 'items', 'addedCountries', 'countryOrder', 'hiddenCountryIds',
    'cityOrderByCountry', 'hiddenCityIds', 'mediaOrderByCity', 'coverMediaByCity', 'droneOrderByCity',
  ]) assert.ok(wheres.has(where), where)
  assert.deepEqual(danglingPlaceRefs(files), [])

  // 每一处都改成不存在的地点：各自被找出来。
  const ghost = '019b76da-ffff-7000-8000-00000000ffff'
  const broken = structuredClone(files) as V2Files
  broken.places.places = broken.places.places.map((place) => (place.id === reykjavik ? { ...place, id: ghost } : place))
  const dangling = danglingPlaceRefs(broken)
  assert.ok(dangling.length >= 8, String(dangling.length))
  assert.ok(dangling.every((ref) => ref.id === reykjavik))
})

test('integrityProblems：先报 validateV2Files 的问题；结构合法时再报悬空引用；只写文件、路径与问题', () => {
  const files = migratedFiles()
  assert.deepEqual(integrityProblems(files), [])
  const withGhost = structuredClone(files) as V2Files
  withGhost.editorState.hiddenCityIds.push('019b76da-ffff-7000-8000-00000000ffff')
  const problems = integrityProblems(withGhost)
  assert.ok(problems.some((problem) => problem.startsWith('editorState $.hiddenCityIds[1]')), problems.join('\n'))
  assert.ok(problems.every((problem) => !problem.includes('雷克雅未克')))
})

// ---------------------------------------------------------------------------
// 事务
// ---------------------------------------------------------------------------

test('runV2Transaction：按主体给出的顺序写；写到的文件盖上这次写入的时间；值是深拷贝；输入不被修改', () => {
  const files = migratedFiles()
  const before = structuredClone(files)
  const outcome = runV2Transaction(files, testContext(), (draft) => {
    draft.files.editorState.hiddenCityIds = []
    draft.files.travel.records = draft.files.travel.records.filter((record) => record.id !== 'sample_gjogv')
    return { result: { ok: 1 }, writes: [{ file: 'editorState' }, { file: 'travel', onFailure: '已改编辑状态，但（{reason}）' }] }
  })
  assert.deepEqual(files, before)
  assert.deepEqual(outcome.writes.map((write) => write.file), ['editorState', 'travel'])
  assert.equal((outcome.writes[0].value as V2Files['editorState']).updatedAt, WRITE_NOW.toISOString())
  assert.equal((outcome.writes[1].value as V2Files['travel']).generated_at, WRITE_NOW.toISOString())
  assert.equal(outcome.writes[0].onFailure, undefined)
  assert.equal(outcome.writes[1].onFailure, '已改编辑状态，但（{reason}）')
  assert.deepEqual(outcome.result, { ok: 1 })
})

test('runV2Transaction：入口的文件不合法 → E_INTEGRITY（stage input），不调用主体、不给出写入', () => {
  const files = migratedFiles()
  files.wantToGo.items[0].placeId = '019b76da-ffff-7000-8000-00000000ffff'
  let called = false
  assertV2Error(() => runV2Transaction(files, testContext(), () => {
    called = true
    return { result: undefined, writes: [{ file: 'wantToGo' }] }
  }), 'E_INTEGRITY', (error) => assert.equal(error.params?.stage, 'input'))
  assert.equal(called, false)
})

test('runV2Transaction：主体产生悬空引用 → E_INTEGRITY（stage output），不给出任何写入', () => {
  for (const mutate of [
    (files: V2Files) => { files.places.places = files.places.places.filter((place) => place.names.en !== 'Nuuk') },
    (files: V2Files) => { files.editorState.hiddenCountryIds.push('019b76da-ffff-7000-8000-00000000ffff') },
    (files: V2Files) => { files.travel.records[0].placeId = '019b76da-ffff-7000-8000-00000000ffff' },
  ]) {
    assertV2Error(() => runV2Transaction(migratedFiles(), testContext(), (draft) => {
      mutate(draft.files)
      return { result: undefined, writes: [{ file: 'places' }, { file: 'travel' }, { file: 'editorState' }] }
    }), 'E_INTEGRITY', (error) => {
      assert.equal(error.params?.stage, 'output')
      assert.ok(Array.isArray(error.params?.problems) && (error.params.problems as string[]).length > 0)
    })
  }
})

test('runV2Transaction：同一个文件列两次是编程错误', () => {
  assert.throws(() => runV2Transaction(migratedFiles(), testContext(), () => ({
    result: undefined,
    writes: [{ file: 'places' }, { file: 'places' }],
  })), TypeError)
})

test('removeUnreferencedPlaces：只清理候选；删掉城市后只被它引用的国家也删；仍被引用的保留', () => {
  const files = migratedFiles()
  const greenland = placeNamed(files, 'Greenland').id
  const nuuk = placeNamed(files, 'Nuuk').id
  const tromso = placeNamed(files, 'Tromsø').id
  const norway = placeNamed(files, 'Norway').id
  // 努克与特罗姆瑟都还被想去条目引用：一个也不删。
  assert.deepEqual(removeUnreferencedPlaces(files, [nuuk, tromso, greenland, norway]), [])
  // 去掉引用努克的想去条目：努克删掉，只被努克 partOf 引用的格陵兰随后也删。
  files.wantToGo.items = files.wantToGo.items.filter((item) => item.placeId !== nuuk)
  assert.deepEqual(removeUnreferencedPlaces(files, [nuuk]), [nuuk])
  assert.equal(files.places.places.some((place) => place.id === greenland), true, '格陵兰不在候选里，不动')
  assert.deepEqual(removeUnreferencedPlaces(files, [greenland]), [greenland])
  // 挪威仍被卑尔根（planned 记录）与特罗姆瑟的 partOf 引用。
  files.wantToGo.items = files.wantToGo.items.filter((item) => item.placeId !== tromso)
  assert.deepEqual(removeUnreferencedPlaces(files, [tromso, norway]), [tromso])
  assert.deepEqual(integrityProblems(files), [])
})
