'use strict';

if (process.env.CANDIDATE_PORT_CHILD === '1') {
  const serverModule = require('./server.js');
  serverModule.startServer(Number(process.env.CANDIDATE_OCCUPIED_PORT), 3, { open: false }).then(info => {
    process.send({ port: info.port, url: info.url, actualPort: info.server.address().port });
    process.once('message', () => info.server.close(() => process.exit(0)));
  }).catch(error => { process.send({ error: error.message }); process.exit(1); });
} else {
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const http = require('node:http');
  const { fork } = require('node:child_process');
  const { once } = require('node:events');
  (async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vos-port-binding-'));
    let child, sourceRequests = 0;
    const occupied = http.createServer((req, res) => { sourceRequests += 1; res.end('original service sentinel'); });
    await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve));
    const blockedPort = occupied.address().port;
    try {
      const project = path.join(root, 'project'), data = path.join(root, 'data');
      fs.mkdirSync(project); fs.mkdirSync(data);
      child = fork(__filename, [], { env: { ...process.env, CANDIDATE_PORT_CHILD: '1',
        CANDIDATE_OCCUPIED_PORT: String(blockedPort), VIDEO_OS_PROJECT_ROOT: project, VIDEO_OS_DATA_DIR: data,
        OBSIDIAN_VAULT_PATH: path.join(root, 'obsidian') }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      const message = await Promise.race([once(child, 'message').then(([value]) => value),
        once(child, 'exit').then(([code]) => { throw new Error(`候选端口fixture提前退出：${code}`); }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('端口fixture超时')), 15000).unref())]);
      assert.equal(message.error, undefined);
      assert.notEqual(message.actualPort, blockedPort);
      assert.equal(message.port, message.actualPort, 'startServer.port必须取实际监听端口');
      assert.equal(Number(new URL(message.url).port), message.actualPort, 'startServer.url必须取实际监听端口');
      const status = await new Promise((resolve, reject) => {
        const request = http.get({ hostname: '127.0.0.1', port: message.actualPort, path: '/creator.html', agent: false }, response => {
          response.resume(); response.once('end', () => resolve(response.statusCode));
        });
        request.setTimeout(3000, () => request.destroy(new Error('本机HTTP读回超时')));
        request.once('error', reject);
      });
      assert.equal(status, 200);
      assert.equal(sourceRequests, 0, '候选页面不能命中被占用的原服务');
      const closed = once(child, 'exit'); child.send('quit'); await closed; child = null;
      console.log('SERVER_PORT_BINDING_PASS occupiedPortFallback=true actualPortUrlMatch=true originalServiceRequests=0');
    } finally {
      if (child && child.exitCode === null) { const closed = once(child, 'exit'); child.kill('SIGTERM'); await closed; }
      await new Promise(resolve => occupied.close(resolve));
      fs.rmSync(root, { recursive: true, force: true });
    }
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
