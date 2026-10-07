import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, readdir, rename, cp, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { seed, id } from './world-store-repository.fixture.mjs'
import { createWorldRepository } from './world-store-repository.mjs'
import { previewRepositoryUpgrade } from './world-store-upgrade-preview.mjs'
import { createRepositoryV2 } from './world-store-repository-v2.mjs'
import { previewRepositoryFork, forkRepositoryToDirectory, openRepositoryBranch } from './world-store-branch.mjs'
import { previewRepositoryBranchBackup, backupRepositoryBranch } from './world-store-branch-backup.mjs'
import { previewRepositoryBranchHistoryIntake as preview, assertRepositoryBranchHistoryIntakeCurrent as current } from './world-store-branch-history-intake.mjs'

const host={hostId:'synthetic-host'}
const refuses=(fn,code)=>assert.throws(fn,error=>error.code===code)
function edit(directory, name='edit') {
  const branch=openRepositoryBranch(directory,host)
  try {
    const state=branch.state(), row=state.world.entries[0]
    branch.apply({id:name,expectedRevision:state.revision,action:{kind:'commands',commands:[{op:'update',table:'entries',id:row.id,expectedRevision:row.revision,
      value:{...row,revision:row.revision+1,fields:{...row.fields,note:name}}}]}})
  } finally {branch.close()}
}
async function setup(t) {
  const base=path.resolve(tmpdir()), root=await mkdtemp(path.join(base,'starmap-history-intake-'))
  t.after(()=>{assert.equal(path.dirname(path.resolve(root)),base);assert.ok(path.basename(root).startsWith('starmap-history-intake-'));return rm(root,{recursive:true,force:true})})
  const old=path.join(root,'old.sqlite'), parent=path.join(root,'parent.sqlite'), target=path.join(root,'target'), source=path.join(root,'source'), backup=path.join(root,'backup')
  createWorldRepository(old,seed()).close()
  createRepositoryV2(parent,previewRepositoryUpgrade(old,{libraryId:'family',branchId:'parent',genesisId:'initial'}).envelope).close()
  for(const directory of [target,source])forkRepositoryToDirectory(parent,directory,previewRepositoryFork(parent),path.basename(directory),host)
  edit(source,'source-edit')
  backupRepositoryBranch(source,backup,previewRepositoryBranchBackup(source),'backup')
  return {root,target,source,backup}
}
async function disk(root) {
  const hashes=[]
  async function visit(directory) {
    for(const item of (await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
      const file=path.join(directory,item.name)
      if(item.isDirectory())await visit(file)
      else hashes.push([path.relative(root,file),createHash('sha256').update(await readFile(file)).digest('hex')])
    }
  }
  await visit(root);return hashes
}
test('real experimental branch and backup preview preserves every fixture file byte and creates no output',async t=>{
  const value=await setup(t), before=await disk(value.root), report=preview(value.target,value.backup)
  assert.equal(report.report.classification,'review-required');assert.deepEqual(report.report.tables.entries.incomingChanged,[id(10)])
  assert.equal(report.report.operations.incomingOnly.length,1);assert.equal(report.report.operations.identical.length,0)
  assert.equal(report.report.commonBase.identity.branchId,'parent');assert.equal(report.report.executable,false)
  assert.deepEqual(current(report,value.target,value.backup),report);assert.deepEqual(await disk(value.root),before)
})
test('target edits after preview are rejected even when a new report would have the same row conflict category',async t=>{
  const value=await setup(t), report=preview(value.target,value.backup)
  edit(value.target,'target-edit')
  const before=await disk(value.root)
  refuses(()=>current(report,value.target,value.backup),'E_BRANCH_HISTORY_PREVIEW_STALE')
  assert.deepEqual(await disk(value.root),before)
})
test('a newly sealed source package at the old path invalidates the whole preview',async t=>{
  const value=await setup(t), report=preview(value.target,value.backup)
  await rename(value.backup,path.join(value.root,'first-backup'))
  edit(value.source,'later')
  backupRepositoryBranch(value.source,value.backup,previewRepositoryBranchBackup(value.source),'second-backup')
  refuses(()=>current(report,value.target,value.backup),'E_BRANCH_HISTORY_PREVIEW_STALE')
})
test('even equal snapshot bytes in a differently identified backup package invalidate consent binding',async t=>{
  const value=await setup(t), report=preview(value.target,value.backup)
  await rename(value.backup,path.join(value.root,'first-backup'))
  backupRepositoryBranch(value.source,value.backup,previewRepositoryBranchBackup(value.source),'different-backup-request')
  refuses(()=>current(report,value.target,value.backup),'E_BRANCH_HISTORY_PREVIEW_STALE')
})
test('moving an unchanged sealed backup keeps content-based preview identity',async t=>{
  const value=await setup(t), report=preview(value.target,value.backup), moved=path.join(value.root,'moved')
  await rename(value.backup,moved)
  assert.deepEqual(current(report,value.target,moved),report)
})
test('read-only inspection of a copied target never rebinds it for writing',async t=>{
  const value=await setup(t), copied=path.join(value.root,'copied')
  await cp(value.target,copied,{recursive:true})
  const before=await disk(value.root), report=preview(copied,value.backup)
  assert.equal(report.report.executable,false);assert.deepEqual(await disk(value.root),before)
  refuses(()=>openRepositoryBranch(copied,host),'E_BRANCH_BINDING')
})
test('corrupt or incomplete backup is refused without changes to the live target',async t=>{
  const value=await setup(t), before=await disk(value.target)
  await writeFile(path.join(value.backup,'snapshot.json'),'{}')
  refuses(()=>preview(value.target,value.backup),'E_BACKUP_CORRUPT')
  await rm(path.join(value.backup,'complete.json'))
  refuses(()=>preview(value.target,value.backup),'E_BACKUP_INCOMPLETE')
  assert.deepEqual(await disk(value.target),before)
})
test('whole report edits and accessors refuse before a replacement report is accepted',async t=>{
  const value=await setup(t), report=preview(value.target,value.backup), bad=structuredClone(report)
  bad.report.commands.push({op:'made-up'})
  refuses(()=>current(bad,value.target,value.backup),'E_BRANCH_HISTORY_PREVIEW_STALE')
  let calls=0;Object.defineProperty(bad,'report',{enumerable:true,get(){calls++;return report.report}})
  assert.throws(()=>current(bad,value.target,value.backup));assert.equal(calls,0)
  const options={};Object.defineProperty(options,'policy',{enumerable:true,get(){calls++;return {}}})
  assert.throws(()=>preview(value.target,value.backup,options));assert.equal(calls,0)
})
test('explicit missing/relative inputs fail without scanning another data location',async t=>{
  const value=await setup(t), before=await disk(value.root)
  assert.throws(()=>preview('relative-target',value.backup))
  assert.throws(()=>preview(value.target,'relative-backup'))
  assert.throws(()=>preview(value.target,path.join(value.root,'missing')))
  assert.deepEqual(await disk(value.root),before)
})
