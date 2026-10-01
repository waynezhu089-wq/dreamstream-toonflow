const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { fixture } = require('./composite-fixture.cjs');

const H_DA = 'd9dc75286b4bf496a4ea3f7b6c3e453a1b59d7fa9aa33b4edaf4dc75223aadae';
const H_SEM = '2d827d74c35bca596fe330986c9b06b70b2d18e61a6a9cbc3635c96545eeb1e3';
const H_E001 = '82d3ac725a9f89dee7ba556068408bc0cad89dba6e400974c574af3111be4521';

function mp4Bytes(seed = 1) {
  const b = Buffer.alloc(32, seed);
  b.writeUInt32BE(24, 0); b.write('ftyp', 4, 'ascii'); b.write('isom', 8, 'ascii'); b.write('isom', 16, 'ascii');
  return b;
}
function pngBytes() {
  return Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,0]);
}
function audioBytes() {
  return Buffer.concat([Buffer.from('ID3'), Buffer.alloc(16, 1)]);
}
const sha = b => createHash('sha256').update(b).digest('hex');

async function setupE001(t, descriptor = null) {
  const f = await fixture(t);
  await f.load('lib/videoProductionSchema').initializeVideoProductionSchema(f.db);
  if (!await f.raw.schema.hasTable('o_user')) await f.raw.schema.createTable('o_user', tb => {
    tb.integer('id').primary(); tb.text('name'); tb.text('password');
  });
  await f.db('o_user').insert({ id: 1, name: 'Studio Owner' }).onConflict('id').ignore();

  const shot = await f.create();
  await f.db('o_videoTrack').where({ id: shot.trackId }).update({
    storyboardManaged: 1, prompt: 'Shot', duration: 5, state: '已完成',
  });

  const profiles = f.load('services/orchestrator/profileRegistry');
  const vp = f.load('services/orchestrator/videoProductionProfile');
  const created = await profiles.createVersion({ profileKey: 'advertisement', definition: vp.advertisement001eDefinition });
  await profiles.activateVersion({ profileKey: 'advertisement', version: created.version });
  await profiles.bindProfile({ projectId: 1, profileKey: 'advertisement', version: created.version });

  const gates = f.load('services/orchestrator/gateRegistry');
  gates.registerGate('advertisement.asset-ready', async () => ({ pass: true, code: 'ADVERTISEMENT_ASSET_READY', reason: null }));
  gates.registerGate('supervisor.storyboard-approved.v2', async () => ({ pass: true, code: 'SUPERVISOR_PASS', reason: null,
    details: { reviewKey: 'storyboard.semantic-approval.v2', targetHash: 'a'.repeat(64),
      controlContextHash: 'b'.repeat(64), effectiveDecision: 'PASS', reviewId: 'test-review' } }));

  const version = Number(created.version.slice(1));
  const now = Date.now();
  for (const stage of vp.advertisement001eDefinition.stages) {
    if (stage.uiOrder > 90) continue;
    const state = stage.stageKey === 'video-production' ? 'IN_PROGRESS' : 'COMPLETED';
    await f.db('o_stageRun').insert({ projectId: 1, scriptId: 10, profileKey: 'advertisement',
      profileVersion: version, stageKey: stage.stageKey, state, startedAt: now,
      completedAt: state === 'COMPLETED' ? now : null, skippedAt: null, updatedAt: now, lastReason: null });
  }

  const modelDescriptor = descriptor ?? {
    name: 'Video', modelName: 'video', type: 'video', mode: ['text'],
    durationResolutionMap: [{ duration: [5], resolution: ['720p'] }], audio: 'optional',
  };
  f.utils.vendor.getModelList = async () => [modelDescriptor];
  f.utils.vendor.getVendor = () => ({ version: '2.0' });
  await f.load('services/modelPreset').patchProject({ projectId: 1, slots: { video: 'vendor:video' } });
  const files = new Map();
  f.utils.oss.getFile = async path => {
    if (!files.has(path)) throw Error('missing media ' + path);
    return files.get(path);
  };
  return { ...f, shot, vp, video: f.load('services/orchestrator/videoProduction'), profiles, files, version };
}

async function seedCandidate(f, outputByte = 'c') {
  const path = `/1/video/${randomUUID()}.mp4`;
  const reserved = await f.video.reserveE001VideoGeneration({ projectId: 1, scriptId: 10 }, [{
    trackId: f.shot.trackId, references: [], prompt: 'Shot', duration: 5, videoPath: path,
  }], { model: 'vendor:video', mode: 'text', resolution: '720p', audio: false });
  const guard = reserved.guards[0];
  const sealed = await f.video.sealE001VideoSource({ projectId: 1, scriptId: 10 }, guard);
  assert.match(sealed.sourceHash, /^[a-f0-9]{64}$/);
  await f.video.finishE001VideoCandidate({ projectId: 1, scriptId: 10 }, guard, {
    filePath: path, mime: 'video/mp4', sha256: outputByte.repeat(64), byteLength: 32,
  });
  return { guard, videoId: guard.videoId, path, sealed };
}

test('frozen Profile hashes and finite classification are exact', async t => {
  const f = await fixture(t);
  const vp = f.load('services/orchestrator/videoProductionProfile');
  const def = f.load('services/orchestrator/profileDefinition');
  assert.equal(def.definitionHash(vp.advertisementPreE001DA), H_DA);
  assert.equal(def.definitionHash(vp.advertisementPreE001SemanticV2), H_SEM);
  assert.equal(def.definitionHash(vp.advertisement001eDefinition), H_E001);
  assert.equal(await vp.classifyVideoProfile(f.db, 1), 'LEGACY');

  const profiles = f.load('services/orchestrator/profileRegistry');
  const pre = await profiles.createVersion({ profileKey: 'advertisement', definition: vp.advertisementPreE001SemanticV2 });
  await profiles.activateVersion({ profileKey: 'advertisement', version: pre.version });
  await profiles.bindProfile({ projectId: 1, profileKey: 'advertisement', version: pre.version });
  assert.equal(await vp.classifyVideoProfile(f.db, 1), 'PRE_001E_CONTROLLED_COMPAT');
});

test('unknown managed V2 does not gain predecessor compatibility from version number', async t => {
  const f = await fixture(t);
  const vp = f.load('services/orchestrator/videoProductionProfile');
  const profiles = f.load('services/orchestrator/profileRegistry');
  const unknown = JSON.parse(JSON.stringify(vp.advertisementPreE001SemanticV2));
  unknown.stages.find(s => s.stageKey === 'qc').operationKeys = ['future.video.operation'];
  const row = await profiles.createVersion({ profileKey: 'advertisement', definition: unknown });
  await profiles.activateVersion({ profileKey: 'advertisement', version: row.version });
  await profiles.bindProfile({ projectId: 1, profileKey: 'advertisement', version: row.version });
  assert.equal(await vp.classifyVideoProfile(f.db, 1), 'MANAGED_V2_UNSUPPORTED');
});

test('001E source seals deterministically and output becomes selection-eligible without auto-accept', async t => {
  const f = await setupE001(t);
  assert.equal(await f.vp.classifyVideoProfile(f.db, 1), 'E001_ENABLED');
  const candidate = await seedCandidate(f);
  const row = await f.db('o_video').where({ id: candidate.videoId }).first();
  assert.equal(row.sourceAdapter, 'video.track-source.v1');
  assert.match(row.sourceHash, /^[a-f0-9]{64}$/);
  assert.equal(row.outputMime, 'video/mp4');
  assert.equal(row.state, '生成成功');
  const projection = await f.db.transaction(q => f.video.assessE001Candidate(q, { projectId: 1, scriptId: 10 }, row));
  assert.equal(projection.status, 'SELECTION_ELIGIBLE');
  assert.equal((await f.db('o_videoTrack').where({ id: f.shot.trackId }).first()).videoId, null);
  assert.equal((await f.db('o_videoAcceptance')).length, 0);
});

test('Accept command is ABA-safe, replayable after Stage completion, and immutable', async t => {
  const f = await setupE001(t);
  const a = await seedCandidate(f, 'a');
  const b = await seedCandidate(f, 'b');
  const cmdA = randomUUID(), cmdB = randomUUID();
  const actor = { id: 1, name: 'Studio Owner' };
  assert.equal((await f.video.acceptE001Video({ projectId: 1, scriptId: 10, trackId: f.shot.trackId,
    videoId: a.videoId, acceptanceId: cmdA, reason: null }, actor)).delivery, 'APPLIED');
  assert.equal((await f.video.acceptE001Video({ projectId: 1, scriptId: 10, trackId: f.shot.trackId,
    videoId: b.videoId, acceptanceId: cmdB, reason: null }, actor)).delivery, 'APPLIED');
  assert.equal((await f.db('o_videoTrack').where({ id: f.shot.trackId }).first()).videoId, b.videoId);

  await f.db('o_stageRun').where({ projectId: 1, scriptId: 10, stageKey: 'video-production' }).update({ state: 'COMPLETED' });
  const replay = await f.video.acceptE001Video({ projectId: 1, scriptId: 10, trackId: f.shot.trackId,
    videoId: a.videoId, acceptanceId: cmdA, reason: null }, actor);
  assert.equal(replay.delivery, 'REPLAYED');
  assert.equal((await f.db('o_videoTrack').where({ id: f.shot.trackId }).first()).videoId, b.videoId);
  assert.equal((await f.db('o_videoAcceptance')).length, 2);

  await assert.rejects(f.video.acceptE001Video({ projectId: 1, scriptId: 10, trackId: f.shot.trackId,
    videoId: b.videoId, acceptanceId: cmdA, reason: null }, actor), e => e.code === 'VIDEO_ACCEPTANCE_ID_CONFLICT');
  await assert.rejects(f.db('o_videoAcceptance').where({ acceptanceId: cmdB }).update({ reason: 'rewrite' }));
  await assert.rejects(f.db('o_videoAcceptance').where({ acceptanceId: cmdB }).delete());
});

test('accepted-current Gate/read follows Source drift without rewriting historical Accept', async t => {
  const f = await setupE001(t);
  const candidate = await seedCandidate(f);
  await f.video.acceptE001Video({ projectId: 1, scriptId: 10, trackId: f.shot.trackId,
    videoId: candidate.videoId, acceptanceId: randomUUID(), reason: null }, { id: 1 });
  assert.equal((await f.video.videoAcceptedCurrentGate({ projectId: 1, scriptId: 10 })).code, 'VIDEO_ACCEPTED_CURRENT_READY');
  await f.db('o_videoTrack').where({ id: f.shot.trackId }).update({ prompt: 'Drifted prompt' });
  const track = await f.db('o_videoTrack').where({ id: f.shot.trackId }).first();
  const current = await f.db.transaction(q => f.video.acceptedCurrentForTrack(q, { projectId: 1, scriptId: 10 }, track));
  assert.equal(current, null);
  assert.equal((await f.db('o_videoAcceptance')).length, 1);
  assert.equal((await f.video.videoAcceptedCurrentGate({ projectId: 1, scriptId: 10 })).code, 'VIDEO_ACCEPTED_CURRENT_REQUIRED');
});

test('normal ACTIVE siblings are allowed, provider-submission UNCERTAIN blocks retry until FENCE', async t => {
  const f = await setupE001(t);
  const item = () => ({ trackId: f.shot.trackId, references: [], prompt: 'Shot', duration: 5,
    videoPath: `/1/video/${randomUUID()}.mp4` });
  const first = await f.video.reserveE001VideoGeneration({ projectId: 1, scriptId: 10 }, [item()],
    { model: 'vendor:video', mode: 'text', resolution: '720p' });
  const second = await f.video.reserveE001VideoGeneration({ projectId: 1, scriptId: 10 }, [item()],
    { model: 'vendor:video', mode: 'text', resolution: '720p' });
  assert.notEqual(first.guards[0].guardId, second.guards[0].guardId);
  const wg = f.load('services/orchestrator/revisionWorkGuard');
  await wg.markProviderSubmissionUncertain({ projectId: 1, scriptId: 10 }, first.guards[0], Error('transport uncertain'));
  await assert.rejects(f.video.reserveE001VideoGeneration({ projectId: 1, scriptId: 10 }, [item()],
    { model: 'vendor:video', mode: 'text', resolution: '720p' }), e => e.code === 'VIDEO_GENERATION_UNCERTAIN_BLOCKED');

  const old = process.env.DS_STUDIO_OWNER_USER_ID; process.env.DS_STUDIO_OWNER_USER_ID = '1';
  try {
    await wg.fenceRevisionWork({ projectId: 1, scriptId: 10 }, first.guards[0].guardId, { id: 1 }, 'human retry');
    const third = await f.video.reserveE001VideoGeneration({ projectId: 1, scriptId: 10 }, [item()],
      { model: 'vendor:video', mode: 'text', resolution: '720p' });
    assert.equal(third.guards.length, 1);
  } finally {
    if (old === undefined) delete process.env.DS_STUDIO_OWNER_USER_ID; else process.env.DS_STUDIO_OWNER_USER_ID = old;
  }
});

test('sealed mixed references preserve exact image/video/audio provider types from the same proved bytes', async t => {
  const mode = ['imageReference:1', 'videoReference:1', 'audioReference:1'];
  const f = await setupE001(t, {
    name: 'Mixed', modelName: 'video', type: 'video', mode: [mode],
    durationResolutionMap: [{ duration: [5], resolution: ['720p'] }], audio: false,
  });
  await f.db('o_image').where({ id: 1 }).update({ filePath: '/ref/image.png', type: 'image', state: '已完成' });
  for (const item of [
    { asset: 4, image: 4, path: '/ref/video.mp4', type: 'video' },
    { asset: 5, image: 5, path: '/ref/audio.mp3', type: 'audio' },
  ]) {
    await f.db('o_assets').insert({ id: item.asset, projectId: 1, imageId: item.image, type: 'clip' });
    await f.db('o_image').insert({ id: item.image, assetsId: item.asset, filePath: item.path, state: '已完成', type: item.type });
    await f.db('o_scriptAssets').insert({ scriptId: 10, assetId: item.asset });
  }
  f.files.set('/ref/image.png', pngBytes());
  f.files.set('/ref/video.mp4', mp4Bytes());
  f.files.set('/ref/audio.mp3', audioBytes());

  const reserved = await f.video.reserveE001VideoGeneration({ projectId: 1, scriptId: 10 }, [{
    trackId: f.shot.trackId, references: [
      { id: 1, sources: 'assets' }, { id: 4, sources: 'assets' }, { id: 5, sources: 'assets' },
    ], prompt: 'Shot', duration: 5, videoPath: `/1/video/${randomUUID()}.mp4`,
  }], { model: 'vendor:video', mode: JSON.stringify(mode), resolution: '720p' });
  const sealed = await f.video.sealE001VideoSource({ projectId: 1, scriptId: 10 }, reserved.guards[0]);
  assert.deepEqual(sealed.referenceList.map(x => x.type), ['image', 'video', 'audio']);
  assert.ok(sealed.referenceList[0].base64.startsWith('data:image/png;base64,'));
  assert.ok(sealed.referenceList[1].base64.startsWith('data:video/mp4;base64,'));
  assert.ok(sealed.referenceList[2].base64.startsWith('data:audio/mpeg;base64,'));
  const video = await f.db('o_video').where({ id: reserved.guards[0].videoId }).first();
  const source = JSON.parse(video.sourceSnapshot);
  assert.deepEqual(source.execution.references.map(x => x.mediaType), ['image', 'video', 'audio']);
  assert.deepEqual(source.execution.references.map(x => x.proof.sha256), [pngBytes(), mp4Bytes(), audioBytes()].map(sha));
});

test('unsupported reference count fails at seal before any provider invocation', async t => {
  const mode = ['videoReference:1'];
  const f = await setupE001(t, {
    name: 'Video refs', modelName: 'video', type: 'video', mode: [mode],
    durationResolutionMap: [{ duration: [5], resolution: ['720p'] }], audio: false,
  });
  for (const item of [
    { asset: 4, image: 4, path: '/ref/a.mp4' },
    { asset: 5, image: 5, path: '/ref/b.mp4' },
  ]) {
    await f.db('o_assets').insert({ id: item.asset, projectId: 1, imageId: item.image, type: 'clip' });
    await f.db('o_image').insert({ id: item.image, assetsId: item.asset, filePath: item.path, state: '已完成', type: 'video' });
    await f.db('o_scriptAssets').insert({ scriptId: 10, assetId: item.asset });
    f.files.set(item.path, mp4Bytes(item.asset));
  }
  let providerCalls = 0; f.utils.vm = () => ({ videoRequest: async () => { providerCalls++; return mp4Bytes().toString('base64'); } });
  const reserved = await f.video.reserveE001VideoGeneration({ projectId: 1, scriptId: 10 }, [{
    trackId: f.shot.trackId, references: [{ id: 4, sources: 'assets' }, { id: 5, sources: 'assets' }],
    prompt: 'Shot', duration: 5, videoPath: `/1/video/${randomUUID()}.mp4`,
  }], { model: 'vendor:video', mode: JSON.stringify(mode), resolution: '720p' });
  await assert.rejects(f.video.sealE001VideoSource({ projectId: 1, scriptId: 10 }, reserved.guards[0]),
    e => e.code === 'VIDEO_REFERENCE_UNSUPPORTED');
  assert.equal(providerCalls, 0);
});

test('001E candidate evidence cannot be physically deleted or rewritten after seal', async t => {
  const f = await setupE001(t);
  const candidate = await seedCandidate(f);
  await assert.rejects(f.db('o_video').where({ id: candidate.videoId }).delete());
  await assert.rejects(f.db('o_video').where({ id: candidate.videoId }).update({ sourceHash: 'd'.repeat(64) }));
  await assert.rejects(f.db('o_video').where({ id: candidate.videoId }).update({ outputSha256: 'e'.repeat(64) }));
});

test('AiVideo saveWithProof writes exactly proved MP4 bytes and preserves post-provider uncertainty', async t => {
  const f = await fixture(t);
  const bytes = mp4Bytes(9);
  f.utils.vendor.getModelList = async () => [{ modelName: 'video', type: 'video' }];
  f.utils.vendor.getVendor = () => ({ version: '2.0' });
  f.utils.vm = () => ({ videoRequest: async () => bytes.toString('base64') });
  const ai = f.load('utils/ai').default;
  const video = ai.Video('vendor:video');
  await video.run({ prompt: 'x', referenceList: [], mode: 'text', duration: 5, aspectRatio: '16:9', resolution: '720p', audio: false });
  const proof = await video.saveWithProof('/proof.mp4');
  assert.equal(proof.mime, 'video/mp4'); assert.equal(proof.byteLength, bytes.length); assert.equal(proof.sha256, sha(bytes));
  assert.ok(Buffer.isBuffer(f.writes.at(-1).bytes)); assert.deepEqual(f.writes.at(-1).bytes, bytes);

  f.utils.vm = () => ({ videoRequest: async () => { throw Error('remote ambiguity'); } });
  const uncertain = ai.Video('vendor:video');
  await assert.rejects(uncertain.run({ prompt: 'x', referenceList: [], mode: 'text', duration: 5,
    aspectRatio: '16:9', resolution: '720p', audio: false }), e =>
      e.code === 'PROVIDER_SUBMISSION_UNCERTAIN' && e.providerSubmissionUncertain === true);
});


test('Workbench generate data uses effective Model Preset video authority instead of legacy project field only', async t => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '../src/routes/production/workbench/getGenerateData.ts'), 'utf8');
  assert.match(source, /resolveModels\(projectId\)/);
  assert.match(source, /effectiveVideoModel/);
  assert.doesNotMatch(source, /if \(!projectData\?\.videoModel\)/);
});
