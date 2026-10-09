/** Private DevOS Production backup/restore verification tool.
 * Does not stop runtimes, overwrite Production, touch ChatGPT, or change Git.
 * No passphrases or private file paths are printed or sent to GitHub.
 */
import { createHash, createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, appendFile, cp, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';

const MAGIC = Buffer.from('DEVOSBK1');
const HEADER_SIZE = MAGIC.length + 16 + 12;
const SCRYPT = {N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024};
const PROJECT_FILES = [
  '.env', '.devos/config.json', '.devos/connector', '.devos/state',
  '.devos/worker-reports', '.devos/completed', '.devos/browser-runtime',
  'devos', 'dist', 'package.json', 'package-lock.json',
];
const OPTIONAL_FILES = new Set(['.devos/worker-reports', '.devos/completed', '.devos/browser-runtime']);
const HOME_FILES = ['state.sqlite', 'state.sqlite-wal', 'state.sqlite-shm'];

function args(argv) {
  const [command, ...rest] = argv;
  if (!['plan', 'create', 'restore-test'].includes(command) || rest.length % 2)
    throw new Error('Usage: node scripts/devos2-private-backup.mjs <plan|create|restore-test> --root DIR --profile DIR --home-state DIR [--archive FILE --passphrase-file FILE]');
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    if (!['--root','--profile','--home-state','--archive','--passphrase-file','--scratch-root'].includes(key)
      || options[key] || !rest[i+1] || rest[i+1].startsWith('--'))
      throw new Error('Invalid backup argument');
    options[key] = resolve(rest[i+1]);
  }
  if (command !== 'restore-test' && (!options['--root'] || !options['--profile'] || !options['--home-state']))
    throw new Error('Backup requires explicit source paths');
  if (command !== 'plan' && (!options['--archive'] || !options['--passphrase-file']))
    throw new Error('Backup requires archive path and owner-only passphrase file');
  return {command, options};
}
function run(exe, input) {
  const result = spawnSync(exe, input, {encoding:'utf8', timeout: 60_000, maxBuffer: 8*1024*1024});
  if (result.error || result.status !== 0) throw new Error(`${exe} failed (exit ${result.status})`);
  return result.stdout;
}
/** Canonicalize an intended file without writing directories or following its
 * final file. macOS /var -> /private/var aliases must never evade source checks.
 */
async function canonicalCandidate(path) {
  let ancestor=dirname(path);
  const missing=[];
  while(true){
    try {return join(await realpath(ancestor),...missing.reverse(),basename(path));}
    catch(error){
      if(error?.code!=='ENOENT')throw error;
      const up=dirname(ancestor);
      if(up===ancestor)throw error;
      missing.push(basename(ancestor));ancestor=up;
    }
  }
}
async function safeDir(path) {
  const st = await lstat(path);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('Source must be a real directory');
  return realpath(path);
}
async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}
function running(root, profile) {
  // A real Production connector or browser profile cannot be archived while in
  // use. This is a quiescence check, not a process shutdown.
  const ps = run('ps', ['-axo','command']);
  return ps.split('\n').some(line =>
    line.includes(join(root, 'dist/src/connector-runtime.js')) ||
    line.includes(join(root, 'dist/src/cli.js --devos-browser-runtime')) ||
    (line.includes(profile) && /(?:\/Camoufox\.app\/|(?:^|\s)(?:\/\S*\/)?(?:firefox|camoufox)(?:\s|$))/i.test(line)));
}
async function inventory(root, profile, homeState) {
  const sources = [];
  for (const file of PROJECT_FILES) {
    const path = join(root,file);
    if (!await exists(path)) {
      if (!OPTIONAL_FILES.has(file)) throw new Error(`Required Production component missing: ${file}`);
      continue;
    }
    sources.push({src:path, dest:join('project',file)});
  }
  if (!await exists(profile)) throw new Error('Browser profile does not exist');
  sources.push({src:profile,dest:'browser_profile'});
  for (const file of HOME_FILES) {
    const source = join(homeState,file);
    if (await exists(source)) sources.push({src:source, dest:join('home_state',file)});
  }
  return sources;
}
async function secret(path) {
  const st=await lstat(path);
  if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o077) !== 0 ||
      (process.getuid && st.uid !== process.getuid()) || st.size < 24 || st.size > 4096)
    throw new Error('Passphrase file must be owner-only (0600), regular and non-empty');
  const bytes=await readFile(path);
  const length=bytes.at(-1)===10 ? bytes.length-1 : bytes.length;
  if (length < 24 || bytes.subarray(0,length).includes(0)) {bytes.fill(0);throw new Error('Recovery passphrase invalid or too short');}
  const answer=Buffer.from(bytes.subarray(0,length));
  bytes.fill(0);
  return answer;
}
async function privateParent(parent) {
  await mkdir(parent, {recursive:true,mode:0o700});
  const st=await lstat(parent);
  if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o077) !== 0 ||
      (process.getuid && st.uid !== process.getuid()))
    throw new Error('Archive/scratch parent must be owned by the user and mode 0700');
}
async function sha(file) {
  const h=createHash('sha256');
  for await (const part of createReadStream(file)) h.update(part);
  return h.digest('hex');
}
async function describeFiles(root, relativeDir='') {
  const output=[];
  async function visit(here) {
    const names=(await readdir(here)).sort();
    for (const name of names) {
      const file=join(here,name), st=await lstat(file);
      if (st.isSymbolicLink()) throw new Error('Snapshot contains a symlink; refusing potentially external data');
      if (st.isDirectory()) await visit(file);
      else if (st.isFile()) output.push({name:relative(root,file).split(sep).join('/'), size:st.size, sha256:await sha(file)});
      else throw new Error('Snapshot contains an unsupported special file');
    }
  }
  await visit(join(root,relativeDir));
  return output;
}
async function packEncrypted(tarPath, archive, password) {
  const salt=randomBytes(16), iv=randomBytes(12);
  const key=scryptSync(password,salt,32,SCRYPT);
  const cipher=createCipheriv('aes-256-gcm',key,iv);
  key.fill(0);
  const handle=await open(archive,'wx',0o600);
  try { await handle.write(Buffer.concat([MAGIC,salt,iv])); }
  finally { await handle.close(); }
  await pipeline(createReadStream(tarPath),cipher,createWriteStream(archive,{flags:'a',mode:0o600}));
  await appendFile(archive,cipher.getAuthTag());
}
async function unpackEncrypted(archive,tarPath,password) {
  const st=await lstat(archive);
  if (!st.isFile() || st.isSymbolicLink() || st.size<=HEADER_SIZE+16)
    throw new Error('Not a valid encrypted backup');
  const fd=await open(archive,'r');
  let header,tag;
  try {
    header=Buffer.alloc(HEADER_SIZE);tag=Buffer.alloc(16);
    await fd.read(header,0,HEADER_SIZE,0);
    await fd.read(tag,0,16,st.size-16);
  } finally { await fd.close(); }
  if (!header.subarray(0,MAGIC.length).equals(MAGIC)) throw new Error('Invalid backup format');
  const key=scryptSync(password,header.subarray(8,24),32,SCRYPT);
  const decipher=createDecipheriv('aes-256-gcm',key,header.subarray(24,36));
  key.fill(0);
  decipher.setAuthTag(tag);
  try {
    await pipeline(createReadStream(archive,{start:HEADER_SIZE,end:st.size-17}),
      decipher,createWriteStream(tarPath,{flags:'wx',mode:0o600}));
  } catch { throw new Error('Backup authentication failed or archive corrupted'); }
}
async function validateTar(tarPath) {
  const entries=run('tar',['-tf',tarPath]).split('\n').filter(Boolean);
  if (!entries.length || entries.length > 100000) throw new Error('Invalid backup member count');
  const details=run('tar',['-tvf',tarPath]).split('\n').filter(Boolean);
  if (details.length !== entries.length || details.some(row=>!/^[-d]/.test(row)))
    throw new Error('Archive contains a symlink or unsupported special member');
  for (const name of entries) {
    const path=name.replace(/^\.\//,'').replace(/\/$/,'');
    if (!path || path==='.') continue;
    if (isAbsolute(path) || path.includes('\\') || path.split('/').some(x=>x==='..'||!x))
      throw new Error('Unsafe archive member path');
  }
}
async function restoreTest(archive,passphrase, scratchRoot) {
  await privateParent(scratchRoot);
  const scratch=await mkdtemp(join(scratchRoot,'.restore-check-'));
  try {
    const tarPath=join(scratch,'archive.tar');
    const unpack=join(scratch,'restore');
    await mkdir(unpack,{mode:0o700});
    await unpackEncrypted(archive,tarPath,passphrase);
    await validateTar(tarPath);
    run('tar',['-xf',tarPath,'-C',unpack]);
    const manifest=JSON.parse(await readFile(join(unpack,'manifest.json'),'utf8'));
    if (manifest.version!==1 || !Array.isArray(manifest.files) || manifest.files.length > 100000)
      throw new Error('Invalid snapshot manifest');
    const actual=await describeFiles(unpack,'snapshot');
    if (JSON.stringify(actual)!==JSON.stringify(manifest.files))
      throw new Error('Restoration checksum verification failed');
    const required=['snapshot/project/.env','snapshot/project/.devos/config.json',
      'snapshot/project/.devos/connector/','snapshot/project/.devos/state/',
      'snapshot/project/dist/','snapshot/project/devos','snapshot/browser_profile/'];
    if (!required.every(prefix=>manifest.files.some(f=>f.name===prefix ||
      f.name.startsWith(prefix))))
      throw new Error('Required recovery components missing');
    return {status:'restore_verified',files:actual.length,components:manifest.components,
      productionMutated:false,scope:'isolated_scratch_only'};
  } finally { await rm(scratch,{recursive:true,force:true}); }
}
async function main(){
  const {command,options}=args(process.argv.slice(2));
  const o=options;
  if (command==='restore-test') {
    const archive=o['--archive'];
    const scratch=o['--scratch-root']??join(dirname(archive),'restore-scratch');
    if (dirname(scratch)!==dirname(archive))
      throw new Error('Restore scratch must be a private sibling of the encrypted archive');
    const password=await secret(o['--passphrase-file']);
    try { console.log(JSON.stringify(await restoreTest(archive,password,scratch))); }
    finally { password.fill(0); }
    return;
  }
  const root=await safeDir(o['--root']);
  const profile=await safeDir(o['--profile']);
  const homeState=await safeDir(o['--home-state']);
  const items=await inventory(root,profile,homeState);
  const active=running(root,profile);
  if(command==='plan') {
    console.log(JSON.stringify({status:active?'blocked_active_source':'idle',
      sourceComponentCount:items.length,profileSharedAllowed:true,
      mayCreate:!active,productionMutated:false}));
    return;
  }
  if(active) throw new Error('Live connector/browser profile detected: no consistent snapshot; no backup created');
  const archive=o['--archive'];
  const canonicalArchive=await canonicalCandidate(archive);
  // Never place temporary plaintext staging or the final archive under a
  // source root: that would recursively copy into itself or mutate Production.
  for(const source of [root,profile,homeState]) {
    const rel=relative(source,canonicalArchive);
    if (!rel || (rel!=='..' && !rel.startsWith('..'+sep) && !isAbsolute(rel)))
      throw new Error('Backup destination must be outside every source root');
  }
  if(await exists(archive)) throw new Error('Refusing to overwrite an existing backup');
  const parent=dirname(archive);
  await privateParent(parent);
  const password=await secret(o['--passphrase-file']);
  const work=await mkdtemp(join(parent,'.backup-build-'));
  const pending=join(work,'sealed.backup');
  try {
    const rootDir=join(work,'payload');
    const snapshotDir=join(rootDir,'snapshot');
    await mkdir(snapshotDir,{recursive:true,mode:0o700});
    for (const item of items){
      const target=join(snapshotDir,item.dest);
      await mkdir(dirname(target),{recursive:true,mode:0o700});
      await cp(item.src,target,{recursive:true,force:false,errorOnExist:true,filter:async p=>{
        const st=await lstat(p);
        if(st.isSymbolicLink()||(!st.isFile()&&!st.isDirectory()))
          throw new Error('Source contains symlink or special file');
        return true;
      }});
    }
    if(running(root,profile)) throw new Error('Source became active while copying; aborting snapshot');
    const files=await describeFiles(rootDir,'snapshot');
    const rev=spawnSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8',timeout:5000});
    const sha=rev.status===0 && /^[a-f0-9]{40}$/.test(rev.stdout.trim())?rev.stdout.trim():null;
    const manifest={version:1,productionSha:sha,components:[
      'config','oauth','sessions','state','browser_profile','executable'],files};
    await writeFile(join(rootDir,'manifest.json'),JSON.stringify(manifest),{mode:0o600});
    const tarPath=join(work,'snapshot.tar');
    run('tar',['-cf',tarPath,'-C',rootDir,'.']);
    await packEncrypted(tarPath,pending,password);
    // Verify full authenticated decrypt + SHA inventory BEFORE publication.
    await restoreTest(pending,password,join(work,'scratch'));
    if (running(root,profile)) throw new Error('Source became active before final backup publication');
    await rename(pending,archive);
    console.log(JSON.stringify({status:'encrypted_backup_verified',files:files.length,
      productionSha:sha,profileSharedAllowed:true,productionMutated:false}));
  }finally{password.fill(0);await rm(work,{recursive:true,force:true});}
}
main().catch(err=>{console.error('DevOS private backup blocked: '+err.message);process.exitCode=2;});
