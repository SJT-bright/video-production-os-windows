'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { shellQuote, loadCandidateAcceptance, localStateDescription, assertDeliveryLayout, assertFreshDeliveryFiles } = require('./write-candidate-delivery.cjs');

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vos-delivery-receipt-')));
try {
  const file = path.join(root, 'candidate-native-launch-20261010.json');
  const verified = { candidateVersion: '1.3.0-rc.2', candidateUserData: path.join(root, 'profile'),
    candidateWorkspace: path.join(root, 'profile/workspace') };
  const result = { status: 'passed', version: verified.candidateVersion,
    runtime: { version: verified.candidateVersion, userData: verified.candidateUserData,
      projectRoot: verified.candidateWorkspace, candidateListenerConfirmed: true } };
  const save = value => fs.writeFileSync(file, JSON.stringify(value));
  save(result);
  assert.equal(loadCandidateAcceptance(file, verified).file, file);
  for (const invalid of [
    { ...result, status: 'failed' },
    { ...result, version: '1.3.0-rc.1' },
    { ...result, runtime: { ...result.runtime, userData: path.join(root, 'another-profile') } },
    { ...result, runtime: { ...result.runtime, candidateListenerConfirmed: false } },
  ]) {
    save(invalid);
    assert.throws(() => loadCandidateAcceptance(file, verified), /回执必须/);
  }
  assert.equal(localStateDescription({ projects: 6, imageTemplates: 11, videoTemplates: 4, scriptGroups: 9, scriptSegments: 70 }),
    '本轮实际读回 6 个项目、15 个模板、9 组共 70 段剧本文本。');
  assert.match(localStateDescription({}), /未记录完整/);
  const delivery = path.join(root, 'delivery');
  fs.mkdirSync(delivery);
  assertDeliveryLayout(delivery, path.join(delivery, 'Candidate.app'), verified.candidateUserData);
  assert.throws(() => assertDeliveryLayout(delivery, path.join(root, 'External.app'), verified.candidateUserData), /互不嵌套/);
  assert.throws(() => assertDeliveryLayout(delivery, path.join(delivery, 'Candidate.app'), root), /互不嵌套/);
  assert.throws(() => assertDeliveryLayout(delivery, path.join(delivery, 'Candidate.app'), path.join(delivery, 'profile')), /互不嵌套/);
  assertFreshDeliveryFiles(delivery);
  fs.writeFileSync(path.join(delivery, 'delivery-manifest.json'), '{}');
  assert.throws(() => assertFreshDeliveryFiles(delivery), /拒绝覆盖/);
  assert.equal(shellQuote("/tmp/user's app"), "'/tmp/user'\\''s app'");
  assert.throws(() => shellQuote('/tmp/app\nother'), /换行/);
  console.log('CANDIDATE_DELIVERY_RECEIPT_PASS versionProfileListenerGate=true liveReadbackCounts=true unknownNotZero=true profileOutDisjoint=true existingDeliveryPreserved=true');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
