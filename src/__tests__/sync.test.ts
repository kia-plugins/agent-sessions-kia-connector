import type { DocumentInput } from '@kiagent/connector-sdk';
import { fakeSession } from '@kiagent/connector-sdk/testing';
import { h, initialCursor, runSync, type SyncCursor, type Unit } from '../sync';

type Spec = { key: string; mtime?: number; size?: number; ino?: string; parent?: string; fail?: boolean; docs?: number; deps?: string[] };
let renders: string[];
function units(specs: Spec[]): Unit[] {
  return specs.map((s) => ({
    key: s.key,
    files: [{ rel: s.key, size: s.size ?? 10, mtimeMs: s.mtime ?? 1, dev: '1', ino: s.ino ?? '1' }],
    deps: s.deps,
    parentH: s.parent ? h(s.parent) : undefined,
    async render() {
      renders.push(s.key);
      if (s.fail) throw new Error('boom');
      return Array.from({ length: s.docs ?? 1 }, (_, i): DocumentInput => ({
        externalId: `${s.key}#${i}`, type: 'agent.session', title: s.key, markdown: 'm', metadata: {}, createdAt: null,
      }));
    },
  }));
}
async function drain(cursor: SyncCursor, specs: Spec[], opts: { maxDocs?: number; stopAfter?: number } = {}) {
  const batches = [];
  for await (const b of runSync({ cursor, units: units(specs), session: fakeSession(), maxDocs: opts.maxDocs })) {
    batches.push(b);
    if (opts.stopAfter && batches.length >= opts.stopAfter) break; // simulated crash
  }
  return { batches, cursor: batches.at(-1)!.cursor };
}
beforeEach(() => { renders = []; });
const C0 = () => initialCursor('UTC');

it('backfill-then-live-phase and terminal-batch-always', async () => {
  const a = await drain(C0(), [{ key: 'a' }]);
  expect(a.batches.map((b) => b.phase)).toEqual(['backfill']);
  expect(a.cursor.pass).toBe('done');
  const b = await drain(a.cursor, [{ key: 'a' }]);
  expect(b.batches).toEqual([expect.objectContaining({ phase: 'live', items: [] })]);
  expect(renders).toEqual(['a']);
});

it('appended-unit-reprocessed (A at 900 then 1100; B discovered at 1200)', async () => {
  let c = (await drain(C0(), [{ key: 'A', mtime: 900 }])).cursor;
  renders = [];
  c = (await drain(c, [{ key: 'A', mtime: 1100 }, { key: 'B', mtime: 1200 }])).cursor;
  expect(renders.sort()).toEqual(['A', 'B']);
});

it('same-mtime-different-size, inode-change, future-mtime all reprocess', async () => {
  const c = (await drain(C0(), [{ key: 'a' }, { key: 'b' }, { key: 'c' }])).cursor;
  renders = [];
  await drain(c, [{ key: 'a', size: 11 }, { key: 'b', ino: '2' }, { key: 'c', mtime: 9e15 }]);
  expect(renders.sort()).toEqual(['a', 'b', 'c']);
});

// render-version-bump-rerenders-all: RENDER_VERSION is a module constant hashed
// into every fp exactly like deps, so a deps change on every unit stands in for it
// (mutant: drop RENDER_VERSION from base() — covered by review, not by a test).
it('render-version / deps change re-renders', async () => {
  const c = (await drain(C0(), [{ key: 'a', deps: ['t1'] }])).cursor;
  renders = [];
  await drain(c, [{ key: 'a', deps: ['t2'] }]);
  expect(renders).toEqual(['a']);
});

it('crash-resume-redoes-only-uncommitted', async () => {
  const first = await drain(C0(), [{ key: 'a' }, { key: 'b' }, { key: 'c' }], { maxDocs: 1, stopAfter: 1 });
  renders = [];
  await drain(first.cursor, [{ key: 'a' }, { key: 'b' }, { key: 'c' }]);
  expect(renders).toEqual(['b', 'c']);
});

it('corrupt-unit-committed-and-retried-on-change (+ unchanged tick does not re-read it)', async () => {
  let c = (await drain(C0(), [{ key: 'x', fail: true }])).cursor;
  expect(c.fps[h('x')].startsWith('!')).toBe(true);
  renders = [];
  c = (await drain(c, [{ key: 'x', fail: true }])).cursor;
  expect(renders).toEqual([]);
  await drain(c, [{ key: 'x', mtime: 2 }]);
  expect(renders).toEqual(['x']);
});

it('children-rendered-once-with-new-parent; parent-before-child ordering', async () => {
  const specs = [{ key: 'c:child', parent: 'p' }, { key: 'p' }];
  const c = (await drain(C0(), specs)).cursor;
  expect(renders).toEqual(['p', 'c:child']);
  renders = [];
  await drain(c, specs);
  expect(renders).toEqual([]);
});

it('parent-before-child-across-batch-boundary (same-second pair, batch size 1)', async () => {
  // The child's key sorts FIRST, so only parent-first ordering puts the parent ahead.
  const { batches } = await drain(C0(), [{ key: 'a-child', parent: 'z-parent' }, { key: 'z-parent' }], { maxDocs: 1 });
  expect(batches.flatMap((b) => b.items.map((i) => i.externalId))).toEqual(['z-parent#0', 'a-child#0']);
});

it('late-parent-reemits-children', async () => {
  let c = (await drain(C0(), [{ key: 'kid', parent: 'mom' }])).cursor; // parent not present yet
  renders = [];
  c = (await drain(c, [{ key: 'kid', parent: 'mom' }, { key: 'mom' }])).cursor;
  expect(renders).toEqual(['mom', 'kid']);
});

it('failed-parent-children-reemitted-after-repair', async () => {
  let c = (await drain(C0(), [{ key: 'P', fail: true }, { key: 'C', parent: 'P' }])).cursor;
  renders = [];
  c = (await drain(c, [{ key: 'P', fail: true }, { key: 'C', parent: 'P' }])).cursor;
  expect(renders).toEqual([]);
  await drain(c, [{ key: 'P', mtime: 5 }, { key: 'C', parent: 'P' }]);
  expect(renders).toEqual(['P', 'C']);
});

it('parent-fail-child-commit-crash-repair-resume-links', async () => {
  const specs = [{ key: 'P', fail: true }, { key: 'C', parent: 'P' }];
  const crashed = await drain(C0(), specs, { maxDocs: 1, stopAfter: 1 }); // C committed, then crash
  renders = [];
  await drain(crashed.cursor, [{ key: 'P', mtime: 5 }, { key: 'C', parent: 'P' }]);
  expect(renders).toEqual(['P', 'C']);
});

it('crash-after-parent-commit-reemits-children', async () => {
  const specs = [{ key: 'P' }, { key: 'C', parent: 'P' }];
  const crashed = await drain(C0(), specs, { maxDocs: 1, stopAfter: 1 }); // only P committed
  renders = [];
  await drain(crashed.cursor, specs);
  expect(renders).toEqual(['C']);
});

it('vanished-key-kept-in-fps', async () => {
  const c = (await drain(C0(), [{ key: 'a' }, { key: 'b' }])).cursor;
  const d = (await drain(c, [{ key: 'a' }])).cursor;
  expect(d.fps[h('b')]).toBe(c.fps[h('b')]);
});

it('batch-never-exceeds-25-docs (479-child family); multi-doc unit fp only after its last doc', async () => {
  const specs: Spec[] = [{ key: 'p' }, ...Array.from({ length: 479 }, (_, i) => ({ key: `k${i}`, parent: 'p' }))];
  const { batches } = await drain(C0(), specs);
  expect(Math.max(...batches.map((b) => b.items.length))).toBeLessThanOrEqual(25);
  const multi = await drain(C0(), [{ key: 'hist', docs: 30 }]);
  expect(multi.batches[0].items).toHaveLength(25);
  expect(multi.batches[0].cursor.fps[h('hist')]).toBeUndefined();
  expect(multi.cursor.fps[h('hist')]).toBeDefined();
});

it('batch-never-exceeds-8MiB of markdown', async () => {
  const MiB = 1024 * 1024;
  const big: Unit[] = Array.from({ length: 10 }, (_, i) => ({
    key: `m${i}`,
    files: [{ rel: `m${i}`, size: 1, mtimeMs: 1, dev: '1', ino: '1' }],
    async render() {
      return [{ externalId: `m${i}`, type: 'agent.session', title: 't', markdown: 'x'.repeat(MiB), metadata: {}, createdAt: null }];
    },
  }));
  const sizes: number[] = [];
  for await (const b of runSync({ cursor: C0(), units: big, session: fakeSession() })) sizes.push(b.items.length);
  expect(sizes).toEqual([8, 2]);
});

it('intermediate cursors carry tz', async () => {
  const { batches } = await drain(initialCursor('Asia/Tokyo'), [{ key: 'a' }, { key: 'b' }], { maxDocs: 1 });
  expect(batches.every((b) => b.cursor.tz === 'Asia/Tokyo')).toBe(true);
});
