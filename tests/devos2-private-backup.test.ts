import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script=join(process.cwd(),'scripts/devos2-private-backup.mjs');
const run=(args:string[])=>spawnSync('node',[script,...args],{
  encoding:'utf8',timeout:25_000,maxBuffer:1024*1024,
});

async function fixture() {
  const dir=await mkdtemp(join(tmpdir(),'devos-v06-restore-'));
  await chmod(dir,0o700);
  const root=join(dir,'project'), home=join(dir,'home'), profile=join(dir,'shared-profile');
  for (const d of [
    join(root,'.devos','connector'),join(root,'.devos','state'),
    join(root,'dist','src'),home,profile,
  ])await mkdir(d,{recursive:true,mode:0o700});
  const files={
    '.env':'OWNER_SECRET=fixture-only',
    '.devos/config.json':'{"version":1}',
    '.devos/connector/oauth-state.enc':'fixture-OAuth-blob',
    '.devos/connector/chat-access.json':'fixture-signed-chat-access',
    '.devos/state/issue-100.json':'fixture-task-session',
    'dist/src/connector-runtime.js':'fake-runtime',
    'devos':'#!/bin/sh\necho fixture\n',
    'package.json':'{"type":"module"}',
    'package-lock.json':'{"lockfileVersion":3}',
  };
  for(const [path,body] of Object.entries(files))
    await writeFile(join(root,path),body,{mode:0o600});
  await writeFile(join(profile,'cookies.sqlite'),Buffer.from('fixture private browser cookies'));
  await writeFile(join(home,'state.sqlite'),Buffer.from('fixture home state'));
  const pass=join(dir,'recovery-passphrase'), wrong=join(dir,'wrong-passphrase');
  await writeFile(pass,randomBytes(42).toString('hex')+'\n',{mode:0o600});
  await writeFile(wrong,randomBytes(42).toString('hex')+'\n',{mode:0o600});
  const archive=join(dir,'backup.devosaes');
  const base=['--root',root,'--profile',profile,'--home-state',home];
  return {dir,root,home,profile,pass,wrong,archive,base};
}

test('V06 private backup creates authenticated encrypted bytes and validates scratch restoration',async()=>{
  const f=await fixture();
  try {
    const plan=run(['plan',...f.base]);
    assert.equal(plan.status,0,plan.stderr);
    assert.equal(JSON.parse(plan.stdout).status,'idle');
    const created=run(['create',...f.base,'--archive',f.archive,'--passphrase-file',f.pass]);
    assert.equal(created.status,0,created.stderr);
    assert.equal(JSON.parse(created.stdout).status,'encrypted_backup_verified');
    const bytes=await readFile(f.archive);
    assert.equal(bytes.subarray(0,8).toString(),'DEVOSBK1');
    assert.equal(bytes.includes(Buffer.from('OWNER_SECRET=fixture-only')),false);
    assert.equal(bytes.includes(Buffer.from('fixture private browser cookies')),false);
    assert.equal((await stat(f.archive)).mode & 0o077,0);
    const unsafeRestore=run(['restore-test','--archive',f.archive,'--passphrase-file',f.pass,
      '--scratch-root',join(f.root,'.devos','state','restore-scratch')]);
    assert.equal(unsafeRestore.status,2);
    assert.match(unsafeRestore.stderr,/private sibling/);
    const restored=run(['restore-test','--archive',f.archive,'--passphrase-file',f.pass,
      '--scratch-root',join(f.dir,'restore-scratch')]);
    assert.equal(restored.status,0,restored.stderr);
    const report=JSON.parse(restored.stdout);
    assert.equal(report.status,'restore_verified');
    assert.equal(report.productionMutated,false);
    assert.ok(report.files>=10);
    const repeated=run(['create',...f.base,'--archive',f.archive,'--passphrase-file',f.pass]);
    assert.equal(repeated.status,2);
    assert.match(repeated.stderr,/Refusing to overwrite/);
  }finally{await rm(f.dir,{recursive:true,force:true});}
});

test('V06 archive rejects incorrect recovery key and tampered ciphertext',async()=>{
  const f=await fixture();
  try {
    assert.equal(run(['create',...f.base,'--archive',f.archive,'--passphrase-file',f.pass]).status,0);
    const wrong=run(['restore-test','--archive',f.archive,'--passphrase-file',f.wrong,
      '--scratch-root',join(f.dir,'scratch')]);
    assert.equal(wrong.status,2);
    assert.match(wrong.stderr,/authentication failed/i);
    const bad=join(f.dir,'corrupted.devosaes');
    await copyFile(f.archive,bad);
    const altered=await readFile(bad);
    const index=Math.floor(altered.length/2);
    altered[index]=(altered[index]??0)^0x80;
    await writeFile(bad,altered,{mode:0o600});
    const tampered=run(['restore-test','--archive',bad,'--passphrase-file',f.pass,
      '--scratch-root',join(f.dir,'scratch')]);
    assert.equal(tampered.status,2);
    assert.match(tampered.stderr,/authentication failed/i);
  }finally{await rm(f.dir,{recursive:true,force:true});}
});

test('V06 private backup refuses world-readable secrets and symlinked source data',async()=>{
  const f=await fixture();
  try {
    await chmod(f.pass,0o644);
    assert.equal(run(['create',...f.base,'--archive',f.archive,'--passphrase-file',f.pass]).status,2);
    assert.equal(await stat(f.archive).then(()=>true,()=>false),false);
    await chmod(f.pass,0o600);
    const insideSource=join(f.root,'.devos','connector','bad-backup.devosaes');
    const nested=run(['create',...f.base,'--archive',insideSource,'--passphrase-file',f.pass]);
    assert.equal(nested.status,2);
    assert.match(nested.stderr,/outside every source root/);
    await symlink(join(f.root,'.env'),join(f.root,'.devos','state','external-alias'));
    const result=run(['create',...f.base,'--archive',f.archive,'--passphrase-file',f.pass]);
    assert.equal(result.status,2);
    assert.match(result.stderr,/symlink/i);
    assert.equal(await stat(f.archive).then(()=>true,()=>false),false);
  }finally{await rm(f.dir,{recursive:true,force:true});}
});


test('V06 Production-like runtime prevents live backup without stopping anything',async()=>{
  const f=await fixture();
  const owned=spawn(process.execPath,['-e','setInterval(()=>{},200)',
    await realpath(join(f.root,'dist/src/connector-runtime.js'))],{stdio:'ignore'});
  try{
    await new Promise(resolve=>setTimeout(resolve,200));
    const plan=run(['plan',...f.base]);
    assert.equal(plan.status,0,plan.stderr);
    assert.equal(JSON.parse(plan.stdout).status,'blocked_active_source');
    const create=run(['create',...f.base,'--archive',f.archive,'--passphrase-file',f.pass]);
    assert.equal(create.status,2);
    assert.match(create.stderr,/Live connector\/browser profile detected/);
    assert.equal(await stat(f.archive).then(()=>true,()=>false),false);
  }finally{
    owned.kill('SIGTERM');
    await new Promise(resolve=>owned.once('exit',resolve));
    await rm(f.dir,{recursive:true,force:true});
  }
});
