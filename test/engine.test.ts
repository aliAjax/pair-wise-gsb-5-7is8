// 引擎审查链行为测试：npx esbuild 打包为 CJS 后由 node 运行
import { LensEngine, migrateLegacy } from '../src/core/engine';
import { MemoryPersistence } from '../src/core/persistence';
import { parseLockfile, SAMPLE_LOCK_V1, SAMPLE_LOCK_V2 } from '../src/core/lockfile';
import { fingerprintOf } from '../src/core/digest';
import { buildViews, openDisputes, pendingItems, verdictStatus } from '../src/core/selectors';
import { DEFAULT_RULES } from '../src/core/policy';
import type { Auditor, EvidenceDraft, StoreState } from '../src/core/types';

const A: Auditor = { id: 'auditor-jia', name: '审计员甲', initials: '甲' };
const B: Auditor = { id: 'auditor-yi', name: '审计员乙', initials: '乙' };

let passed = 0;
let failed = 0;
function ok(cond: unknown, msg: string) {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`  ✗ ${msg}`);
  }
}
function eq<T>(actual: T, expected: T, msg: string) {
  ok(JSON.stringify(actual) === JSON.stringify(expected), `${msg} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}

function makeEngine(adapter = new MemoryPersistence()) {
  let t = 0;
  const eng = new LensEngine(adapter, () => new Date(Date.UTC(2026, 9, 1, 9, 0, t++)));
  return eng;
}

const depsV1 = parseLockfile(SAMPLE_LOCK_V1);

// 1. 锁文件解析（根包 "" 不纳入依赖清单）
ok(depsV1.length === 5, `v1 锁文件解析出 5 个外部依赖，实际 ${depsV1.length}`);
const react = depsV1.find((d) => d.name === 'react')!;
eq(react.version, '18.3.1', 'react 版本');
eq(react.fingerprint, fingerprintOf({ name: 'react', version: '18.3.1', license: 'MIT', ecosystem: 'npm' }), '指纹确定性');

// 2. v1 旧数据迁移：回填指纹和基线，旧裁决 legacy
const legacy = [
  { id: 1, name: 'react', version: '18.3.1', license: 'MIT', source: 'npm', status: 'ok', note: '宽松许可' },
  { id: 5, name: 'legacy-parser', version: '2.1.0', license: 'GPL-3.0', source: '手动', status: 'risk', note: '冲突' },
];
const migrated = migrateLegacy(legacy, new Date().toISOString())!;
ok(migrated.migrated === 2, '迁移 2 个组件');
ok(migrated.state.components['npm:react'].fingerprint.startsWith('f1:'), '回填指纹');
eq(migrated.state.verdicts['npm:react'].baselineVersion, 1, '回填基线版本');
ok(migrated.state.verdicts['npm:react'].legacy === true, '旧裁决标记 legacy 等待确认');

// 迁移经 bootstrap 落盘且 legacy 判定为 stale-legacy
{
  const adapter = new MemoryPersistence();
  adapter.legacy = legacy;
  const eng = makeEngine(adapter);
  const r = eng.bootstrap();
  eq(r.migrated, 2, 'bootstrap 迁移数量');
  const views = buildViews(eng.state);
  const rv = views.find((v) => v.component.id === 'npm:react')!;
  eq(rv.validity, 'stale-legacy', '迁移裁决需重新确认');
  ok(adapter.loadLegacy() === null, '迁移后清理 v1 键');
}

// 3. 扫描中断留下半截依赖，从完整批次继续
{
  const eng = makeEngine();
  eng.bootstrap();
  const r = eng.startScan(depsV1, A, { interruptAfter: 3 });
  ok(r.interrupted, '扫描被中断');
  eq(r.receipt.items.filter((i) => i.status === 'done').length, 3, '已完成 3 项');
  eq(r.receipt.items.filter((i) => i.status === 'pending').length, 2, '剩余 2 项挂起');
  eq(Object.keys(eng.state.components).length, 3, '磁盘上只有 3 个半截依赖');
  eq(r.receipt.status, 'partial', '回执 partial');

  // 重新加载引擎模拟刷新页面：bootstrap 恢复未决批次
  const adapter2 = new MemoryPersistence(eng.state);
  const eng2 = makeEngine();
  const rebuilt = new LensEngine(adapter2);
  const bres = rebuilt.bootstrap();
  eq(bres.resumed, 1, '恢复 1 个未决批次');
  const retried = rebuilt.retryAll();
  eq(retried.length, 1, '重试 1 个批次');
  eq(retried[0].stillPending, 0, '全部完成');
  eq(Object.keys(rebuilt.state.components).length, 5, '5 个依赖齐全');
  eq(rebuilt.state.batches[r.receipt.id].status, 'committed', '批次最终 committed');
  // done 项未被重复处理
  eq(rebuilt.state.batches[r.receipt.id].items[0].attempts, 1, '已完成项不重复执行');
}

// 4. 包指纹更新后旧裁决等待重新确认（react 18->19, legacy-parser 换证）
{
  const eng = makeEngine();
  eng.bootstrap();
  eng.startScan(depsV1, A);
  const cid = 'npm:react';
  eng.decide(cid, 'approved', 'MIT 没问题', A);
  let v = buildViews(eng.state).find((x) => x.component.id === cid)!;
  eq(v.validity, 'fresh', '裁决有效');

  const depsV2 = parseLockfile(SAMPLE_LOCK_V2);
  eng.startScan(depsV2, B);
  v = buildViews(eng.state).find((x) => x.component.id === cid)!;
  eq(v.component.version, '19.0.0', 'react 升级到 19');
  eq(v.validity, 'stale-fingerprint', '指纹变化 → 旧裁决待重新确认');
  const lp = buildViews(eng.state).find((x) => x.component.id === 'npm:legacy-parser')!;
  eq(lp.component.license, 'Apache-2.0', 'legacy-parser 换证 Apache-2.0');
  eq(lp.validity, 'missing', '换证组件原无裁决，需重新裁决');
  const ssp = buildViews(eng.state).find((x) => x.component.id === 'npm:sspldb')!;
  eq(ssp.validity, 'missing', '新包无裁决');
  eq(ssp.suggestion.decision, 'rejected', 'SSPL 基线建议拒绝');

  // 重新确认后恢复 fresh
  eng.decide(cid, 'approved', 'react 19 仍是 MIT', B);
  v = buildViews(eng.state).find((x) => x.component.id === cid)!;
  eq(v.validity, 'fresh', '重新确认后 fresh');
}

// 5. 基线更新后旧裁决等待重新确认
{
  const eng = makeEngine();
  eng.bootstrap();
  eng.startScan(depsV1, A);
  eng.decide('npm:lodash', 'approved', 'MIT', A);
  const pub = eng.publishBaseline(DEFAULT_RULES, A, '收紧 GPL 策略');
  eq(pub.version, 2, '基线升级 v2');
  const v = buildViews(eng.state).find((x) => x.component.id === 'npm:lodash')!;
  eq(v.validity, 'stale-baseline', '基线更新 → 裁决待确认');
  // 新裁决绑定新基线
  eng.decide('npm:lodash', 'approved', '确认无误', A);
  eq(verdictStatus(eng.state, eng.state.components['npm:lodash']), 'fresh', '重裁后 fresh');
}

// 6. 商业授权/豁免覆盖对应组件；授权优先于策略拒绝
{
  const eng = makeEngine();
  eng.bootstrap();
  eng.startScan(depsV1, A);
  const lpId = 'npm:legacy-parser';
  let v = buildViews(eng.state).find((x) => x.component.id === lpId)!;
  eq(v.suggestion.decision, 'rejected', 'GPL-3.0 基线拒绝');
  eq(v.covers.length, 0, '暂无覆盖材料');

  const draft: EvidenceDraft = {
    componentId: lpId,
    kind: 'commercial-license',
    title: 'Vendor 商业授权 PO-2026-041',
    detail: '收购方已取得 legacy-parser 2.x 的永久商业分发授权',
    contact: 'vendor@example.com',
    attachmentName: 'commercial-license.pdf',
  };
  const res = eng.saveEvidence([draft], B);
  ok(!res.conflict && !res.failure, '材料保存成功');
  v = buildViews(eng.state).find((x) => x.component.id === lpId)!;
  eq(v.covers.length, 1, '商业授权覆盖该组件');
  eq(v.suggestion.decision, 'approved', '授权优先 → 建议通过');
  ok(v.suggestion.reason.includes('商业授权'), '建议理由引用授权');

  // 豁免同样覆盖
  const ex = eng.saveEvidence(
    [{ componentId: 'npm:highlight.js', kind: 'exemption', title: '法务豁免 HJ-7', detail: '保留声明，法务已签字', contact: 'legal@x.com' }],
    A,
  );
  ok(!ex.failure, '豁免保存成功');
  const hv = buildViews(eng.state).find((x) => x.component.id === 'npm:highlight.js')!;
  eq(hv.covers[0].kind, 'exemption', '豁免覆盖');
  eq(hv.suggestion.decision, 'approved', '豁免 → 通过');

  // 不相关组件不受影响
  const rv = buildViews(eng.state).find((x) => x.component.id === 'npm:react')!;
  eq(rv.covers.length, 0, '授权不覆盖其他组件');
}

// 7. 两标签同时保存同一批次：后到者保留材料并进入争议清单
{
  const adapter = new MemoryPersistence();
  const engA = makeEngine(adapter);
  engA.bootstrap();
  engA.startScan(depsV1, A);

  const lpId = 'npm:legacy-parser';
  const draftA: EvidenceDraft = { componentId: lpId, kind: 'commercial-license', title: '甲的商业授权', detail: '甲取得授权 A-1', contact: 'a@x.com' };
  const draftB: EvidenceDraft = { componentId: lpId, kind: 'exemption', title: '乙的法务豁免', detail: '乙取得豁免 B-2', contact: 'b@x.com' };

  // 甲先保存成功；乙在同一修订分叉上后到（forceLateArrival 模拟无 storage 事件的窗口）
  const ra = engA.saveEvidence([draftA], A);
  ok(!ra.conflict, '先到者正常提交');
  const rb = engA.saveEvidence([draftB], B, { forceLateArrival: true });
  ok(rb.conflict, '后到者进入争议流程');
  eq(rb.receipt.status, 'disputed', '后到批次 disputed');
  const disputes = openDisputes(engA.state);
  eq(disputes.length, 1, '争议清单 1 条');
  eq(disputes[0].keptBy, 'auditor-jia', '先到者材料保留');
  eq(disputes[0].laterItems.length, 1, '后到者材料完整保留');
  ok(disputes[0].laterItems[0].status === 'conflict', '材料项标记 conflict 但负载保留');
  // 先到材料仍有效，后到材料尚未覆盖
  let v = buildViews(engA.state).find((x) => x.component.id === lpId)!;
  eq(v.covers.length, 1, '争议期间先到授权仍覆盖');
  eq(v.covers[0].title, '甲的商业授权', '保留的是甲的材料');

  // 合并：后到材料补入
  engA.resolveDispute(disputes[0].id, 'merge', A, '两份材料均有效');
  v = buildViews(engA.state).find((x) => x.component.id === lpId)!;
  eq(v.covers.length, 2, '合并后两份覆盖');
  eq(openDisputes(engA.state).length, 0, '争议关闭');
}

// 7b. 舍弃争议材料
{
  const adapter = new MemoryPersistence();
  const eng = makeEngine(adapter);
  eng.bootstrap();
  eng.startScan(depsV1, A);
  eng.saveEvidence(
    [{ componentId: 'npm:react', kind: 'license-text', title: '甲的 MIT 原文', detail: 'LICENSE 快照' }],
    A,
  );
  const late = eng.saveEvidence(
    [{ componentId: 'npm:react', kind: 'exemption', title: '乙的豁免', detail: '重复材料' }],
    B,
    { forceLateArrival: true },
  );
  const d = openDisputes(eng.state)[0];
  eng.resolveDispute(late.disputeId!, 'discard', A, '重复，舍弃');
  const v = buildViews(eng.state).find((x) => x.component.id === 'npm:react')!;
  eq(v.covers.length, 0, '舍弃后无覆盖材料');
  eq(eng.state.disputes[d.id].status, 'discarded', '争议状态 discarded');
}

// 8. 落盘失败后从完整批次继续，重试未完成项
{
  const adapter = new MemoryPersistence();
  const eng = makeEngine(adapter);
  eng.bootstrap();
  // 登记回执落盘失败：完整批次保留在内存，磁盘恢复后从完整批次继续
  adapter.setFailNext(1);
  const r = eng.startScan(depsV1, A);
  ok(!!r.failure, '扫描因落盘失败中断');
  // 完整批次负载保留在内存，可从完整批次继续
  eq(r.receipt.items.length, 5, '完整批次仍保留 5 项负载');

  // 磁盘恢复后重试：未完成项继续，已完成（若有）幂等
  const results = eng.retryAll();
  const sum = results.reduce((acc, x) => acc + x.stillPending, 0);
  eq(sum, 0, '重试后无挂起项');
  eq(Object.keys(eng.state.components).length, 5, '5 个依赖全部落盘');
  eq(eng.state.batches[r.receipt.id].status, 'committed', '失败批次最终提交');
}

// 8b. 证据保存落盘失败后重试，材料不丢
{
  const adapter = new MemoryPersistence();
  const eng = makeEngine(adapter);
  eng.bootstrap();
  eng.startScan(depsV1, A);
  adapter.setFailNext(1);
  const r = eng.saveEvidence(
    [{ componentId: 'npm:react', kind: 'commercial-license', title: '授权 R-9', detail: '重试场景' }],
    B,
  );
  ok(!!r.failure, '证据保存遇落盘失败');
  eq(eng.inflightCount() >= 1, true, '存在未决批次');
  const out = eng.retryAll();
  eq(out[0].stillPending, 0, '重试完成');
  const v = buildViews(eng.state).find((x) => x.component.id === 'npm:react')!;
  eq(v.covers.length, 1, '授权材料经重试后落盘');
}

// 9. 跨标签 CAS：不冲突的并发提交自动合并
{
  const adapter = new MemoryPersistence();
  const eng = makeEngine(adapter);
  eng.bootstrap();
  eng.startScan(depsV1, A);
  // 模拟另一个标签先发了基线
  adapter.externalCommit((s) => {
    const next: StoreState = JSON.parse(JSON.stringify(s));
    next.rev = s.rev; // commit 内不增 rev，由引擎 flush 增
    next.baseline = { ...s.baseline, version: 3, publishedAt: new Date().toISOString(), publishedBy: B.id };
    return next;
  });
  // 甲的裁决基于旧 rev，CAS 失败后应自动 rebase 到新基线
  const dec = eng.decide('npm:react', 'approved', '自动重放', A);
  ok(!dec.failure, '裁决在并发下自动成功');
  eq(dec.verdict.baselineVersion, 3, '裁决绑定磁盘最新基线 v3');
  eq(eng.state.baseline.version, 3, '引擎看到远端基线');
}

// 10. pendingItems / 批次状态辅助
{
  const eng = makeEngine();
  eng.bootstrap();
  const r = eng.startScan(depsV1, A, { interruptAfter: 2 });
  eq(pendingItems(eng.state).length, 3, '3 个挂起项可见');
  eq(r.receipt.items[2].status, 'pending', '第三项挂起');
}

// 11. 真实双标签时序：乙在甲提交前打开编辑（读取点 rev=n），保存晚到
{
  const adapter = new MemoryPersistence();
  const tabA = makeEngine(adapter);
  tabA.bootstrap();
  tabA.startScan(depsV1, A);
  // 标签 B 独立实例，此刻读到与 A 相同的 rev
  const tabB = new LensEngine(adapter);
  const readRevB = tabB.state.rev;

  const cid = 'npm:legacy-parser';
  const dA: EvidenceDraft = { componentId: cid, kind: 'commercial-license', title: '甲-商业授权', detail: 'A' };
  const dB: EvidenceDraft = { componentId: cid, kind: 'exemption', title: '乙-法务豁免', detail: 'B' };

  const rA = tabA.saveEvidence([dA], A);
  const rB = tabB.saveEvidence([dB], B, { readRev: readRevB });
  ok(!rA.conflict, '先到者甲正常提交');
  ok(rB.conflict, '后到者乙（基于旧读取点）进入争议');

  const views = buildViews(tabA.state).filter((v) => v.component.id === cid)[0];
  eq(views.covers.length, 1, '先到者材料是唯一有效覆盖');
  eq(views.covers[0].title, '甲-商业授权', '保留甲的材料');
  const disputes = openDisputes(tabA.state);
  eq(disputes.length, 1, '一条开放争议');
  eq(disputes[0].laterItems.length, 1, '乙的材料完整保留于争议清单');
  eq(disputes[0].keptBy, 'auditor-jia', 'keptBy 指向先到者');
  const allEv = Object.values(tabA.state.evidence).filter((e) => e.componentId === cid);
  eq(allEv.length, 1, '乙的材料未污染证据存储');

  tabA.resolveDispute(disputes[0].id, 'merge', A, '合并');
  eq(buildViews(tabA.state).find((v) => v.component.id === cid)!.covers.length, 2, '合并后两份覆盖生效');
}

// 12. 同一审计员连续保存或不同组件并发不误报争议
{
  const eng = makeEngine();
  eng.bootstrap();
  eng.startScan(depsV1, A);
  const base = eng.state.rev;
  const r1 = eng.saveEvidence([{ componentId: 'npm:react', kind: 'license-text', title: 'MIT 原文', detail: 'x' }], A, { readRev: base });
  const r2 = eng.saveEvidence([{ componentId: 'npm:react', kind: 'commercial-license', title: '授权书', detail: 'y' }], A, { readRev: base });
  const r3 = eng.saveEvidence([{ componentId: 'npm:lodash', kind: 'license-text', title: 'L', detail: 'z' }], A, { readRev: base });
  ok(!r1.conflict && !r2.conflict && !r3.conflict, '同人连续保存不构成争议');
  eq(openDisputes(eng.state).length, 0, '无争议');
}

console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
