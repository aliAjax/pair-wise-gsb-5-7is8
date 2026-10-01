// UI 端到端：jsdom 中渲染真实 App，走完整审查链界面流程
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
(globalThis as Record<string, unknown>).window = dom.window;
(globalThis as Record<string, unknown>).document = dom.window.document;
(globalThis as Record<string, unknown>).navigator = dom.window.navigator;
(globalThis as Record<string, unknown>).HTMLElement = dom.window.HTMLElement;
(globalThis as Record<string, unknown>).Element = dom.window.Element;
(globalThis as Record<string, unknown>).Node = dom.window.Node;
(globalThis as Record<string, unknown>).SVGElement = dom.window.SVGElement;
(globalThis as Record<string, unknown>).getComputedStyle = dom.window.getComputedStyle;
(globalThis as Record<string, unknown>).HTMLAnchorElement = dom.window.HTMLAnchorElement;
(globalThis as Record<string, unknown>).HTMLInputElement = dom.window.HTMLInputElement;
(globalThis as Record<string, unknown>).HTMLSelectElement = dom.window.HTMLSelectElement;
(globalThis as Record<string, unknown>).HTMLTextAreaElement = dom.window.HTMLTextAreaElement;
(globalThis as Record<string, unknown>).File = dom.window.File;
(globalThis as Record<string, unknown>).Blob = dom.window.Blob;
(globalThis as Record<string, unknown>).Event = dom.window.Event;
(globalThis as Record<string, unknown>).MouseEvent = dom.window.MouseEvent;
(globalThis as Record<string, unknown>).localStorage = dom.window.localStorage;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
(dom.window as unknown as { URL: { createObjectURL: () => string; revokeObjectURL: (u: string) => void } }).URL.createObjectURL = () => 'blob:x';
(dom.window as unknown as { URL: { revokeObjectURL: () => void } }).URL.revokeObjectURL = () => {};
dom.window.HTMLAnchorElement.prototype.click = function click() {};

import { act } from 'react';
import { createRoot } from 'react-dom/client';
// @ts-expect-error 测试入口
import App from '../src/App';
import { getEngine } from '../src/state/store';
import { LocalStoragePersistence } from '../src/core/persistence';
import { LensEngine } from '../src/core/engine';
import { SAMPLE_LOCK_V2 } from '../src/core/lockfile';
import { parseLockfile } from '../src/core/lockfile';
import type { EvidenceDraft } from '../src/core/types';

let passed = 0;
let failed = 0;
function ok(cond: unknown, msg: string) {
  if (cond) passed += 1;
  else {
    failed += 1;
    console.error(`  ✗ ${msg}`);
  }
}
const $ = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const $$ = (sel: string) => [...document.querySelectorAll(sel)] as HTMLElement[];
const text = () => document.body.textContent ?? '';
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 100)); });

/**
 * jsdom 29 与 React 19 的合成事件模拟不兼容（手动 dispatch input 事件不触发 onChange）。
 * 改为直接调用元素上 React 安装的 props 处理器，仍经过真实组件 state 更新逻辑。
 */
const reactPropsKey = (el: Element): string | undefined =>
  Object.keys(el).find((k) => k.startsWith('__reactProps$'));

function setControlValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const key = reactPropsKey(el);
  const props = key ? ((el as unknown as Record<string, { onChange?: (e: unknown) => void }>)[key]) : undefined;
  props?.onChange?.({ target: { value }, currentTarget: { value } });
}

function clickReact(el: HTMLElement) {
  const key = reactPropsKey(el);
  const props = key ? ((el as unknown as Record<string, { onClick?: (e: unknown) => void }>)[key]) : undefined;
  if (props?.onClick) props.onClick({});
  else (el as HTMLButtonElement).click();
}

// ---- 0. 预置 v1 旧数据 ----
const legacy = [
  { id: 1, name: 'react', version: '18.3.1', license: 'MIT', source: 'npm', status: 'ok', note: '宽松许可，可商用' },
  { id: 5, name: 'legacy-parser', version: '2.1.0', license: 'GPL-3.0', source: '手动', status: 'risk', note: '可能与闭源分发冲突' },
];
dom.window.localStorage.setItem('license-lens', JSON.stringify(legacy));

async function main(){
const container = document.getElementById('root')!;
const root = createRoot(container);
await act(async () => {
  root.render(<App />);
});
await flush();

ok(text().includes('许可证可恢复审查链'), '应用渲染');
ok(/旧版数据已升级/.test(text()), '迁移提示横幅出现');
ok(text().includes('2 项待重新确认'), `旧裁决进入待确认（实际文本片段检查）: ${text().includes('待重新确认')}`);
ok(!dom.window.localStorage.getItem('license-lens'), 'v1 键已清理');
ok(!!dom.window.localStorage.getItem('license-lens-v2'), 'v2 数据已落盘');

// ---- 1. 导入样例锁文件 v1 ----
const buttons = $$('button').map((b) => b.textContent ?? '');
ok(buttons.some((t) => t.includes('样例 v1')), '样例 v1 按钮存在');
await act(async () => {
  clickReact($$('button').find((b) => (b.textContent ?? '').includes('样例 v1'))!);
});
await flush();
ok(text().includes('扫描完成'), '扫描完成提示');
ok(text().includes('legacy-parser'), '组件入列');
ok(/批次回执/.test(text()), '存在批次区域入口');

// ---- 2. 乙为 legacy-parser 补商业授权 ----
// 切换到审计员乙
await act(async () => {
  clickReact($$('.switcher button').find((b) => (b.textContent ?? '').includes('乙'))!);
});
const lpCandidates = $$('.tr:not(.th)').filter((r) => (r.textContent ?? '').includes('legacy-parser'));
const lpRow = lpCandidates[lpCandidates.length - 1]!;
await act(async () => {
  clickReact(lpRow);
});
await flush();
ok(($('.detail-title .mono')?.textContent ?? '').startsWith('f1:'), '详情打开并显示组件指纹');
const inputs = $$('.add-evidence input');
void inputs;
const inputsNow = () => $$('.add-evidence input');
const titleEl = () => inputsNow().find((i) => (i.getAttribute('placeholder') ?? '').includes('材料标题')) as HTMLInputElement;
const contactEl = () => inputsNow().find((i) => (i.getAttribute('placeholder') ?? '').includes('授权方')) as HTMLInputElement;
const detailEl = () => $('.add-evidence textarea') as HTMLTextAreaElement;
await act(async () => {
  const curInputs = $$('.add-evidence input');
  const curTitle = curInputs.find((i) => (i.getAttribute('placeholder') ?? '').includes('材料标题')) as HTMLInputElement;
  const curContact = curInputs.find((i) => (i.getAttribute('placeholder') ?? '').includes('授权方')) as HTMLInputElement;
  const curDetail = $('.add-evidence textarea') as HTMLTextAreaElement;
  setControlValue(curTitle, 'Vendor 商业授权 PO-2026-041');
  setControlValue(curDetail, '永久商业分发授权');
  setControlValue(curContact, 'vendor@x.com');
});
await act(async () => {
  clickReact($$('.add-evidence button').find((b) => (b.textContent ?? '').includes('保存材料'))!);
});
await flush();
ok(text().includes('许可材料已保存'), '材料保存提示');
ok(text().includes('商业授权'), '详情显示商业授权覆盖');
// 列表中 npm legacy-parser 行出现覆盖徽标（同名取最后一个匹配行）
const lpRowsAfter = $$('.tr:not(.th)').filter((r) => (r.textContent ?? '').includes('legacy-parser'));
const lpRowAfter = lpRowsAfter[lpRowsAfter.length - 1]!;
ok((lpRowAfter.textContent ?? '').includes('商业授权'), '列表行显示覆盖材料');
ok((lpRowAfter.textContent ?? '').includes('当前建议：通过') === false, '');
ok(text().includes('商业授权覆盖'), '建议理由引用商业授权');
ok(/当前建议：通过/.test(text()), '授权优先 → 当前建议通过（覆盖 GPL 基线拒绝）');

// ---- 3. 发布新基线 v2：把 MIT 改为复核 ----
await act(async () => {
  clickReact($$('aside .nav').find((b) => (b.textContent ?? '').includes('策略基线'))!);
});
await flush();
const mitRow = $$('.baseline-row').find((r) => (r.textContent ?? '').includes('MIT'))!;
await act(async () => {
  clickReact(([...mitRow.querySelectorAll('.seg-btn')] as HTMLElement[]).find((b) => (b.textContent ?? '').includes('复核'))!);
});
const noteInput = $('.baseline-note') as HTMLInputElement;
await act(async () => {
  setControlValue(noteInput, '收购尽调临时收紧');
});
await act(async () => {
  clickReact($$('button').find((b) => (b.textContent ?? '').includes('发布基线 v2'))!);
});
await flush();
ok(text().includes('策略基线 v2 已发布'), '基线发布提示');
ok(text().includes('v2'), '界面显示基线 v2');
// 回到总览，react 裁决应 stale-baseline
await act(async () => {
  clickReact($$('aside .nav').find((b) => (b.textContent ?? '').includes('审查链总览'))!);
});
await flush();
ok(text().includes('基线已更新·待重新确认'), '基线更新后旧裁决待确认');

// ---- 4. 导入 v2 锁文件：react 18→19 指纹变化、新包 sspldb ----
await act(async () => {
  clickReact($$('button').find((b) => (b.textContent ?? '').includes('样例 v2'))!);
});
await flush();
const reactRow = $$('.tr').find((r) => (r.textContent ?? '').includes('react'))!;
ok((reactRow.textContent ?? '').includes('19.0.0'), 'react 升级 19.0.0');
ok((reactRow.textContent ?? '').includes('指纹已变·待重新确认'), '指纹变化 → 旧裁决失效');
const sspRow = $$('.tr').find((r) => (r.textContent ?? '').includes('sspldb'))!;
ok(!!sspRow, '新包 sspldb 入列');
ok((sspRow.textContent ?? '').includes('尚未裁决'), '新包无裁决');

// ---- 5. 模拟乙在另一标签后到保存：进入争议清单，先到材料保留 ----
const engine = getEngine();
const draftB: EvidenceDraft = {
  componentId: 'npm:legacy-parser',
  kind: 'exemption',
  title: '乙的法务豁免（后到）',
  detail: '乙标签并发保存',
};
const resConflict = engine.saveEvidence([draftB], { id: 'auditor-yi', name: '审计员乙', initials: '乙' }, { forceLateArrival: true });
ok(resConflict.conflict, '后到保存判定冲突');
await flush();
ok(text().includes('争议清单'), '争议清单区域');
ok(text().includes('乙的法务豁免（后到）'), '后到材料原样保留');
ok(text().includes('先到者材料保留'), '先到材料保留说明');
// 合并
await act(async () => {
  clickReact($$('.dispute-actions button').find((b) => (b.textContent ?? '').includes('合并后到材料'))!);
});
await flush();
ok(text().includes('后到者材料已合并入链'), '合并成功提示');
// 开放争议块已消失（材料并入证据链；已处理历史不再展示材料明细）
ok($('.dispute-item.open') === null, '开放争议块消失，后到材料已并入证据链');

// ---- 6. 落盘失败 → 半截 → 恢复中心继续 ----
engine.injectDiskFailures(1);
await act(async () => {
  // 重新扫描 v2（6 个依赖），登记回执即落盘失败
  clickReact($$('button').find((b) => (b.textContent ?? '').includes('样例 v2'))!);
});
await flush();
ok(/落盘失败|扫描中断/.test(text()), '落盘失败横幅');
// 进入恢复中心
await act(async () => {
  clickReact($$('aside .nav').find((b) => (b.textContent ?? '').includes('批次与恢复'))!);
});
await flush();
ok(text().includes('从完整批次继续'), '恢复中心可继续未完成批次');
await act(async () => {
  clickReact($$('button').find((b) => (b.textContent ?? '').includes('全部继续'))!);
});
await flush();
ok(text().includes('全部未完成批次已恢复提交'), '全部继续成功');
// 未完成批次按钮应消失
ok(!(text().match(/全部继续/g)?.length > 0 && text().includes('落盘失败')), '失败状态清除');

// ---- 7. 模拟页面重载：新引擎从同一 localStorage 恢复，数据完整 ----
const engine2 = new LensEngine(new LocalStoragePersistence(dom.window.localStorage));
const boot = engine2.bootstrap();
// 7 个组件 = 迁移来的 manual:legacy-parser + v2 锁文件的 6 个 npm 依赖（不同生态，不合并）
ok(Object.keys(engine2.state.components).length === 7, `重载后 7 个组件齐全，实际 ${Object.keys(engine2.state.components).length}`);
ok(boot.resumed === 0, '无未决批次需要恢复');
ok(engine2.state.baseline.version === 2, '基线版本持久化 v2');
ok(engine2.state.components['npm:react'].version === '19.0.0', 'react 19 持久化');
const ev = Object.values(engine2.state.evidence).filter((e) => e.componentId === 'npm:legacy-parser');
ok(ev.length >= 2, `legacy-parser 两份材料（授权+合并的豁免），实际 ${ev.length}`);
ok(!!engine2.state.disputes && Object.values(engine2.state.disputes).some((d) => d.status === 'merged'), '争议合并结果持久化');

// ---- 8. 扫描中断（半截依赖）后重载，bootstrap 恢复并继续 ----
// 用全新存储模拟
dom.window.localStorage.removeItem('license-lens-v2');
const engine3 = new LensEngine(new LocalStoragePersistence(dom.window.localStorage));
engine3.bootstrap();
engine3.startScan(parseLockfile(SAMPLE_LOCK_V2), { id: 'auditor-jia', name: '审计员甲', initials: '甲' }, { interruptAfter: 2 });
ok(Object.keys(engine3.state.components).length === 2, '磁盘半截：2 个组件');
const engine4 = new LensEngine(new LocalStoragePersistence(dom.window.localStorage));
const b4 = engine4.bootstrap();
ok(b4.resumed === 1, '重载恢复 1 个中断批次');
const rr = engine4.retryAll();
ok(rr[0].stillPending === 0, '中断批次续跑完成');
ok(Object.keys(engine4.state.components).length === 6, '续跑后 6 个组件齐全');

console.log(`\n${failed === 0 ? '✅' : '❌'} UI E2E: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\n页面文本尾部:\n', text().slice(-600));
  process.exit(1);
}
  root.unmount();
  // jsdom/React 可能保留定时器句柄，测试结束后显式退出
  process.exit(0);
}

main().catch((e)=>{console.error(e);process.exit(1);});
