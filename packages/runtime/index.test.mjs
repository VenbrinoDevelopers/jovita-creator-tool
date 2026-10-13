import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { invokeCapability, recoverCapability, stableCallId } from './index.js';

test('uses one stable ID, acknowledges delivery, and returns only after acknowledgment', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jovita-miniapp-client-'));
  const path = join(dir, 'broker.sock');
  const frames = [];
  const server = createServer(socket => {
    let data = '';
    socket.on('data', chunk => {
      data += chunk;
      if (!data.includes('\n')) return;
      const frame = JSON.parse(data.trim());
      frames.push(frame);
      socket.end(JSON.stringify({ protocolVersion: 2, ok: true,
        result: frame.type === 'invoke' ? { places: ['one'] } : { acknowledged: true } }) + '\n');
    });
  });
  const before = { socket: process.env.JOVITA_CAPABILITY_SOCKET, token: process.env.JOVITA_CAPABILITY_TOKEN };
  try {
    await new Promise((resolve, reject) => server.listen(path, resolve).once('error', reject));
    process.env.JOVITA_CAPABILITY_SOCKET = path;
    process.env.JOVITA_CAPABILITY_TOKEN = 'test-token';
    const callId = stableCallId('search', { q: 'Lagos', num: 1 });
    assert.equal(callId, stableCallId('search', { num: 1, q: 'Lagos' }));
    const received = [];
    const result = await invokeCapability('serper.maps.search', { q: 'Lagos' },
      { callId, onReceived: value => received.push(value) });
    assert.deepEqual(result, { places: ['one'] });
    assert.deepEqual(received, [result]);
    assert.deepEqual(frames.map(frame => frame.type), ['invoke', 'ack']);
    assert.equal(frames[0].callId, frames[1].callId);
    assert.equal(frames[0].token, 'test-token');
    await invokeCapability('serper.maps.search', { q: 'repeat' });
    await invokeCapability('serper.maps.search', { q: 'repeat' });
    assert.deepEqual(frames.slice(2).map(frame => frame.type), ['invoke', 'ack', 'invoke', 'ack']);
    assert.notEqual(frames[2].callId, frames[4].callId);
    assert.equal(frames[2].callId, frames[3].callId);
    assert.equal(frames[4].callId, frames[5].callId);
  } finally {
    if (before.socket === undefined) delete process.env.JOVITA_CAPABILITY_SOCKET;
    else process.env.JOVITA_CAPABILITY_SOCKET = before.socket;
    if (before.token === undefined) delete process.env.JOVITA_CAPABILITY_TOKEN;
    else process.env.JOVITA_CAPABILITY_TOKEN = before.token;
    await new Promise(resolve => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reports a failed delivery acknowledgment and allows receipt recovery', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jovita-miniapp-client-recovery-'));
  const path = join(dir, 'broker.sock');
  const frames = [];
  const server = createServer(socket => {
    let data = '';
    socket.on('data', chunk => {
      data += chunk;
      if (!data.includes('\n')) return;
      const frame = JSON.parse(data.trim());
      frames.push(frame);
      socket.end(JSON.stringify({ protocolVersion: 2, ok: frame.type !== 'ack',
        ...(frame.type === 'ack' ? { error: { code: 'ACK_REJECTED', message: 'Not delivered' } }
          : { result: { receipt: 'saved' } }) }) + '\n');
    });
  });
  const before = { socket: process.env.JOVITA_CAPABILITY_SOCKET, token: process.env.JOVITA_CAPABILITY_TOKEN };
  try {
    await new Promise((resolve, reject) => server.listen(path, resolve).once('error', reject));
    process.env.JOVITA_CAPABILITY_SOCKET = path;
    process.env.JOVITA_CAPABILITY_TOKEN = 'test-token';
    await assert.rejects(invokeCapability('serper.maps.search', { q: 'Lagos' }, { callId: 'call_fixed' }),
      { code: 'CAPABILITY_DELIVERY_ACK_FAILED' });
    const recovered = await recoverCapability('call_fixed', 'invocation-original', 'serper.maps.search');
    assert.deepEqual(recovered, { receipt: 'saved' });
    assert.deepEqual(frames.map(frame => frame.type), ['invoke', 'ack', 'recover']);
    assert.equal(frames[2].callId, 'call_fixed');
    assert.equal(frames[2].originInvocationId, 'invocation-original');
  } finally {
    if (before.socket === undefined) delete process.env.JOVITA_CAPABILITY_SOCKET;
    else process.env.JOVITA_CAPABILITY_SOCKET = before.socket;
    if (before.token === undefined) delete process.env.JOVITA_CAPABILITY_TOKEN;
    else process.env.JOVITA_CAPABILITY_TOKEN = before.token;
    await new Promise(resolve => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recovers an uncertain async call with the same ID and acknowledges its result once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jovita-miniapp-async-'));
  const path = join(dir, 'broker.sock');
  const frames = [];
  const server = createServer(socket => {
    let data = '';
    socket.on('data', chunk => {
      data += chunk;
      if (!data.includes('\n')) return;
      const frame = JSON.parse(data.trim());
      frames.push(frame);
      const pending = frame.type === 'invoke' && frames.filter(item => item.type === 'invoke').length === 1;
      socket.end(JSON.stringify({ protocolVersion: 2, ok: !pending,
        ...(pending ? { error: { code: 'INVOCATION_OUTCOME_UNKNOWN', message: 'Job is pending' } }
          : { result: frame.type === 'ack' ? { acknowledged: true } : { attachment_id: 'media-1' } }) }) + '\n');
    });
  });
  const before = { socket: process.env.JOVITA_CAPABILITY_SOCKET, token: process.env.JOVITA_CAPABILITY_TOKEN };
  try {
    await new Promise((resolve, reject) => server.listen(path, resolve).once('error', reject));
    process.env.JOVITA_CAPABILITY_SOCKET = path;
    process.env.JOVITA_CAPABILITY_TOKEN = 'test-token';
    const result = await invokeCapability('broker.video.make.v1', { prompt: 'rain' },
      { callId: 'call_video' });
    assert.deepEqual(result, { attachment_id: 'media-1' });
    assert.deepEqual(frames.map(frame => frame.type), ['invoke', 'invoke', 'ack']);
    assert.ok(frames.every(frame => frame.callId === 'call_video'));
  } finally {
    if (before.socket === undefined) delete process.env.JOVITA_CAPABILITY_SOCKET;
    else process.env.JOVITA_CAPABILITY_SOCKET = before.socket;
    if (before.token === undefined) delete process.env.JOVITA_CAPABILITY_TOKEN;
    else process.env.JOVITA_CAPABILITY_TOKEN = before.token;
    await new Promise(resolve => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
