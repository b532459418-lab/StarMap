/**
 * `POST /__travelatlas/editor/view` (3C-5 C1, design 3C-5 §3): the view operations that replace `PUT /state`.
 *
 * The page sends what this edit did (../rules/editorView.ts: order, hide, cover); the planner merges it into the current
 * editor lists (the official reader's), checks the merged lists as `PUT /state` checked the page's whole state
 * (../rules/editorState.ts: E_UNKNOWN_PLACE_REF), and writes only the view rows that change, with the algorithms of the
 * old path (../../store/viewListRows.ts: the rows still in order keep their positions). Media ids an operation brings
 * that are no assets are ignored (design §9 change 4). The response is the revision (the session adds it).
 *
 * Constraint: Node 24 loads it directly (erasable-only TypeScript, relative imports with `.ts`, `import type` for types).
 */
import type { ViewTarget } from '../../store/v2RecordRows.ts'
import { viewListWriter, writeEditorLists } from '../../store/viewListRows.ts'
import { checkEditorStatePlaces } from '../rules/editorState.ts'
import { applyViewOperations, parseViewOperations } from '../rules/editorView.ts'
import { commandBatch, viewListAccess } from './batch.ts'
import type { NativeWrite } from './routes.ts'

export const editorViewWrite = Object.freeze<NativeWrite>({
  status: 200,
  plan(reader, input, ctx) {
    const operations = parseViewOperations(input)
    const isAsset = (id: string) => reader.index.get('assets', id) !== undefined
    const before = reader.editorLists()
    const after = applyViewOperations(before, operations, isAsset)
    checkEditorStatePlaces(after, (id) => reader.subtypeOf(id))
    const batch = commandBatch()
    const { rows, sink } = viewListAccess(reader, batch, ctx.newId)
    const place = (id: unknown): ViewTarget | undefined => (typeof id === 'string' && reader.isPlace(id) ? { table: 'entities', id } : undefined)
    const media = (id: unknown): ViewTarget | undefined => (typeof id === 'string' && isAsset(id) ? { table: 'assets', id } : undefined)
    writeEditorLists(viewListWriter(rows, sink), before, after, { before: place, after: place }, media)
    return { commands: batch.commands(), result: {} }
  },
})
