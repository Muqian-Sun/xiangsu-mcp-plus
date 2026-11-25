'use strict';
// The submit and 特效检测 windows show web pages (effect.douyin.com/ac/submit-orion, /ac/perftest-orion-v2).
// Scripts are run in them through the window's webview and answer through the window's JS bridge, which
// hands page queries (orionJSB://<scope>/<method>?<params>) to the handlers registered for that scope.

const BRIDGE_SCOPE = 'XiangsuMcpPlus';
const SOURCE_URL = 'orion://inject/xiangsu-mcp-plus';
// Picked, not measured beyond the live runs on 2026-11-07, where every page script answered within 3 s.
const CALL_TIMEOUT_MS = 15000;

// Runs in the page: calls `fn(arg)` and posts the outcome back through the bridge.
function pageCall(id, scope, fn, arg) {
  const send = (v) =>
    window.orionQuery({ request: `orionJSB://${scope}/result?${encodeURIComponent(JSON.stringify(Object.assign({ id }, v)))}`, onSuccess() {}, onFailure() {} });
  Promise.resolve()
    .then(() => fn(arg))
    .then(
      (value) => send({ ok: true, value: value === undefined ? null : value }),
      (e) => send({ ok: false, error: String((e && e.message) || e) }),
    );
}

// Runs in the page, so it must not use anything from this module. Finds every element by class and label
// text; one that is missing fails with SUBMIT_PAGE_CHANGED rather than being skipped.
async function submitPage(arg) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const text = (el) => (el ? el.textContent.trim() : '');
  const need = (el, what) => {
    if (!el) throw Error(`SUBMIT_PAGE_CHANGED: ${what} not found`);
    return el;
  };
  const shown = (el) => {
    for (let e = el; e; e = e.parentElement) {
      const style = getComputedStyle(e);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return true;
  };
  const notifications = () => [...new Set([...document.querySelectorAll('.semi-toast-content-text, .semi-toast-content, [role="alert"]')].filter(shown).map(text).filter(Boolean))];
  // A section title is its first text node; the required-field star and the help icon follow it.
  const titleOf = (el) => {
    const t = el && el.querySelector('.title-main');
    return t && t.firstChild ? t.firstChild.textContent.trim() : '';
  };
  const step = () => text(document.querySelector('header .nav-item.active .nav-item-text'));
  const errors = () => [...document.querySelectorAll('.text-err')].filter(shown).map(text).filter(Boolean);
  const sections = () => [...document.querySelectorAll('main .content-left .section-title')].filter(shown).map((s) => titleOf(s.parentElement));
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  const setTextareaValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  // data: null makes the page's input handler take the whole value, the way it treats a paste.
  const type = (input, value) => {
    input.focus();
    (input instanceof HTMLTextAreaElement ? setTextareaValue : setValue).call(input, value);
    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: null, inputType: 'insertReplacementText' }));
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    input.blur();
  };
  // The selectors open on mousedown and pick tasks on mouseup, which element.click() does not send.
  const press = (el) => {
    for (const t of ['mousedown', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
  };
  const footerButton = (label) => [...document.querySelectorAll('footer .button')].find((b) => text(b) === label);
  // After a submission the page leaves the steps for its 提交成功 view, whose footer offers 查看我的特效.
  const submitted = () => !!footerButton('查看我的特效');
  const binder = (title) => [...document.querySelectorAll('.bind-wrapper')].filter(shown).find((w) => titleOf(w) === title);
  const shownText = (w) => (w ? text(w.querySelector('.selector-input .text')) : null);
  const optionName = (o) => text(o.querySelector('.option-name'));
  const pickNominationWrapper = () => [...document.querySelectorAll('.innovation-wrapper')].filter(shown).find((w) => /精选提报/.test(text(w.querySelector('.innovation-title'))));
  const pickTypeBoxes = () => [...(pickNominationWrapper()?.querySelectorAll('.innovation-category-content-check-box') || [])].filter(shown);
  const readPickNomination = () => {
    const w = pickNominationWrapper();
    if (!w) return { available: false, checked: null, remaining: null, daily_limit: null, disabled: false, text: null, types: [], type_options: [], highlight: null };
    const box = w.querySelector('.custom-checkbox');
    const contentText = text(w.querySelector('.innovation-main')) || text(w);
    const mRem = /(?:剩余|还可提报)\s*(\d+)\s*次/.exec(contentText);
    const mLim = /每日有\s*(\d+)\s*次/.exec(contentText);
    const disabled = !box || box.classList.contains('disabled') || box.hasAttribute('disabled') || box.getAttribute('aria-disabled') === 'true';
    const checked = !!box && (box.classList.contains('checked') || box.classList.contains('active') || box.getAttribute('aria-checked') === 'true' || !!box.querySelector('input:checked'));
    const types = pickTypeBoxes();
    return {
      available: true, checked, remaining: mRem ? Number(mRem[1]) : null, daily_limit: mLim ? Number(mLim[1]) : null, disabled, text: contentText || null,
      types: types.filter((b) => b.classList.contains('category-check-active')).map(text),
      type_options: types.map(text),
      highlight: checked ? w.querySelector('.innovation-category textarea')?.value ?? null : null,
    };
  };

  switch (arg.action) {
    case 'state': {
      const requests = performance.getEntriesByType('resource');
      // Keep query strings (signed asset URLs and account data) out of diagnostic output.
      const address = (value) => {
        try {
          const u = new URL(value, location.href);
          return `${u.origin === 'null' ? `${u.protocol}//${u.host}` : u.origin}${u.pathname}`;
        } catch (_) {
          return '(unreadable URL)';
        }
      };
      const completed = new Set(requests.map((r) => r.name));
      const pendingScripts = [...document.querySelectorAll('script[src]')]
        .filter((s) => !completed.has(s.src))
        .map((s) => ({ kind: 'script', url: address(s.src) }));
      const pendingImages = [...document.images]
        .filter((img) => img.src && (!img.complete || !img.naturalWidth))
        .map((img) => ({ kind: 'image', url: address(img.currentSrc || img.src), complete: img.complete }));
      return {
        ready_state: document.readyState,
        step: step(),
        has_form: !!document.querySelector('.name-wrapper input'),
        icons_loaded: document.querySelectorAll('.upload-icon-wrapper .icon-bottom > div').length > 0,
        name_config_loaded: requests.some((r) => /[?&]key=aiName(&|$)/.test(r.name)),
        resources: requests.length,
        // Picked bounds: enough recent resources to identify a stalled dependency without dumping the page.
        diagnostics: {
          page: address(location.href),
          title: document.title,
          icon_sections: document.querySelectorAll('.upload-icon-wrapper').length,
          icon_status: [...document.querySelectorAll('.upload-icon-wrapper .icon-bottom')].map((el) => ({
            class: el.className, children: el.children.length, text: text(el).slice(0, 120),
          })),
          errors: errors(),
          api_resources: requests.filter((r) => r.name.includes('/creator/') || r.name.includes('/platform/')).slice(-12).map((r) => ({
            url: address(r.name), kind: r.initiatorType || null, duration_ms: Math.round(r.duration || 0), status: r.responseStatus ?? null,
          })),
          pending_assets: [...pendingScripts, ...pendingImages].slice(-12),
          last_resources: requests.slice(-12).map((r) => ({
            url: address(r.name), kind: r.initiatorType || null, duration_ms: Math.round(r.duration || 0),
            bytes: r.transferSize ?? null, status: r.responseStatus ?? null,
          })),
        },
      };
    }

    case 'diagnose': {
      const state = await submitPage({ action: 'state' });
      const request = performance.getEntriesByType('resource').findLast((r) => r.name.includes('/creator/v1/effect_task_list'));
      if (!request) {
        state.diagnostics.task_probe = { attempted: false, reason: 'task request not observed' };
        return state;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), arg.wait_ms);
      try {
        // Repeat only the task-list GET already made by this page, in the same logged-in page context.
        const response = await fetch(request.name, { credentials: 'include', signal: controller.signal });
        const result = await response.json();
        state.diagnostics.task_probe = { attempted: true, status: response.status, code: result?.code ?? null,
          count: Array.isArray(result?.data?.effect_task_list) ? result.data.effect_task_list.length : null };
      } catch (e) {
        state.diagnostics.task_probe = { attempted: true, error: e.name };
      } finally {
        clearTimeout(timer);
      }
      return state;
    }

    case 'basic': {
      if (step() !== '特效基础信息') throw Error(`SUBMIT_PAGE_CHANGED: expected the 特效基础信息 step, the page is on ${step() || '(none)'}`);
      const name = need(document.querySelector('.name-wrapper input'), 'the 特效名称 input');
      type(name, arg.name);
      if (arg.trigger_hint !== undefined) type(need(document.querySelector('.trigger-wrapper input'), 'the 特效触发提示 input'), arg.trigger_hint);
      if (arg.camera !== undefined) {
        const labels = [...document.querySelectorAll('.default-camera-wrapper label')];
        press(need(labels.find((l) => text(l) === arg.camera), `the 默认摄像头方向 option ${arg.camera}`));
      }
      await sleep(arg.settle_ms);
      const hint = document.querySelector('.trigger-wrapper input');
      return {
        name: name.value,
        trigger_hint: hint ? hint.value : null,
        camera: text(document.querySelector('.default-camera-wrapper label.semi-radio-checked')) || null,
        icons: {
          female: !!document.querySelector('.upload-icon-wrapper .icon-bottom.female .finish'),
          male: !!document.querySelector('.upload-icon-wrapper .icon-bottom.male .finish'),
        },
        sections: sections(),
        errors: errors(),
      };
    }

    case 'next': {
      const from = step();
      const button = [...document.querySelectorAll('footer .button.next')].find((b) => text(b) === '下一步');
      press(need(button, 'the 下一步 button'));
      for (let waited = 0; step() === from && waited < arg.wait_ms; waited += 100) await sleep(100);
      return { from, to: step(), errors: errors() };
    }

    case 'bind': {
      // The live page fetches eligibility, then innovation_statement config + type labels, separately
      // from aiName. The settings step can be active before that region has mounted (seen 2026-11-23).
      if (arg.pick_nomination === true || arg.pick_types !== undefined || arg.pick_highlight !== undefined) {
        for (let waited = 0; !pickNominationWrapper() && waited < arg.wait_ms; waited += 100) await sleep(100);
      }
      if (arg.inspiration !== undefined && !(arg.inspiration === '暂不绑定' && shownText(binder('灵感绑定')) === '选择收藏的灵感或热点')) {
        const w = need(binder('灵感绑定'), 'the 灵感绑定 selector');
        const match = () => [...w.querySelectorAll('.favor-option')].find((o) => optionName(o) === arg.inspiration);
        press(need(w.querySelector('.selector-input'), 'the 灵感绑定 box'));
        await sleep(200);
        // The list holds the collection a page at a time; the search box covers the rest.
        let hit = match();
        let searched = null;
        if (!hit && w.querySelector('.search-input')) {
          type(w.querySelector('.search-input'), arg.inspiration);
          for (let waited = 0; waited < arg.wait_ms; waited += 200) {
            await sleep(200);
            hit = match();
            searched = text(w.querySelector('.empty-list'));
            if (hit || searched === '暂无搜索结果') break;
          }
        }
        if (!hit) {
          const options = [...w.querySelectorAll('.favor-option')].map(optionName);
          const search = searched === null ? '' : `searching it gave ${searched || 'no exact match'}; `;
          throw Error(`SUBMIT_OPTION_NOT_FOUND: 灵感绑定 has no 「${arg.inspiration}」 among the collected inspirations and hotspots; ${search}it lists: ${options.join(' | ') || text(w.querySelector('.empty-list')) || '(nothing)'}`);
        }
        press(hit);
        await sleep(arg.settle_ms);
      }
      if (arg.task !== undefined) {
        const w = need(binder('任务绑定'), 'the 任务绑定 selector');
        if (w.querySelector('.selector-container.task-disabled')) throw Error(`SUBMIT_OPTION_NOT_FOUND: 任务绑定 is unavailable: ${shownText(w)}`);
        press(need(w.querySelector('.selector-input'), 'the 任务绑定 box'));
        await sleep(200);
        const plain = [...w.querySelectorAll('.favor-option')].find((o) => optionName(o) === arg.task);
        const tracked = [...w.querySelectorAll('.selector-list-track-item')].find((t) => text(t.querySelector('.selector-list-track-item-title')) === arg.task);
        const options = () =>
          [...w.querySelectorAll('.favor-option')].map(optionName).concat([...w.querySelectorAll('.selector-list-track-item-title')].map((t) => `${text(t)}（分赛道）`));
        if (!plain && !tracked) throw Error(`SUBMIT_OPTION_NOT_FOUND: 任务绑定 has no 「${arg.task}」; it shows: ${options().join(' | ')}`);
        if (tracked) {
          const title = tracked.querySelector('.selector-list-track-item-title');
          press(title);
          await sleep(300);
          const tracks = [...tracked.querySelectorAll('.selector-list-track-item-info')];
          const names = tracks.map((i) => text(i.querySelector('.selector-list-track-item-info-title')));
          if (arg.task_track === undefined) throw Error(`SUBMIT_TASK_NEEDS_TRACK: 任务「${arg.task}」 is split into tracks; pass task_track, one of: ${names.join(' | ')}`);
          const hit = tracks[names.indexOf(arg.task_track)];
          if (!hit) throw Error(`SUBMIT_OPTION_NOT_FOUND: 任务「${arg.task}」 has no track 「${arg.task_track}」; tracks: ${names.join(' | ')}`);
          press(hit);
        } else {
          if (arg.task_track !== undefined) throw Error(`SUBMIT_OPTION_NOT_FOUND: 任务「${arg.task}」 has no tracks; leave out task_track`);
          press(plain);
        }
        await sleep(arg.settle_ms);
      }
      if (arg.pick_nomination !== undefined) {
        const cur = readPickNomination();
        if (!cur.available) {
          if (arg.pick_nomination === true) throw Error('SUBMIT_PICK_NOMINATION_UNAVAILABLE: 精选提报 section is not present on this page');
        } else if (cur.checked !== arg.pick_nomination) {
          if (cur.disabled) throw Error(`SUBMIT_PICK_NOMINATION_EXHAUSTED: 精选提报 is disabled (${cur.text || 'no detail'})`);
          const box = pickNominationWrapper().querySelector('.custom-checkbox');
          press(box);
          await sleep(arg.settle_ms);
          const after = readPickNomination();
          if (after.checked !== arg.pick_nomination) throw Error(`SUBMIT_PICK_NOMINATION_NOT_APPLIED: 精选提报 stayed ${after.checked}, expected ${arg.pick_nomination}`);
        }
      }
      if (arg.pick_types !== undefined) {
        const cur = readPickNomination();
        if (!cur.available) throw Error('SUBMIT_PICK_NOMINATION_UNAVAILABLE: 精选提报 section is not present on this page');
        if (!cur.checked) throw Error('SUBMIT_PICK_TYPES_UNAVAILABLE: 提报类型 requires 精选提报 checked; pass pick_nomination=true');
        if (!cur.type_options.length) throw Error('SUBMIT_PAGE_CHANGED: the 提报类型 options not found');
        const unknown = arg.pick_types.filter((t) => !cur.type_options.includes(t));
        if (unknown.length) throw Error(`SUBMIT_OPTION_NOT_FOUND: 提报类型 has no 「${unknown.join(' | ')}」; options: ${cur.type_options.join(' | ')}`);
        // React rerenders after each toggle; find each option again rather than pressing stale nodes.
        for (const label of cur.type_options) {
          const box = need(pickTypeBoxes().find((b) => text(b) === label), `the 提报类型 option ${label}`);
          if (box.classList.contains('category-check-active') !== arg.pick_types.includes(label)) {
            press(box);
            await sleep(arg.settle_ms);
          }
        }
        const after = readPickNomination();
        const wanted = [...new Set(arg.pick_types)];
        if (after.types.length !== wanted.length || wanted.some((t) => !after.types.includes(t))) {
          throw Error(`SUBMIT_PICK_TYPES_NOT_APPLIED: 提报类型 shows 「${after.types.join(' | ')}」, expected 「${wanted.join(' | ')}」`);
        }
      }
      if (arg.pick_highlight !== undefined) {
        const cur = readPickNomination();
        if (!cur.available) throw Error('SUBMIT_PICK_NOMINATION_UNAVAILABLE: 精选提报 section is not present on this page');
        if (!cur.checked) throw Error('SUBMIT_PICK_HIGHLIGHT_UNAVAILABLE: 亮点 requires 精选提报 checked; pass pick_nomination=true');
        const input = need(pickNominationWrapper().querySelector('.innovation-category textarea'), 'the 精选提报 亮点 textarea');
        type(input, arg.pick_highlight);
        await sleep(arg.settle_ms);
        const after = readPickNomination();
        if (after.highlight !== arg.pick_highlight) throw Error(`SUBMIT_PICK_HIGHLIGHT_NOT_APPLIED: 亮点 kept 「${after.highlight}」 of 「${arg.pick_highlight}」 (page limit: 50)`);
      }
      const nomination = readPickNomination();
      if (nomination.checked && nomination.type_options.length && !nomination.types.length) {
        throw Error(`SUBMIT_PICK_TYPES_REQUIRED: 请选择提报类型; pass pick_types with at least one of: ${nomination.type_options.join(' | ')}`);
      }
      const inspiration = shownText(binder('灵感绑定'));
      return { inspiration: arg.inspiration === '暂不绑定' && inspiration === '选择收藏的灵感或热点' ? '暂不绑定' : inspiration, task: shownText(binder('任务绑定')), pick_nomination: nomination, sections: sections(), errors: errors() };
    }

    case 'review': {
      if (submitted()) throw Error('SUBMIT_ALREADY_DONE: the window already shows the 提交成功 page');
      if (step() !== '提交审核') throw Error(`SUBMIT_PAGE_CHANGED: expected the 提交审核 step, the page is on ${step() || '(none)'}`);
      const items = [...document.querySelectorAll('.publish-wrap .effect-content-item')].map(text);
      const field = (label) => {
        const hit = items.find((t) => t.startsWith(label));
        return hit === undefined ? null : hit.slice(label.length);
      };
      const submit = need(footerButton('提交审核'), 'the 提交审核 button');
      const agreement = document.querySelector('footer .ip-agreement');
      return {
        title: text(document.querySelector('.publish-wrap .submit-title h1')),
        name: field('特效名称：'),
        trigger_hint: field('特效触发提示：'),
        pick_nomination: field('精选提报：'),
        checks: [...document.querySelectorAll('.publish-wrap .effect-test-item-top-text')].map(text),
        agreed: agreement ? !!agreement.querySelector('.agreed') : null,
        submit_enabled: !submit.classList.contains('disable'),
        toasts: notifications(),
        page_errors: errors(),
      };
    }

    // Ticks the agreement unless the account agreed before (the page then shows 已阅读并同意 instead of
    // the checkbox) and presses 提交审核. The page reports the outcome to the editor with the query
    // orionJSB://DYEHSubmitBridge/sendUploadResultEvent?{effectId} once /creator/v1/submit took the effect,
    // or ?{failReason} when it did not; window.orionQuery is wrapped to keep that report for 'outcome'.
    case 'confirm': {
      if (submitted()) throw Error('SUBMIT_ALREADY_DONE: the window already shows the 提交成功 page');
      if (step() !== '提交审核') throw Error(`SUBMIT_PAGE_CHANGED: expected the 提交审核 step, the page is on ${step() || '(none)'}`);
      const agreement = need(document.querySelector('footer .ip-agreement'), 'the agreement');
      let ticked = false;
      if (!agreement.querySelector('.agreed')) {
        const box = need(agreement.querySelector('input[type="checkbox"]'), 'the agreement checkbox');
        if (!box.checked) {
          box.click();
          ticked = true;
          await sleep(arg.settle_ms);
        }
        if (!box.checked) throw Error('SUBMIT_AGREEMENT_NOT_TICKED: the agreement checkbox stayed unticked');
      }
      const submit = need(footerButton('提交审核'), 'the 提交审核 button');
      if (submit.classList.contains('disable')) {
        throw Error(`SUBMIT_DISABLED: 提交审核 cannot be pressed; the page says ${text(document.querySelector('.publish-wrap .submit-title h1')) || '(nothing)'}`);
      }
      if (!window.__xsSubmit) {
        const watch = { result: null };
        const query = window.orionQuery;
        window.orionQuery = function (req) {
          const m = /^orionJSB:\/\/DYEHSubmitBridge\/sendUploadResultEvent\?(.*)$/.exec((req && req.request) || '');
          if (m) {
            try {
              watch.result = JSON.parse(decodeURIComponent(m[1]));
            } catch (_) {
              watch.result = { unreadable: m[1] };
            }
          }
          return query.apply(this, arguments);
        };
        window.__xsSubmit = watch;
      }
      window.__xsSubmit.result = null;
      press(submit);
      return { ticked };
    }

    case 'outcome': {
      const submit = footerButton('提交审核');
      return {
        result: window.__xsSubmit ? window.__xsSubmit.result : null,
        submitted: submitted(),
        success_text: text(document.querySelector('.upload-preview header h2')) || null,
        needs_real_name: !!footerButton('实名认证'),
        loading: !!submit && submit.classList.contains('loading'),
        toasts: notifications(),
        page_errors: errors(),
      };
    }

    default:
      throw Error(`UNKNOWN_ACTION: ${arg.action}`);
  }
}

// Runs in the 特效检测 page once its result is in. Reads the verdict and each check with its figures
// (package size, Android then iOS frame rate, each against its limit). A check that did not pass has a help
// icon whose advice only renders while it is hovered, so it is hovered and read.
async function perfPage(arg) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const text = (el) => (el ? el.textContent.trim() : '');
  const title = document.querySelector('.perf-top .status-title');
  const items = [...document.querySelectorAll('.effect-test-container .effect-test-item')];
  if (!title || !items.length) throw Error('PERF_PAGE_CHANGED: the 特效检测 page shows no verdict or checks');
  const hover = (el, on) => {
    el.dispatchEvent(new MouseEvent(on ? 'mouseenter' : 'mouseleave', { bubbles: false, view: window }));
    el.dispatchEvent(new MouseEvent(on ? 'mouseover' : 'mouseout', { bubbles: true, view: window }));
  };
  const checks = [];
  for (const item of items) {
    const check = { name: text(item.querySelector('.effect-test-item-top-text')) };
    const rows = [...item.querySelectorAll('.effect-test-item-bottom-item')];
    if (rows.length) {
      check.figures = rows.map((row) => {
        const [value, limit] = row.querySelectorAll('span');
        return { value: text(value), limit: text(limit).replace(/^\//, ''), passed: !!value && value.classList.contains('effect-test-item-bottom-text-pass') };
      });
      if (rows.length === 2) check.figures.forEach((f, i) => (f.platform = ['android', 'ios'][i]));
    }
    const help = item.querySelector('.effect-test-item-top-help');
    if (help) {
      const before = new Set(document.querySelectorAll('.effect-test-item-top-help-content-text'));
      hover(help, true);
      let tip = null;
      for (let waited = 0; !tip && waited < arg.wait_ms; waited += 100) {
        await sleep(100);
        tip = [...document.querySelectorAll('.effect-test-item-top-help-content-text')].find((t) => !before.has(t)) || null;
      }
      hover(help, false);
      if (tip) check.advice = text(tip);
      else check.advice_unavailable = `its help popup did not open in ${arg.wait_ms} ms`;
    }
    checks.push(check);
  }
  const desc = document.querySelector('.perf-top .status-desc');
  return { verdict: text(title), ...(desc ? { verdict_detail: text(desc) } : {}), checks };
}

// Returns run(arg, ms): runs pageFn(arg) in the window's page and resolves with what it returns.
function pageBridge(win, pageFn) {
  const pending = new Map();
  let seq = 0;
  win.JSB.joinRegisterHandler(BRIDGE_SCOPE, {
    result: (p) => {
      const done = p && pending.get(p.id);
      if (done) {
        pending.delete(p.id);
        done(p);
      }
      return '';
    },
  });
  return (arg, ms = CALL_TIMEOUT_MS) =>
    new Promise((resolve, reject) => {
      if (win.isClosed) return reject(Error('PAGE_WINDOW_CLOSED: the page window was closed; no script was evaluated'));
      const id = String(++seq);
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Error(`PAGE_NO_ANSWER: ${pageFn.name}${arg.action ? ` ${arg.action}` : ''} got no answer from the page in ${ms} ms`));
      }, ms);
      pending.set(id, (p) => {
        clearTimeout(timer);
        if (p.ok) resolve(p.value);
        else reject(Error(p.error));
      });
      // The second argument is the script's source URL: a callback there crashes the editor process.
      win.webview.evaluateJavascript(`(${pageCall})(${JSON.stringify(id)}, ${JSON.stringify(BRIDGE_SCOPE)}, ${pageFn}, ${JSON.stringify(arg)});`, SOURCE_URL);
    });
}

const submitPageBridge = (win) => pageBridge(win, submitPage);
const perfPageBridge = (win) => pageBridge(win, perfPage);

module.exports = { submitPageBridge, perfPageBridge, submitPage, perfPage, BRIDGE_SCOPE, SOURCE_URL };
