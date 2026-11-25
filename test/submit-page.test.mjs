import test from 'node:test';
import { tmpdir } from './tmp.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const { Library, M } = require('../editor-plugin/library.cjs');
const { PAGE_TIMING } = require('../editor-plugin/features/delivery.cjs');
const { BRIDGE_SCOPE, SOURCE_URL } = require('../editor-plugin/features/webpages.cjs');
const { PROJECT_PACKAGE_LIMIT_BYTES } = require('../editor-plugin/features/submission-project.cjs');

Object.assign(PAGE_TIMING, { readyMs: 3000, quietMs: 100, pollMs: 20, settleMs: 30, stepMs: 500, checksMs: 1500, closeMs: 300, resultMs: 1500, verifyMs: 250, verifyPollMs: 10 });

class Bus {
  constructor() {
    this.handlers = new Map();
  }
  on(e, f) {
    this.handlers.set(e, [...(this.handlers.get(e) || []), f]);
  }
  off(e, f) {
    this.handlers.set(e, (this.handlers.get(e) || []).filter((x) => x !== f));
  }
  emit(e, ...args) {
    for (const f of this.handlers.get(e) || []) f(...args);
  }
}

// The live submit page of 2026-11-07, reduced to the classes and labels the plugin reads, with just
// enough behaviour: tasks are picked on mouseup only, the name keeps 10 characters, emoji are refused,
// icons without an upload block the first step, and the aiName config request wipes the name field.
// Past the 提交审核 step it follows the offline page of the 9.8.3 install: an account that has not agreed
// gets a checkbox, 提交审核 is disabled and loading while it submits, and the outcome goes to the editor
// as a DYEHSubmitBridge sendUploadResultEvent query, then the 提交成功 view or a toast.
function fakePage(options = {}) {
  const o = {
    settingsStep: true,
    iconsUploaded: true,
    collected: ['国风古风花钿妆', '甜妹繁花花环'],
    searchable: ['冬日国风边框'],
    tasks: ['征集最新自拍玩法', '创新滤镜开放赛'],
    tracked: { 'AI 赛道征集': ['图片赛道', '视频赛道'] },
    inspirationTask: {},
    configAt: 0,
    configUrl: 'https://effect.douyin.com/platform/v1/t_conf?key=aiName&app=2',
    trickle: false,
    nextLabel: '下一步',
    agreed: true,
    checksPass: true,
    checksMs: 100,
    // report: what pressing 提交审核 ends in: 'ok', 'fail' (a failReason), 'stop' (stops without a
    // report), or 'silent' (keeps loading).
    report: 'ok',
    realName: false,
    answer: true,
    extraBasic: '',
    extraSettings: '',
    // Measured 2026-11-19 on Douyin AR 9.8.3 DYEHEffectSubmissionWindow: 'none' | 'available' | 'checked' | 'disabled' | 'stuck'
    pickNomination: 'none',
    pickRemaining: 1,
    // Live submit-orion.9ab197f1.js (2026-11-23): checked nomination requires >=1 type.
    pickTypes: [],
    pickTypeOptions: ['设计精美', '玩法创新', '技术创新'],
    pickTypesStuck: false,
    pickHighlight: '',
    pickHighlightStuck: false,
    pickHighlightMissing: false,
    pickConfigAt: 0,
    ...options,
  };
  const steps = o.settingsStep ? ['特效基础信息', '特效发布设置', '提交审核'] : ['特效基础信息', '提交审核'];
  const title = (t) => `<div class="section-title"><div class="title-main">${t}<span class="dot-red">*</span></div></div>`;
  const input = (cls, t, placeholder) => `<div class="${cls}">${title(t)}<div class="input-wrapper"><input placeholder="${placeholder}" value=""><div class="item-counter">0/10</div><div class="text-err"></div></div></div>`;
  const selector = (id, t, text, search) =>
    `<div class="bind-wrapper" id="${id}">${title(t)}<div class="selector-container" tabindex="-1"><div class="selector-input"><div class="text">${text}</div></div><div class="selector-list hidden"><div class="dropdown-container">${search ? '<div class="search-container"><input class="search-input" type="text" value=""></div>' : ''}<div class="favor-list"></div></div></div></div></div>`;
  const pickHtml =
    o.pickNomination === 'none'
      ? ''
      : `<div class="innovation-wrapper"><div class="innovation-header"><div class="innovation-title">精选提报</div><div class="innovation-check"><div class="innovation-check-box-wrapper"><div class="custom-checkbox${o.pickNomination === 'checked' ? ' checked' : ''}${o.pickNomination === 'disabled' ? ' disabled' : ''}"></div></div></div></div><div class="innovation-category" style="display: none;"></div><div class="nomination-error text-err"></div><div class="innovation-main"><span class="innovation-content">每日有${o.pickRemaining}次提报精选的机会，被评为精选可获得 </span><span class="innovation-highlight">50元现金、15%加权激励 </span><span class="innovation-content">等。</span><span class="innovation-detail">查看审核标准</span></div></div>`;
  const html = `<!doctype html><html><body><div id="root"><div class="submit-wrap">
<header class="nav-wrap">${steps.map((s, i) => `<div class="nav-item${i === 0 ? ' active' : ''}"><div class="nav-item-text">${s}</div></div>`).join('')}</header>
<main><div class="content show"><div class="content-left">
<div style="display: block;" data-step="0">
<div class="upload-icon-wrapper">${title('特效图标')}<div class="icon-wrapper"><div class="icon-content"><div class="icon-bottom female"><div class="finish"><img class="icon"></div></div></div><div class="icon-content"><div class="icon-bottom male"><div class="finish"><img class="icon"></div></div></div><div class="text-err"></div></div></div>
<div class="default-camera-wrapper">${title('默认摄像头方向')}<div class="radio-wrapper"><label class="semi-radio semi-radio-checked"><span>前置</span></label><label class="semi-radio"><span>后置</span></label></div></div>
${input('name-wrapper', '特效名称', '示例：纯色海报')}${input('trigger-wrapper', '特效触发提示', '非必填项')}${o.extraBasic}
</div>
${o.settingsStep ? `<div style="display: none;" data-step="1">${selector('insp', '灵感绑定', '选择收藏的灵感或热点', true)}${selector('task', '任务绑定', '选择任务', false)}${pickHtml}${o.extraSettings}</div>` : ''}
</div></div>
<div class="publish-wrap" style="display: none;"><div class="submit-title"><h1>特效审核中</h1></div><div class="effect-content"></div><div class="effect-test-container"></div></div>
</main>
<footer><div class="btn-wrapper"><div class="button"><div class="btn-content">取消</div></div><div class="button next"><div class="btn-content">${o.nextLabel}</div></div></div></footer>
</div></div></body></html>`;
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  const d = window.document;
  const $ = (s, root = d) => root.querySelector(s);
  const $$ = (s, root = d) => [...root.querySelectorAll(s)];
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;

  const requests = [];
  window.performance.getEntriesByType = (type) => (type === 'resource' ? requests.slice() : []);
  let trickle = o.trickle ? window.setInterval(() => requests.push({ name: 'https://log' }), 15) : null;
  const name = $('.name-wrapper input');
  const pickBox = $('.innovation-wrapper .custom-checkbox');
  const selectedTypes = new Set(o.pickTypes);
  let highlight = o.pickHighlight;
  if (pickBox) {
    if (o.pickConfigAt) {
      $('.innovation-wrapper').style.display = 'none';
      window.setTimeout(() => { $('.innovation-wrapper').style.display = ''; }, o.pickConfigAt);
    }
    const category = $('.innovation-category');
    const renderTypes = () => {
      category.style.display = pickBox.classList.contains('checked') ? 'block' : 'none';
      // Replace nodes like a rerender; listeners update the page state, independent of the bridge.
      category.innerHTML = `<div class="innovation-category-content">提报类型（可多选）：${o.pickTypeOptions.map((t) => `<div class="innovation-category-content-check-box${selectedTypes.has(t) ? ' category-check-active' : ''}">${t}</div>`).join('')}</div>${o.pickHighlightMissing ? '' : '<div class="input-container"><div class="input-div"><textarea placeholder="填写亮点可增加被评为【官方精选】的概率"></textarea></div><div class="item-counter">0/50</div></div>'}`;
      const input = $('textarea', category);
      if (input) {
        input.value = highlight;
        input.addEventListener('input', () => {
          // The live page truncates at counter 50; these limit fixtures use Chinese text only.
          if (!o.pickHighlightStuck) highlight = input.value.slice(0, 50);
          input.value = highlight;
        });
      }
      for (const box of $$('.innovation-category-content-check-box', category)) {
        box.addEventListener('click', () => {
          if (o.pickTypesStuck) return;
          const label = box.textContent;
          if (selectedTypes.has(label)) selectedTypes.delete(label);
          else selectedTypes.add(label);
          renderTypes();
        });
      }
    };
    renderTypes();
    pickBox.addEventListener('click', () => {
      if (o.pickNomination === 'disabled' || o.pickNomination === 'stuck') return;
      pickBox.classList.toggle('checked');
      renderTypes();
    });
  }
  window.setTimeout(() => {
    requests.push({ name: o.configUrl });
    window.clearInterval(trickle);
    // The real page remounts the name field here, dropping what was typed.
    setValue.call(name, '');
  }, o.configAt);

  for (const wrapper of $$('.name-wrapper, .trigger-wrapper')) {
    const el = $('input', wrapper);
    el.addEventListener('input', () => {
      const chars = [...el.value];
      if (chars.length > 10) setValue.call(el, chars.slice(0, 10).join(''));
      $('.text-err', wrapper).textContent = /\p{Extended_Pictographic}/u.test(el.value) ? '请勿输入表情与特殊符号' : '';
    });
  }
  for (const label of $$('.default-camera-wrapper label')) {
    label.addEventListener('click', () => $$('.default-camera-wrapper label').forEach((l) => l.classList.toggle('semi-radio-checked', l === label)));
  }

  let step = 0;
  let inspiration = null;
  const show = (i) => {
    step = i;
    $$('header .nav-item').forEach((n, k) => n.classList.toggle('active', k === i));
    $$('[data-step]').forEach((s) => (s.style.display = Number(s.dataset.step) === i ? 'block' : 'none'));
    if (steps[i] !== '提交审核') return;
    const hint = $('.trigger-wrapper input').value;
    $('.publish-wrap').style.display = 'block';
    $('.effect-content').innerHTML = `<div class="effect-content-item">特效名称：${name.value}</div><div class="effect-content-item">特效触发提示：${hint || '无'}</div>`;
    $('.effect-test-container').innerHTML = '<div class="effect-test-item-top-text">包体积检测通过</div><div class="effect-test-item-top-text">性能检测中...</div>';
    const next = $('footer .button.next');
    next.className = 'button next disable';
    $('.btn-content', next).textContent = '提交审核';
    $('footer').insertAdjacentHTML(
      'beforeend',
      `<div class="ip-agreement">${o.agreed ? '<span class="agreed">已阅读并同意</span>' : '<input type="checkbox"><span class="not-agreed">提交前请阅读并同意</span>'}</div>`,
    );
    let checksDone = false;
    const box = $('.ip-agreement input');
    const enable = () => next.classList.toggle('disable', !(checksDone && o.checksPass && (o.agreed || box.checked)));
    if (box) box.addEventListener('change', enable);
    window.setTimeout(() => {
      $$('.effect-test-item-top-text')[1].textContent = o.checksPass ? '性能检测通过' : '性能检测未通过';
      $('.submit-title h1').textContent = o.checksPass ? '检测通过' : '检测未通过';
      checksDone = true;
      enable();
    }, o.checksMs);
  };
  const stats = { presses: 0 };
  const submit = () => {
    const next = $('footer .button.next');
    if (next.classList.contains('disable')) return;
    stats.presses += 1;
    next.classList.add('disable', 'loading');
    const report = (v) =>
      window.orionQuery({ request: `orionJSB://DYEHSubmitBridge/sendUploadResultEvent?${encodeURIComponent(JSON.stringify(v))}`, onSuccess() {}, onFailure() {} });
    window.setTimeout(() => {
      if (o.report === 'silent') return;
      if (o.report === 'ok') {
        report({ effectId: '7001' });
        $$('header .nav-item').forEach((n) => n.classList.remove('active'));
        $('main').innerHTML = '<div class="upload-preview"><header><h2>恭喜你,提交成功!</h2></header></div>';
        $('footer').innerHTML = `<div class="btn-wrapper">${o.realName ? '<span class="button">实名认证</span>' : ''}<span class="button next">查看我的特效</span></div>`;
        return;
      }
      if (o.report === 'fail') report({ failReason: '服务繁忙' });
      if (o.report === 'project_oversize') {
        d.body.insertAdjacentHTML('beforeend', '<div role="alert">工程文件超出200M，无法完成打包，请检查工程中的过大资源</div>');
        next.classList.remove('disable', 'loading');
        return;
      }
      d.body.insertAdjacentHTML('beforeend', '<div class="semi-toast-wrapper"><span class="semi-toast-content-text">网络异常，请检查网络后重试</span></div>');
      next.classList.remove('disable', 'loading');
    }, 50);
  };
  $('footer .button.next').addEventListener('click', () => {
    if (steps[step] === '提交审核') return submit();
    if (steps[step] === '特效基础信息') {
      if (!o.iconsUploaded) return void ($('.upload-icon-wrapper .text-err').textContent = '请至少上传一个图标');
      if (!name.value) return void ($('.name-wrapper .text-err').textContent = '请输入特效名称');
    }
    if (steps[step] === '特效发布设置' && pickBox?.classList.contains('checked') && !selectedTypes.size) {
      $('.nomination-error').textContent = '请选择提报类型';
      return;
    }
    if (step < steps.length - 1) show(step + 1);
  });

  const insp = $('#insp');
  const task = $('#task');
  if (insp) {
    const list = $('.favor-list', insp);
    const render = (names, note = '') =>
      (list.innerHTML = !names.length && !note ? '<div class="empty-list">暂无收藏的灵感或热点，快到像塑移动版看看吧</div>' : note + (o.collected.length || o.searchable.length ? ['暂不绑定', ...names] : []).map((n) => `<div class="favor-option"><div class="option-name">${n}</div></div>`).join(''));
    render(o.collected);
    $('.selector-input', insp).addEventListener('mousedown', () => $('.selector-list', insp).classList.toggle('hidden'));
    list.addEventListener('click', (e) => {
      const opt = e.target.closest('.favor-option');
      if (!opt) return;
      inspiration = opt.textContent.trim();
      $('.selector-input .text', insp).textContent = inspiration;
      $('.selector-list', insp).classList.add('hidden');
    });
    const search = $('.search-input', insp);
    if (!o.collected.length && !o.searchable.length) search.remove();
    search.addEventListener('input', () => {
      render([], '<div class="empty-list">搜索中...</div>');
      window.setTimeout(() => {
        const found = [...o.collected, ...o.searchable].filter((n) => n.includes(search.value));
        if (found.length) render(found);
        else render(o.collected, '<div class="empty-list">暂无搜索结果</div>');
      }, 60);
    });
  }
  if (task) {
    const list = $('.favor-list', task);
    list.innerHTML =
      ['暂不参与', ...o.tasks].map((t) => `<div class="favor-option"><div class="option-name">${t}</div></div>`).join('') +
      Object.keys(o.tracked)
        .map((t) => `<div class="selector-list-track"><div class="selector-list-track-item"><div class="selector-list-track-item-title">${t}<div class="arrow down"></div></div><div class="selector-list-track-item-list"></div></div></div>`)
        .join('');
    $('.selector-input', task).addEventListener('mousedown', () => $('.selector-list', task).classList.toggle('hidden'));
    const pick = (shown, picked) => {
      $('.selector-input .text', task).textContent = shown;
      if (inspiration && o.inspirationTask[inspiration] && o.inspirationTask[inspiration] !== picked) {
        inspiration = null;
        $('.selector-input .text', insp).textContent = '选择收藏的灵感或热点';
      }
    };
    list.addEventListener('mouseup', (e) => {
      const opt = e.target.closest('.favor-option');
      const info = e.target.closest('.selector-list-track-item-info');
      if (opt) pick(opt.textContent.trim(), opt.textContent.trim());
      if (info) {
        const t = info.closest('.selector-list-track-item').querySelector('.selector-list-track-item-title').textContent.trim();
        pick(`${t}/${info.textContent.trim()}`, t);
      }
    });
    list.addEventListener('click', (e) => {
      const head = e.target.closest('.selector-list-track-item-title');
      if (!head) return;
      const item = head.closest('.selector-list-track-item');
      $('.selector-list-track-item-list', item).innerHTML = o.tracked[head.textContent.trim()]
        .map((tr) => `<div class="selector-list-track-item-info"><div class="selector-list-track-item-info-title">${tr}</div></div>`)
        .join('');
    });
  }
  return { window, o, stats };
}

// How many tool calls that keep windows off screen (quiet.cjs) are running in this process.
const quietDepth = () => globalThis[Symbol.for('xiangsu-mcp-plus.quiet')]?.toolDepth ?? 0;

// A fake editor whose SubmitEffect opens a new window showing `page` (added to App._windows, as the
// editor's windows are), bridged the way the real webview and JS bridge are: scripts go in through
// evaluateJavascript, answers come back as orionJSB:// queries. `effects(n)` answers the n-th (from 0)
// my_effects lookup with the account's newest effects.
function editor(page, { windowName = 'DYEHEffectSubmissionWindow', left = [], closes = true, effects = () => [], projectZipBytes = 1000, exportError, zipError, loseConfirmReply = false, closeAfterPress = false } = {}) {
  const depths = [];
  const business = new Bus();
  const legacy = new Bus();
  globalThis.App = { _windows: [{ constructor: { name: 'MainWindow' }, isClosed: false }, ...left] };
  const sources = [];
  const handlers = new Map();
  // Queries the page sends to the editor's own bridges, as `scope/method` and params.
  const native = [];
  let closedEvaluations = 0;
  const projectZip = path.join(tmpdir('xs-native-project-'), 'project.zip');
  fs.closeSync(fs.openSync(projectZip, 'w'));
  fs.truncateSync(projectZip, projectZipBytes);
  const Win = {
    [windowName]: class {
      constructor() {
        this.isClosed = false;
        this.exportPromise = exportError ? Promise.reject(Error(exportError)) : Promise.resolve();
        this.zipProjectPromise = zipError ? Promise.reject(Error(zipError)) : Promise.resolve(projectZip);
        this.exportPromise.catch(() => {});
        this.zipProjectPromise.catch(() => {});
      }
      closeWindow() {
        if (closes) setTimeout(() => (this.isClosed = true), 5);
      }
    },
  }[windowName];
  business.on('SubmitEffect', () => {
    depths.push(quietDepth());
    const win = new Win();
    globalThis.App._windows.push(win);
    win.JSB = { joinRegisterHandler: (scope, h) => handlers.set(scope, { ...handlers.get(scope), ...h }) };
    win.webview = {
      evaluateJavascript: (code, source) => {
        if (win.isClosed) closedEvaluations++;
        sources.push(source);
        assert.equal(typeof source, 'string', 'a non-string second argument crashes the editor');
        page.window.eval(code);
      },
    };
    page.window.orionQuery = ({ request }) => {
      const m = /^orionJSB:\/\/([^/]+)\/([^?]+)\?(.*)$/.exec(request);
      const params = JSON.parse(decodeURIComponent(m[3]));
      if (m[1] !== BRIDGE_SCOPE) native.push([`${m[1]}/${m[2]}`, params]);
      else if (page.o.answer) {
        if (params.value && Object.prototype.hasOwnProperty.call(params.value, 'ticked')) {
          if (closeAfterPress) win.isClosed = true;
          if (loseConfirmReply) Object.assign(params, { ok: false, error: 'PAGE_NO_ANSWER: confirm reply was lost' });
        }
        handlers.get(m[1])[m[2]](params);
      }
    };
    legacy.emit('OnSubmitWindowOpened', 1, 0);
  });
  const modules = {
    [M.events]: { BusinessEventManager: { TypeGuard: () => business } },
    [M.ef]: { EventManager_deprecated: { TypeGuard: () => legacy } },
  };
  const lib = new Library((n) => {
    if (!(n in modules)) throw Error(`MODULE_NOT_FOUND: ${n}`);
    return modules[n];
  });
  lib.submitChecks = async () => ({ ok: true, issues: [] });
  const lookups = [];
  lib.myEffects = async (args) => ({ items: effects(lookups.push(args) - 1) });
  const open = () => globalThis.App._windows.filter((w) => w.constructor.name === windowName && !w.isClosed);
  return { lib, sources, handlers, open, depths, native, lookups, projectZip, closedEvaluations: () => closedEvaluations };
}

const fill = { name: '测试特效名', trigger_hint: '张嘴试试', camera: 'back', inspiration: '国风古风花钿妆', task: '征集最新自拍玩法' };

test('submit_prepare fills every step, reads it back and stops on 提交审核 once the checks are done', async () => {
  const page = fakePage({ trickle: true, configAt: 120 });
  const { lib, sources, handlers, open, depths } = editor(page);
  const out = await lib.submitPrepare(fill);
  assert.equal(out.opened, true);
  assert.deepEqual(depths, [1], 'the submit window opened with windows kept off screen');
  assert.equal(quietDepth(), 0);
  assert.equal(out.step, '提交审核');
  assert.deepEqual(out.filled, { icons: { female: true, male: true }, name: '测试特效名', trigger_hint: '张嘴试试', camera: '后置' });
  assert.deepEqual(out.bindings, { inspiration: '国风古风花钿妆', task: '征集最新自拍玩法' });
  assert.deepEqual(out.other_sections, []);
  assert.equal(out.review.name, '测试特效名', 'typed after the name config arrived, so it survived');
  assert.deepEqual(out.review.checks, ['包体积检测通过', '性能检测通过'], 'waited for the checks');
  assert.equal(out.review.submit_enabled, true);
  assert.equal(out.review.agreed, true);
  assert.match(out.next, /press 提交审核/);
  assert.ok(sources.length > 0 && sources.every((s) => s === SOURCE_URL));
  assert.ok(handlers.has(BRIDGE_SCOPE));
  assert.equal(out.closed_previous, 0);
  assert.equal(open().length, 1, 'the filled window stays open');
  assert.ok(!page.window.document.querySelector('footer .button.next').classList.contains('disable'), 'left for the user to press');
});

test('submit_prepare keeps fields it is not given as the page shows them', async () => {
  const { lib } = editor(fakePage());
  const out = await lib.submitPrepare({ name: '只填名字' });
  assert.deepEqual(out.filled, { icons: { female: true, male: true }, name: '只填名字', trigger_hint: '', camera: '前置' });
  assert.deepEqual(out.bindings, { inspiration: '选择收藏的灵感或热点', task: '选择任务' });
  assert.equal(out.review.trigger_hint, '无');
});

test('submit_prepare accepts already-unbound inspiration when the collection is empty', async () => {
  const page = fakePage({ collected: [], searchable: [] });
  const { lib } = editor(page);
  const out = await lib.submitPrepare({ name: '空灵感提交', inspiration: '暂不绑定' });
  assert.deepEqual({ inspiration: out.bindings.inspiration, step: out.step, pressed: page.stats.presses }, { inspiration: '暂不绑定', step: '提交审核', pressed: 0 });
});

test('submit_prepare blocks an oversized native project ZIP even when the runtime checks passed', async () => {
  const page = fakePage();
  const { lib, open } = editor(page, { projectZipBytes: PROJECT_PACKAGE_LIMIT_BYTES + 1 });
  const out = await lib.submitPrepare(fill);
  assert.deepEqual({ opened: out.opened, ok: out.check.ok, bytes: out.check.project_package_bytes, issue: out.check.issues[0].split(':')[0], name: page.window.document.querySelector('.name-wrapper input').value, pressed: page.stats.presses, windows: open().length }, {
    opened: false, ok: false, bytes: 209715201, issue: 'PROJECT_PACKAGE_TOO_LARGE', name: '', pressed: 0, windows: 0,
  });
});

test('submit_prepare checks the ZIP rather than refusing a large compressible source directory', async () => {
  const { lib } = editor(fakePage());
  lib.submitChecks = async () => ({ ok: true, issues: [], project_directory_bytes: 400000000 });
  const out = await lib.submitPrepare(fill);
  assert.deepEqual([out.opened, out.check.project_directory_bytes, out.check.project_package_bytes], [true, 400000000, 1000]);
});

test('submit_prepare permits exactly the native project ZIP limit', async () => {
  const { lib } = editor(fakePage(), { projectZipBytes: PROJECT_PACKAGE_LIMIT_BYTES });
  const out = await lib.submitPrepare(fill);
  assert.deepEqual([out.opened, out.check.ok, out.check.project_package_bytes], [true, true, 209715200]);
});

test('submit_prepare reports native project export and ZIP failures before filling or publishing', async () => {
  for (const options of [{ exportError: 'native resource export failed' }, { zipError: 'native ZIP creation failed' }]) {
    const page = fakePage();
    const { lib, open } = editor(page, options);
    const error = await lib.submitPrepare(fill).then(() => null, (e) => e.message);
    assert.deepEqual({ error, name: page.window.document.querySelector('.name-wrapper input').value, pressed: page.stats.presses, windows: open().length }, {
      error: `PROJECT_EXPORT_FAILED: ${options.exportError || options.zipError} (the submit window was closed; nothing was submitted)`, name: '', pressed: 0, windows: 0,
    });
  }
});

test('submit_prepare closes an old submission before inspecting and exporting the project', async () => {
  const old = { constructor: { name: 'DYEHEffectSubmissionWindow' }, isClosed: false, closeWindow() { this.isClosed = true; } };
  const { lib } = editor(fakePage(), { left: [old] });
  let inspectedAfterClose = false;
  lib.submitChecks = async () => { inspectedAfterClose = old.isClosed; return { ok: true, issues: [] }; };
  const out = await lib.submitPrepare(fill);
  assert.deepEqual([inspectedAfterClose, out.closed_previous, out.opened], [true, 1, true]);
});

test('the summary check catches a name the page wiped after it was typed', async () => {
  // No aiName request to wait for, and the page goes quiet before the remount.
  const { lib } = editor(fakePage({ configUrl: 'https://effect.douyin.com/other', configAt: 400 }));
  await assert.rejects(lib.submitPrepare(fill), /SUBMIT_REVIEW_MISMATCH: the summary shows 名称「」.*left open/);
});

test('submit_prepare fails on a name or hint the page cuts or refuses', async () => {
  await assert.rejects(editor(fakePage()).lib.submitPrepare({ name: '这个特效名称明显超过十个字' }), /SUBMIT_NAME_REJECTED: the page kept 「这个特效名称明显超过」/);
  await assert.rejects(editor(fakePage()).lib.submitPrepare({ name: '表情😀名' }), /SUBMIT_FIELD_REJECTED; the page says: 请勿输入表情与特殊符号/);
  await assert.rejects(editor(fakePage()).lib.submitPrepare({ name: '好名字', trigger_hint: '这句触发提示远远超过了十个字' }), /SUBMIT_TRIGGER_HINT_REJECTED/);
});

test('submit_prepare reports a step the page will not leave, with the page text', async () => {
  await assert.rejects(
    editor(fakePage({ iconsUploaded: false })).lib.submitPrepare(fill),
    /SUBMIT_STEP_BLOCKED: 「特效基础信息」 did not move on; the page says: 请至少上传一个图标; set the icon with icon_set/,
  );
});

test('submit_prepare finds an inspiration outside the loaded list through the search box', async () => {
  const { lib } = editor(fakePage());
  const out = await lib.submitPrepare({ ...fill, inspiration: '冬日国风边框' });
  assert.equal(out.bindings.inspiration, '冬日国风边框');
  await assert.rejects(
    editor(fakePage()).lib.submitPrepare({ ...fill, inspiration: '不存在的灵感' }),
    /SUBMIT_OPTION_NOT_FOUND: 灵感绑定 has no 「不存在的灵感」.*searching it gave 暂无搜索结果; it lists: 暂不绑定 \| 国风古风花钿妆 \| 甜妹繁花花环/,
  );
});

test('submit_prepare picks a task on mouseup, and a track when the task has tracks', async () => {
  const out = await editor(fakePage()).lib.submitPrepare({ ...fill, task: 'AI 赛道征集', task_track: '视频赛道' });
  assert.equal(out.bindings.task, 'AI 赛道征集/视频赛道');
  await assert.rejects(editor(fakePage()).lib.submitPrepare({ ...fill, task: 'AI 赛道征集' }), /SUBMIT_TASK_NEEDS_TRACK: .*图片赛道 \| 视频赛道/);
  await assert.rejects(editor(fakePage()).lib.submitPrepare({ ...fill, task: 'AI 赛道征集', task_track: '音乐赛道' }), /has no track 「音乐赛道」/);
  await assert.rejects(editor(fakePage()).lib.submitPrepare({ ...fill, task: '没有的任务' }), /SUBMIT_OPTION_NOT_FOUND: 任务绑定 has no 「没有的任务」; it shows: 暂不参与 \| 征集最新自拍玩法 \| 创新滤镜开放赛 \| AI 赛道征集（分赛道）/);
  await assert.rejects(editor(fakePage()).lib.submitPrepare({ ...fill, task_track: '图片赛道' }), /has no tracks/);
});

test('submit_prepare fails when picking the task drops the inspiration', async () => {
  const page = fakePage({ inspirationTask: { 国风古风花钿妆: '创新滤镜开放赛' } });
  await assert.rejects(editor(page).lib.submitPrepare(fill), /SUBMIT_BINDING_NOT_APPLIED: 灵感绑定 shows 「选择收藏的灵感或热点」, not 「国风古风花钿妆」/);
});

test('submit_prepare handles a page without the 特效发布设置 step, and lists sections it leaves alone', async () => {
  const page = () => fakePage({ settingsStep: false, extraBasic: '<div class="video-wrapper"><div class="section-title"><div class="title-main">特效介绍视频</div></div></div>' });
  const out = await editor(page()).lib.submitPrepare({ name: '即时特效' });
  assert.equal(out.bindings, null);
  assert.deepEqual(out.other_sections, ['特效介绍视频']);
  await assert.rejects(editor(page()).lib.submitPrepare({ name: '即时特效', task: '征集最新自拍玩法' }), /SUBMIT_NO_SETTINGS_STEP/);
});

test('submit_prepare says what is left when the checks fail or the agreement is not ticked', async () => {
  const failed = await editor(fakePage({ checksPass: false })).lib.submitPrepare(fill);
  assert.equal(failed.review.submit_enabled, false);
  assert.match(failed.next, /^the page's checks did not pass: 性能检测未通过; fix the effect/);
  const unagreed = await editor(fakePage({ agreed: false })).lib.submitPrepare(fill);
  assert.equal(unagreed.review.agreed, false);
  assert.equal(unagreed.next, 'call submit_confirm to tick the agreement (《创作者协议》) and press 提交审核, or press it in the window');
  assert.equal(unagreed.review.submit_enabled, false);
});

test('submit_prepare fails loudly when the page or the window is not what it expects', async () => {
  await assert.rejects(editor(fakePage({ nextLabel: '继续' })).lib.submitPrepare(fill), /SUBMIT_PAGE_CHANGED: the 下一步 button not found/);
  await assert.rejects(editor(fakePage({ answer: false })).lib.submitPrepare(fill), /SUBMIT_PAGE_NOT_READY: .*last error PAGE_NO_ANSWER: submitPage state/);
  await assert.rejects(editor(fakePage(), { windowName: 'SomeOtherWindow' }).lib.submitPrepare(fill), /SUBMIT_WINDOW_NOT_FOUND/);
});

test('submit_prepare closes a submit window left open before opening a fresh one', async () => {
  const old = { constructor: { name: 'DYEHEffectSubmissionWindow' }, isClosed: false, closeWindow() { setTimeout(() => (this.isClosed = true), 5); } };
  const { lib, open } = editor(fakePage(), { left: [old] });
  const out = await lib.submitPrepare({ name: '再提交一次' });
  assert.equal(out.closed_previous, 1);
  assert.equal(old.isClosed, true);
  assert.equal(open().length, 1, 'one submit window, the new one');
  const stuck = { constructor: { name: 'DYEHEffectSubmissionWindow' }, isClosed: false, closeWindow() {} };
  const blocked = editor(fakePage(), { left: [stuck] });
  await assert.rejects(blocked.lib.submitPrepare({ name: '再提交一次' }), /WINDOW_NOT_CLOSED: 1 DYEHEffectSubmissionWindow/);
  assert.equal(blocked.open().length, 1, 'no second window while the old one is open');
});

const SUBMIT_REPORT = 'DYEHSubmitBridge/sendUploadResultEvent';

// An editor with the submit window submit_prepare filled, left on its 提交审核 step.
async function prepared(options, editorOptions) {
  const page = fakePage(options);
  const ed = editor(page, editorOptions);
  await ed.lib.submitPrepare(fill);
  return { page, ...ed };
}

test('submit_confirm presses 提交审核 once, reads the effect id the page reports and closes the window', async () => {
  const older = [
    { effect_id: '6990', name: '测试特效名', status: 101, status_text: '审核未通过' },
    { effect_id: '6980', name: '别的特效', status: 103, status_text: '已上线' },
  ];
  const { page, lib, open, native, lookups } = await prepared({}, { effects: () => older });
  const out = await lib.submitConfirm({ name: fill.name });
  assert.deepEqual(out, {
    submitted: true,
    effect_id: '7001',
    confirmation_source: 'bridge',
    name: '测试特效名',
    trigger_hint: '张嘴试试',
    agreement_ticked: false,
    success_text: '恭喜你,提交成功!',
    needs_real_name: false,
    window_closed: true,
  });
  assert.equal(page.stats.presses, 1);
  assert.deepEqual(native, [[SUBMIT_REPORT, { effectId: '7001' }]], 'the report still reaches the editor');
  assert.equal(open().length, 0);
  assert.deepEqual(lookups, [{ count: 10 }], 'one look at the account before pressing; a rejected effect of the same name does not stop it');
});

test('submit_confirm presses nothing when the account already has the effect in review or online', async () => {
  const live = { effect_id: '92931061', name: '测试特效名', status: 100, status_text: '审核中', created_at: '2026-11-14T03:35:10.000Z' };
  const twice = await prepared({}, { effects: () => [live] });
  await assert.rejects(
    twice.lib.submitConfirm({ name: fill.name }),
    /SUBMIT_ALREADY_SUBMITTED: the account already has 「测试特效名」 \(effect 92931061, 审核中, created 2026-11-14T03:35:10.000Z\); nothing was pressed/,
  );
  assert.equal(twice.page.stats.presses, 0);
  assert.equal(twice.open().length, 1);
  const unread = await prepared(
    {},
    {
      effects: () => {
        throw Error('GET_MY_EFFECTS_FAILED');
      },
    },
  );
  await assert.rejects(unread.lib.submitConfirm({ name: fill.name }), /SUBMIT_LOOKUP_FAILED: .*\(GET_MY_EFFECTS_FAILED\); nothing was pressed/);
  assert.equal(unread.page.stats.presses, 0);
});

test('submit_confirm ticks the agreement for an account that has not agreed', async () => {
  const { page, lib } = await prepared({ agreed: false });
  const box = page.window.document.querySelector('.ip-agreement input');
  assert.equal(box.checked, false);
  const out = await lib.submitConfirm({ name: fill.name });
  assert.equal(out.agreement_ticked, true);
  assert.equal(out.effect_id, '7001');
  assert.equal(box.checked, true);
  assert.equal(page.stats.presses, 1);
});

test('submit_confirm says when the page asks for 实名认证 after the submission', async () => {
  const { lib } = await prepared({ realName: true });
  assert.equal((await lib.submitConfirm({ name: fill.name })).needs_real_name, true);
});

test('submit_confirm presses nothing for a window filled for another name, or whose checks failed or still run', async () => {
  const other = await prepared();
  await assert.rejects(other.lib.submitConfirm({ name: '别的特效' }), /SUBMIT_NAME_MISMATCH: the submit window is filled for 「测试特效名」, not 「别的特效」/);
  assert.equal(other.page.stats.presses, 0);
  assert.equal(other.open().length, 1);
  const failed = await prepared({ checksPass: false });
  await assert.rejects(failed.lib.submitConfirm({ name: fill.name }), /SUBMIT_CHECKS_FAILED: 性能检测未通过/);
  assert.equal(failed.page.stats.presses, 0);
  const running = await prepared({ checksMs: 60000 });
  await assert.rejects(running.lib.submitConfirm({ name: fill.name }), /SUBMIT_CHECKS_RUNNING/);
  assert.equal(running.page.stats.presses, 0);
});

const NOT_LISTED = /the account's newest 10 effects have no new 「测试特效名」 after \d+ read-only checks, but it may still show up, so call pipeline_refresh and look at pipeline_works before submitting again/;

test('submit_confirm passes on the failure the page reports, with its toast, once the account does not list the effect', async () => {
  const { page, lib, open, native, lookups } = await prepared({ report: 'fail' });
  await assert.rejects(lib.submitConfirm({ name: fill.name }), (error) => error.message.startsWith('SUBMIT_FAILED: 服务繁忙; the page says: 网络异常，请检查网络后重试') && NOT_LISTED.test(error.message));
  assert.deepEqual(native, [[SUBMIT_REPORT, { failReason: '服务繁忙' }]]);
  assert.equal(page.stats.presses, 1);
  assert.equal(open().length, 1);
  assert.ok(lookups.length > 2, 'read-only reconciliation continues after the first empty result');
});

test('submit_confirm reports an unknown outcome when the page stops submitting without a report', async () => {
  const { page, lib } = await prepared({ report: 'stop' });
  await assert.rejects(lib.submitConfirm({ name: fill.name }), (error) => error.message.startsWith('SUBMIT_RESULT_UNKNOWN: the page stopped submitting without a result; the page says: 网络异常，请检查网络后重试') && NOT_LISTED.test(error.message));
  assert.equal(page.stats.presses, 1);
});

test('submit_confirm reports an unknown outcome when the page never answers, and does not press again', async () => {
  const { page, lib, open } = await prepared({ report: 'silent' });
  await assert.rejects(lib.submitConfirm({ name: fill.name }), (error) => error.message.startsWith('SUBMIT_RESULT_UNKNOWN: the page reported no result in 1500 ms') && NOT_LISTED.test(error.message));
  assert.equal(page.stats.presses, 1);
  assert.equal(open().length, 1);
});

test('submit_confirm takes a submission the page did not confirm as done when the account lists it, and closes the window', async () => {
  const live = { effect_id: '92931061', name: '测试特效名', status: 100, status_text: '审核中' };
  for (const [report, problem] of [
    ['stop', 'SUBMIT_RESULT_UNKNOWN: the page stopped submitting without a result; the page says: 网络异常，请检查网络后重试'],
    ['fail', 'SUBMIT_FAILED: 服务繁忙; the page says: 网络异常，请检查网络后重试'],
    ['silent', 'SUBMIT_RESULT_UNKNOWN: the page reported no result in 1500 ms'],
  ]) {
    const { page, lib, open } = await prepared({ report }, { effects: (n) => (n === 0 ? [] : [live]) });
    const out = await lib.submitConfirm({ name: fill.name });
    assert.equal(out.submitted, true, report);
    assert.equal(out.effect_id, '92931061', report);
    assert.equal(out.page_problem, problem);
    assert.equal(out.window_closed, true, report);
    assert.equal(open().length, 0, report);
    assert.equal(page.stats.presses, 1, report);
  }
});

test('submit_confirm reconciles delayed listing, excludes every pre-submit id and presses only once', async () => {
  const old = { effect_id: 'old', name: fill.name, status: 101 };
  const live = { effect_id: 'new', name: fill.name, status: 100 };
  const { lib, page } = await prepared({ report: 'stop' }, { effects: (n) => n === 0 ? [old] : n < 4 ? [{ ...old, status: 100 }] : [live] });
  const out = await lib.submitConfirm({ name: fill.name });
  assert.deepEqual({ id: out.effect_id, source: out.confirmation_source, attempts: out.confirmation.attempts, pressed: page.stats.presses }, { id: 'new', source: 'account_list', attempts: 4, pressed: 1 });
});

test('submit_confirm recovers a transient lookup failure without a second submit press', async () => {
  const { lib, page } = await prepared({ report: 'stop' }, { effects: (n) => { if (n === 1) throw Error('temporary lookup failure'); return n < 3 ? [] : [{ effect_id: 'new', name: fill.name, status: 100 }]; } });
  const out = await lib.submitConfirm({ name: fill.name });
  assert.deepEqual([out.effect_id, out.confirmation.attempts, page.stats.presses], ['new', 3, 1]);
});

test('submit_confirm reconciles a bridge failure after the press without repeating it', async () => {
  const { lib, page } = await prepared({ report: 'stop' }, { loseConfirmReply: true, effects: (n) => n < 2 ? [] : [{ effect_id: 'new', name: fill.name, status: 100 }] });
  const out = await lib.submitConfirm({ name: fill.name });
  assert.deepEqual([out.effect_id, out.confirmation_source, page.stats.presses], ['new', 'account_list', 1]);
});

test('submit_confirm reconciles after the user closes the window and does not evaluate it again', async () => {
  const { lib, page, closedEvaluations } = await prepared({ report: 'stop' }, { closeAfterPress: true, effects: (n) => n < 2 ? [] : [{ effect_id: 'new', name: fill.name, status: 100 }] });
  const out = await lib.submitConfirm({ name: fill.name });
  assert.deepEqual([out.effect_id, out.confirmation_source, page.stats.presses, closedEvaluations()], ['new', 'account_list', 1, 0]);
});

test('submit_confirm rechecks a project ZIP changed after preparation before pressing submit', async () => {
  const { lib, page, projectZip } = await prepared();
  fs.truncateSync(projectZip, PROJECT_PACKAGE_LIMIT_BYTES + 1);
  const error = await lib.submitConfirm({ name: fill.name }).then(() => null, (e) => e.message.split(':')[0]);
  assert.deepEqual([error, page.stats.presses], ['PROJECT_PACKAGE_TOO_LARGE', 0]);
});

test('submit_confirm returns the actual project oversize alert rather than unknown or a long wait', async () => {
  const { lib, page, lookups } = await prepared({ report: 'project_oversize' });
  const error = await lib.submitConfirm({ name: fill.name }).then(() => null, (e) => e.message);
  assert.deepEqual([error, page.stats.presses, lookups.length], ['PROJECT_PACKAGE_TOO_LARGE: 工程文件超出200M，无法完成打包，请检查工程中的过大资源 (the submit window is left open)', 1, 1]);
});

test('submit_confirm ignores hidden stale project error notifications', async () => {
  const { lib, page } = await prepared();
  page.window.document.head.insertAdjacentHTML('beforeend', '<style>.old-error { display: none }</style>');
  page.window.document.body.insertAdjacentHTML('beforeend', '<div class="old-error" role="alert">工程文件超出200M</div>');
  const out = await lib.submitConfirm({ name: fill.name });
  assert.deepEqual([out.effect_id, page.stats.presses], ['7001', 1]);
});

test('submit_confirm refuses a review whose checks could not be read', async () => {
  const { lib, page } = await prepared();
  page.window.document.querySelector('.effect-test-container').innerHTML = '';
  const error = await lib.submitConfirm({ name: fill.name }).then(() => null, (e) => e.message.split(':')[0]);
  assert.deepEqual([error, page.stats.presses], ['SUBMIT_PAGE_CHANGED', 0]);
});

test('submit_confirm says to check the dashboard when it cannot read the account after an unconfirmed submission', async () => {
  const { lib, open } = await prepared(
    { report: 'stop' },
    {
      effects: (n) => {
        if (n > 0) throw Error('GET_MY_EFFECTS_FAILED');
        return [];
      },
    },
  );
  await assert.rejects(
    lib.submitConfirm({ name: fill.name }),
    /^Error: SUBMIT_RESULT_UNKNOWN: the page stopped submitting without a result; .*reading the account's effects to see whether it went through anyway failed \(GET_MY_EFFECTS_FAILED\); the account's newest 10 effects have no new .*read-only checks.*call pipeline_refresh.*$/,
  );
  assert.equal(open().length, 1);
});

test('submit_confirm needs exactly one open submit window, and refuses one already submitted', async () => {
  const none = editor(fakePage());
  await assert.rejects(none.lib.submitConfirm({ name: fill.name }), /SUBMIT_WINDOW_NOT_OPEN/);
  await assert.rejects(none.lib.submitConfirm({}), /INVALID_NAME/);
  const extra = { constructor: { name: 'DYEHEffectSubmissionWindow' }, isClosed: false, closeWindow() {} };
  const two = await prepared();
  globalThis.App._windows.push(extra);
  await assert.rejects(two.lib.submitConfirm({ name: fill.name }), /SUBMIT_WINDOW_AMBIGUOUS: 2 submit windows/);
  assert.equal(two.page.stats.presses, 0);
  const stuck = await prepared({}, { closes: false });
  const out = await stuck.lib.submitConfirm({ name: fill.name });
  assert.equal(out.window_closed, false);
  assert.match(out.close_error, /WINDOW_NOT_CLOSED/);
  await assert.rejects(stuck.lib.submitConfirm({ name: fill.name }), /SUBMIT_ALREADY_DONE/);
  assert.equal(stuck.page.stats.presses, 1);
});

test('submit_prepare supports pick_nomination: tick, untick, omit, unavailable, exhausted, and not applied', async () => {
  // 1. LV3+ available & pick_nomination: true
  const avail = editor(fakePage({ pickNomination: 'available', pickRemaining: 1 }));
  const ticked = await avail.lib.submitPrepare({ name: '精选测试', pick_nomination: true, pick_types: ['玩法创新'] });
  assert.deepEqual(ticked.pick_nomination, {
    available: true,
    checked: true,
    remaining: null,
    daily_limit: 1,
    disabled: false,
    text: '每日有1次提报精选的机会，被评为精选可获得 50元现金、15%加权激励 等。查看审核标准',
    types: ['玩法创新'],
    type_options: ['设计精美', '玩法创新', '技术创新'],
    highlight: '',
  });
  await avail.lib.submitClose();

  // 2. Already checked & pick_nomination: false unticks it
  const checked = editor(fakePage({ pickNomination: 'checked' }));
  const unticked = await checked.lib.submitPrepare({ name: '精选测试', pick_nomination: false });
  assert.equal(unticked.pick_nomination.checked, false);
  await checked.lib.submitClose();

  // 3. Omitted pick_nomination leaves checked state untouched
  const keep = editor(fakePage({ pickNomination: 'checked', pickTypes: ['设计精美'] }));
  const kept = await keep.lib.submitPrepare({ name: '精选测试' });
  assert.equal(kept.pick_nomination.checked, true);
  await keep.lib.submitClose();

  // 4. Non-LV3+ (no section) + pick_nomination: true -> UNAVAILABLE
  const nonLv3 = editor(fakePage({ pickNomination: 'none' }));
  await assert.rejects(nonLv3.lib.submitPrepare({ name: '精选测试', pick_nomination: true }), /SUBMIT_PICK_NOMINATION_UNAVAILABLE/);
  await nonLv3.lib.submitClose();

  // 5. Disabled / quota exhausted + pick_nomination: true -> EXHAUSTED
  const exhausted = editor(fakePage({ pickNomination: 'disabled', pickRemaining: 1 }));
  await assert.rejects(exhausted.lib.submitPrepare({ name: '精选测试', pick_nomination: true }), /SUBMIT_PICK_NOMINATION_EXHAUSTED/);
  await exhausted.lib.submitClose();

  // 6. Click ignored / reset by page -> NOT_APPLIED
  const stuck = editor(fakePage({ pickNomination: 'stuck' }));
  await assert.rejects(stuck.lib.submitPrepare({ name: '精选测试', pick_nomination: true }), /SUBMIT_PICK_NOMINATION_NOT_APPLIED/);
  await stuck.lib.submitClose();
});

test('submit_prepare replaces nomination types, preserves omitted types, and leaves publishing to confirm', async () => {
  const page = fakePage({ pickNomination: 'checked', pickTypes: ['技术创新'] });
  const { lib } = editor(page);
  const out = await lib.submitPrepare({ name: '类型多选', pick_types: ['玩法创新', '设计精美'] });
  assert.equal(out.step, '提交审核');
  assert.deepEqual(out.pick_nomination.types, ['设计精美', '玩法创新']);
  assert.deepEqual([...page.window.document.querySelectorAll('.category-check-active')].map((b) => b.textContent), ['设计精美', '玩法创新']);
  assert.equal(page.stats.presses, 0);

  const keep = editor(fakePage({ pickNomination: 'checked', pickTypes: ['技术创新'] }));
  assert.deepEqual((await keep.lib.submitPrepare({ name: '保留类型' })).pick_nomination.types, ['技术创新']);
  const off = editor(fakePage({ pickNomination: 'available' }));
  const skipped = await off.lib.submitPrepare({ name: '普通提交' });
  assert.equal(skipped.pick_nomination.checked, false);
  assert.deepEqual(skipped.pick_nomination.types, []);
});

test('submit_prepare reports required, unavailable, unknown, missing and rejected nomination types', async () => {
  const required = editor(fakePage({ pickNomination: 'available' }));
  await assert.rejects(required.lib.submitPrepare({ name: '缺类型', pick_nomination: true }), /SUBMIT_PICK_TYPES_REQUIRED:.*pick_types.*设计精美.*玩法创新.*技术创新/);
  const unavailable = editor(fakePage({ pickNomination: 'none' }));
  await assert.rejects(unavailable.lib.submitPrepare({ name: '无精选', pick_types: ['玩法创新'] }), /SUBMIT_PICK_NOMINATION_UNAVAILABLE/);
  const unchecked = editor(fakePage({ pickNomination: 'available' }));
  await assert.rejects(unchecked.lib.submitPrepare({ name: '未勾选', pick_types: ['玩法创新'] }), /SUBMIT_PICK_TYPES_UNAVAILABLE:.*pick_nomination=true/);
  const noStep = editor(fakePage({ settingsStep: false }));
  await assert.rejects(noStep.lib.submitPrepare({ name: '无设置页', pick_types: ['玩法创新'] }), /SUBMIT_PICK_NOMINATION_UNAVAILABLE/);

  const page = fakePage({ pickNomination: 'checked', pickTypes: ['设计精美'], pickTypeOptions: ['设计精美', '新增类型'] });
  const unknown = editor(page);
  await assert.rejects(unknown.lib.submitPrepare({ name: '未知类型', pick_types: ['新增类型', '玩法创新'] }), /SUBMIT_OPTION_NOT_FOUND: 提报类型.*设计精美.*新增类型/);
  assert.deepEqual([...page.window.document.querySelectorAll('.category-check-active')].map((b) => b.textContent), ['设计精美'], 'validate all labels before altering any selection');
  const dynamic = editor(fakePage({ pickNomination: 'available', pickTypeOptions: ['新增类型'] }));
  assert.deepEqual((await dynamic.lib.submitPrepare({ name: '动态选项', pick_nomination: true, pick_types: ['新增类型'] })).pick_nomination.types, ['新增类型']);
  const missing = editor(fakePage({ pickNomination: 'checked', pickTypeOptions: [] }));
  await assert.rejects(missing.lib.submitPrepare({ name: '页面改版', pick_types: ['玩法创新'] }), /SUBMIT_PAGE_CHANGED:.*提报类型/);
  const stuck = editor(fakePage({ pickNomination: 'checked', pickTypes: ['设计精美'], pickTypesStuck: true }));
  await assert.rejects(stuck.lib.submitPrepare({ name: '拒绝选择', pick_types: ['玩法创新'] }), /SUBMIT_PICK_TYPES_NOT_APPLIED/);
});

test('submit_prepare fills nomination highlights through the textarea, preserves omitted text and clears explicit empty text', async () => {
  const page = fakePage({ pickNomination: 'available' });
  const { lib } = editor(page);
  const text = '五夹逐轮加速，栗子随机掉头，考验点屏时机。';
  const out = await lib.submitPrepare({ name: '填写亮点', pick_nomination: true, pick_types: ['玩法创新'], pick_highlight: text });
  assert.equal(out.pick_nomination.highlight, text);
  assert.equal(page.window.document.querySelector('.innovation-category textarea').value, text);
  assert.equal(out.step, '提交审核');
  assert.equal(page.stats.presses, 0);

  const keep = editor(fakePage({ pickNomination: 'checked', pickTypes: ['玩法创新'], pickHighlight: '原来的亮点' }));
  assert.equal((await keep.lib.submitPrepare({ name: '保留亮点' })).pick_nomination.highlight, '原来的亮点');
  const clear = editor(fakePage({ pickNomination: 'checked', pickTypes: ['玩法创新'], pickHighlight: '原来的亮点' }));
  assert.equal((await clear.lib.submitPrepare({ name: '清空亮点', pick_highlight: '' })).pick_nomination.highlight, '');
});

test('submit_prepare waits for asynchronous nomination configuration before filling types and highlights', async () => {
  const { lib } = editor(fakePage({ pickNomination: 'available', pickConfigAt: 200 }));
  const out = await lib.submitPrepare({ name: '等待配置', pick_nomination: true, pick_types: ['玩法创新'], pick_highlight: '逐轮加速' });
  assert.deepEqual(out.pick_nomination.types, ['玩法创新']);
  assert.equal(out.pick_nomination.highlight, '逐轮加速');
  assert.equal(out.step, '提交审核');
});

test('submit_prepare rejects unavailable, missing, truncated or ignored nomination highlights', async () => {
  const none = editor(fakePage());
  await assert.rejects(none.lib.submitPrepare({ name: '无精选', pick_highlight: '亮点' }), /SUBMIT_PICK_NOMINATION_UNAVAILABLE/);
  const off = editor(fakePage({ pickNomination: 'available' }));
  await assert.rejects(off.lib.submitPrepare({ name: '未勾选', pick_highlight: '亮点' }), /SUBMIT_PICK_HIGHLIGHT_UNAVAILABLE/);
  const noStep = editor(fakePage({ settingsStep: false }));
  await assert.rejects(noStep.lib.submitPrepare({ name: '无设置页', pick_highlight: '亮点' }), /SUBMIT_PICK_NOMINATION_UNAVAILABLE/);
  const missing = editor(fakePage({ pickNomination: 'checked', pickTypes: ['玩法创新'], pickHighlightMissing: true }));
  await assert.rejects(missing.lib.submitPrepare({ name: '无文本框', pick_highlight: '亮点' }), /SUBMIT_PAGE_CHANGED:.*亮点 textarea/);
  const long = editor(fakePage({ pickNomination: 'checked', pickTypes: ['玩法创新'] }));
  await assert.rejects(long.lib.submitPrepare({ name: '超长亮点', pick_highlight: '亮'.repeat(51) }), /SUBMIT_PICK_HIGHLIGHT_NOT_APPLIED:.*page limit: 50/);
  const stuck = editor(fakePage({ pickNomination: 'checked', pickTypes: ['玩法创新'], pickHighlightStuck: true }));
  await assert.rejects(stuck.lib.submitPrepare({ name: '未应用', pick_highlight: '亮点' }), /SUBMIT_PICK_HIGHLIGHT_NOT_APPLIED/);
});
