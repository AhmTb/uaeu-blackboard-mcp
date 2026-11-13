import test from 'node:test';
import assert from 'node:assert/strict';
import { BlackboardApi } from '../dist/bb/api.js';
import { BlackboardError } from '../dist/bb/client.js';

test('student members come from expanded course groups, not nonexistent member endpoints', async () => {
  const members = [{ userId: '_2_1', user: { givenName: 'Test' } }];
  const api = new BlackboardApi({
    mode: 'internal', config: {},
    getAll: async (path, options) => {
      assert.equal(path, '/courses/_1_1/groups');
      assert.match(options.query.expand, /memberships\.user/);
      return [{ id: '_3_1', memberships: members }];
    },
    get: async () => { throw new BlackboardError('Wrong endpoint', 404, '', {}); },
  });
  assert.deepEqual(await api.groupMembers('_1_1', '_3_1'), members);
});

test('member lookup preserves outages and expired sessions instead of reporting empty', async () => {
  for (const status of [401, 403, 500]) {
    const error = new BlackboardError('Unavailable', status, '', {});
    const api = new BlackboardApi({ mode: 'internal', config: {},
      getAll: async () => { throw error; }, get: async () => { throw error; } });
    await assert.rejects(api.groupMembers('_1_1', '_3_1'), e => e === error);
  }
});

test('a genuinely empty group is distinguished from missing membership data', async () => {
  for (const memberships of [[], undefined]) {
    const api = new BlackboardApi({ mode: 'internal', config: {},
      getAll: async () => [{ id: '_3_1', memberships }] });
    if (memberships) assert.deepEqual(await api.groupMembers('_1_1', '_3_1'), []);
    else await assert.rejects(api.groupMembers('_1_1', '_3_1'), /membership/i);
  }
});

test('public mode uses the public group users collection', async () => {
  const api = new BlackboardApi({ mode: 'public', config: {}, getAll: async path => {
    assert.equal(path, '/courses/_1_1/groups/_3_1/users');
    return [{ userId: '_2_1' }];
  } });
  assert.equal((await api.groupMembers('_1_1', '_3_1')).length, 1);
});
