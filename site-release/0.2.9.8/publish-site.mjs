import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';

export const REPOSITORY = 'kaigendev/Kaigen';
export const RELEASE_ID = 403141563;
export const TAG = 'v0.2.9.8';
export const SITE_NAME = 'Kaigen-Site-0.2.9.8.tar.gz';
export const SITE_SHA256 = '13c91226ab580a02cd61cef8223d354051ddbf4ff329aaca04a0e2bc18da0e0c';
const MANIFEST_SHA256 = '3ee5fccfd0aedd5185590eba8fdb9ac95ccf0db081ceef85b3f4dae9060aefbe';
const PIN_SHA256 = '19b246e654e1b3ba67424197127fa25db224affcbafe070952636d702b79ffa4';
const PUBLISHED_AT = '2026-10-04T22:37:18Z';
const WORKFLOW = '.github/workflows/publish-site-0298.yml';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (actual, expected, label) => assert.deepEqual(actual, expected, label);

export function assertWorkflowContext(env) {
  same(env.GITHUB_ACTIONS, 'true', 'Actions runner required');
  same(env.GITHUB_REPOSITORY, REPOSITORY, 'repository mismatch');
  same(env.GITHUB_EVENT_NAME, 'workflow_dispatch', 'manual event required');
  same(env.GITHUB_REF, 'refs/heads/main', 'main ref required');
  same(env.GITHUB_WORKFLOW_REF, `${REPOSITORY}/${WORKFLOW}@refs/heads/main`, 'workflow mismatch');
  assert.match(env.EXPECTED_SHA ?? '', /^[a-f0-9]{40}$/, 'reviewed commit required');
  same(env.GITHUB_SHA, env.EXPECTED_SHA, 'reviewed commit mismatch');
  assert.match(env.GITHUB_RUN_ID ?? '', /^[1-9][0-9]*$/);
  assert.match(env.GITHUB_RUN_ATTEMPT ?? '', /^[1-9][0-9]*$/);
}

export function assertPublicPackage(packageBytes, manifestBytes, pinBytes) {
  same(sha(packageBytes), SITE_SHA256, 'site package pin mismatch');
  same(packageBytes.length, 782213, 'site package size mismatch');
  same(sha(manifestBytes), MANIFEST_SHA256, 'public manifest pin mismatch');
  same(sha(pinBytes), PIN_SHA256, 'public pin receipt mismatch');
  const manifest = JSON.parse(manifestBytes), pin = JSON.parse(pinBytes);
  same(Object.keys(manifest), ['schemaVersion', 'release', 'files'], 'private manifest fields');
  same(manifest.schemaVersion, 1); same(manifest.release, TAG);
  same(manifest.files.length, 23); same(pin.package.files, 23);
  same(pin.package.sha256, SITE_SHA256); same(pin.publicManifestSha256, MANIFEST_SHA256);
  same(packageBytes.subarray(0,4), Buffer.from([31,139,8,0]), 'gzip metadata/format mismatch');
  const expected = new Map();
  for (const file of manifest.files) {
    same(Object.keys(file), ['path', 'size', 'sha256']);
    assert.match(file.path, /^(?:index\.html|robots\.txt|site\.webmanifest|assets\/[A-Za-z0-9_-]+\.(?:png|webp|js|css))$/);
    assert.ok(!expected.has(file.path), 'duplicate manifest entry');
    assert.ok(Number.isSafeInteger(file.size) && file.size > 0);
    assert.match(file.sha256, /^[a-f0-9]{64}$/);
    expected.set(file.path, file);
  }
  const tar = gunzipSync(packageBytes, { maxOutputLength: 2 * 1024 * 1024 });
  const text = (header, start, length) => header.subarray(start,start+length).toString('utf8').replace(/\0.*$/s,'');
  const octal = (header, start, length) => {
    const value = text(header,start,length).trim();
    assert.match(value, /^[0-7]+$/, 'unsupported tar number');
    return parseInt(value,8);
  };
  const seen = new Set(); let offset = 0;
  while (offset + 512 <= tar.length && tar.subarray(offset,offset+512).some(byte => byte !== 0)) {
    const header = tar.subarray(offset,offset+512);
    const checksum = [...header].reduce((sum,byte,index) => sum + (index>=148 && index<156 ? 32 : byte),0);
    same(octal(header,148,8),checksum,'tar header checksum');
    same(text(header,257,6),'ustar'); same(text(header,263,2),'00');
    same(header[156],48,'only regular tar files allowed');
    for (const [start,length] of [[157,100],[265,32],[297,32],[345,155]]) same(text(header,start,length),'','tar private/link metadata');
    same(octal(header,108,8),0,'tar uid'); same(octal(header,116,8),0,'tar gid');
    const name = text(header,0,100), size = octal(header,124,12), file = expected.get(name);
    assert.ok(file && !seen.has(name),'unexpected/duplicate/unsafe tar entry');
    same(size,file.size,'tar size mismatch');
    assert.ok(offset+512+size<=tar.length,'truncated tar data');
    same(sha(tar.subarray(offset+512,offset+512+size)),file.sha256,'public file digest mismatch');
    seen.add(name); offset += 512 + Math.ceil(size/512)*512;
  }
  same(seen.size,23,'incomplete public inventory');
  assert.ok(tar.length-offset>=1024 && tar.subarray(offset).every(byte=>byte===0),'invalid tar ending');
  return { pin, manifest, packageBytes };
}

export function assertRelease(release, originalAssets) {
  same(release.id,RELEASE_ID); same(release.tag_name,TAG);
  same(release.draft,false); same(release.prerelease,false); same(release.published_at,PUBLISHED_AT);
  same(release.html_url,`https://github.com/${REPOSITORY}/releases/tag/${TAG}`);
  assert.ok(Array.isArray(release.assets) && [7,8].includes(release.assets.length),'unexpected asset count');
  const byName = new Map(release.assets.map(asset => [asset.name,asset]));
  same(byName.size,release.assets.length,'duplicate release asset names');
  for (const original of originalAssets) {
    const asset = byName.get(original.name);
    assert.ok(asset,'original product asset missing');
    same(asset.size,original.size,'original product size changed');
    same(asset.digest,`sha256:${original.sha256}`,'original product digest changed');
    same(asset.state,'uploaded');
  }
  for (const name of byName.keys()) assert.ok(name===SITE_NAME || originalAssets.some(asset=>asset.name===name),'unknown release asset');
  const site = byName.get(SITE_NAME);
  if (site) { same(site.size,782213); same(site.digest,`sha256:${SITE_SHA256}`); same(site.state,'uploaded'); }
  return { site, protectedIdentity: {
    id:release.id, tag:release.tag_name, target:release.target_commitish, name:release.name,
    bodySha256:sha(Buffer.from(release.body ?? '')), draft:release.draft, prerelease:release.prerelease,
    publishedAt:release.published_at, createdAt:release.created_at,
    originalAssets:originalAssets.map(original=> {
      const asset=byName.get(original.name);
      return {id:asset.id,name:asset.name,size:asset.size,digest:asset.digest,createdAt:asset.created_at};
    }),
  } };
}

async function api(endpoint, raw = false) {
  assert.ok(/^[a-zA-Z0-9/._-]+$/.test(endpoint),'unsafe API endpoint');
  const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/${endpoint}`, {
    headers:{Authorization:`Bearer ${process.env.GITHUB_TOKEN}`,Accept:raw?'application/octet-stream':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'},
    redirect:'manual',
  });
  if (raw) return response;
  assert.ok(response.ok,`official API metadata failed: ${response.status}`);
  return response.json();
}

async function readback(assetId) {
  assert.ok(Number.isSafeInteger(assetId) && assetId>0,'invalid asset id');
  let response = await api(`releases/assets/${assetId}`,true);
  if (response.status===302) {
    const location = new URL(response.headers.get('location'));
    assert.ok(location.protocol==='https:' && !location.username && !location.password && !location.port
      && ['release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(location.hostname),'untrusted official asset redirect');
    response = await fetch(location,{redirect:'error'}); // Never forward Authorization to storage.
  }
  assert.ok(response.ok,`official asset readback failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  same(bytes.length,782213,'site readback size'); same(sha(bytes),SITE_SHA256,'site readback digest');
}

async function publish(directory) {
  assertWorkflowContext(process.env);
  assert.ok(process.env.GITHUB_TOKEN,'Actions GITHUB_TOKEN required');
  const git = args => execFileSync('git',args,{encoding:'utf8',windowsHide:true}).trim();
  same(git(['rev-parse','HEAD']),process.env.GITHUB_SHA,'checkout mismatch');
  same(git(['status','--porcelain']),'','unclean checkout');
  const packageRoot=path.dirname(import.meta.filename);
  const input=assertPublicPackage(...await Promise.all([SITE_NAME,'public-package-manifest.json','pin-receipt.json'].map(name=>readFile(path.join(packageRoot,name)))));
  const head=await api('git/ref/heads/main'); same(head.object?.sha,process.env.GITHUB_SHA,'current main changed');
  const run=await api(`actions/runs/${process.env.GITHUB_RUN_ID}`);
  same(run.repository?.full_name,REPOSITORY); same(run.head_repository?.full_name,REPOSITORY);
  same(run.event,'workflow_dispatch'); same(run.path,WORKFLOW); same(run.head_branch,'main');
  same(run.head_sha,process.env.GITHUB_SHA); same(run.run_attempt,Number(process.env.GITHUB_RUN_ATTEMPT));
  const tagBefore=await api(`git/ref/tags/${TAG}`);
  same(tagBefore.object?.sha,'5b8466f589d4f74611b4b7583c9aa2005c49dda0');
  const tagObject=await api(`git/tags/${tagBefore.object.sha}`);
  same(tagObject.object?.sha,'724dea3b287f68d5d25700e6cda32b8f161a1296');
  const before=assertRelease(await api(`releases/${RELEASE_ID}`),input.pin.originalAssets);
  let action='verified-existing';
  if (!before.site) {
    const response=await fetch(`https://uploads.github.com/repos/${REPOSITORY}/releases/${RELEASE_ID}/assets?name=${encodeURIComponent(SITE_NAME)}`, {
      method:'POST',headers:{Authorization:`Bearer ${process.env.GITHUB_TOKEN}`,Accept:'application/vnd.github+json','Content-Type':'application/gzip','X-GitHub-Api-Version':'2022-11-28'},
      body:input.packageBytes,redirect:'error',
    });
    same(response.status,201,'site append failed; existing assets will not be replaced');
    const uploaded=await response.json(); same(uploaded.name,SITE_NAME); same(uploaded.size,782213); same(uploaded.digest,`sha256:${SITE_SHA256}`);
    action='uploaded';
  }
  const after=assertRelease(await api(`releases/${RELEASE_ID}`),input.pin.originalAssets);
  assert.ok(after.site,'site asset missing after append');
  same(after.protectedIdentity,before.protectedIdentity,'original release metadata/assets changed');
  same(await api(`git/ref/tags/${TAG}`),tagBefore,'release tag changed');
  await readback(after.site.id);
  const receipt={schemaVersion:1,kind:'kaigen-actions-site-publication',status:'PUBLISHED_VERIFIED',repository:REPOSITORY,
    releaseId:RELEASE_ID,tag:TAG,publishedAt:PUBLISHED_AT,controllerCommit:process.env.GITHUB_SHA,
    publication:{runId:Number(process.env.GITHUB_RUN_ID),attempt:Number(process.env.GITHUB_RUN_ATTEMPT)},action,
    site:{id:after.site.id,name:SITE_NAME,size:782213,sha256:SITE_SHA256,files:23,readbackVerified:true},
    originalAssetsUnchanged:true,releaseMetadataUnchanged:true,tagUnchanged:true,publicManifestSha256:MANIFEST_SHA256,
    completedAt:new Date().toISOString()};
  await mkdir(directory,{recursive:true});
  await writeFile(path.join(directory,'site-publication.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
  console.log('SITE_PUBLISHED_VERIFIED: exact supplemental asset; original seven product assets unchanged');
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url) {
  const [mode,directory]=process.argv.slice(2);
  if (mode==='check-package' && !directory) {
    assertPublicPackage(...await Promise.all([SITE_NAME,'public-package-manifest.json','pin-receipt.json'].map(name=>readFile(new URL(name,import.meta.url)))));
    console.log('PUBLIC_SITE_PACKAGE_PASS: 23 exact regular public files; no rebuild or network');
  } else {
    assert.ok(mode==='publish' && directory,'Usage: publish-site.mjs check-package | publish <Actions receipt directory>');
    await publish(path.resolve(directory));
  }
}
