import { app, BrowserWindow } from "electron";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { version } from "../package.json";
const root = path.resolve(process.env.GOGA_UI_SMOKE_DIR || "work/ui-smoke");
mkdirSync(root, { recursive: true });
app.setPath("userData", path.join(root, "data"));
app.setPath("sessionData", path.join(root, "session"));
app.setPath("crashDumps", path.join(root, "crashes"));
app.setAppLogsPath(path.join(root, "logs"));
app.setName("Goga UI fixture verification");
const watchdog = setTimeout(() => app.exit(1), 30000);
void (async () => {
  await app.whenReady();
  app.dock?.hide();
  const win = new BrowserWindow({
    show: false,
    width: 1320,
    height: 1000,
    webPreferences: {
      preload: path.join(root, "smoke-ui-preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const wc = win.webContents;
  const evaluate = (code: string) => wc.executeJavaScript(code);
  async function until(code: string) {
    for (let i = 0; i < 150; i++) {
      if (await evaluate(code)) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw Error("UI fixture timeout: " + code);
  }
  await win.loadFile(path.resolve("dist/index.html"));
  await until(
    `!![...document.querySelectorAll('button')].find(b=>b.textContent.includes('Запустить конвейер'))`,
  );
  await evaluate(
    `[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Запустить конвейер')).click()`,
  );
  await until(`!!document.querySelector('[role="combobox"]')`);
  await until(`!!document.querySelector('.stage-card')`);
  await until(
    `document.querySelector(".task-editor textarea")?.value.includes("Задача выбранного топика")`,
  );
  const result: any = {
    visibleWindow: win.isVisible(),
    pipelineLaunched: false,
    sizes: [],
  };
  for (const [width, height] of [
    [1320, 1000],
    [920, 1000],
    [920, 700],
  ]) {
    win.setSize(width, height);
    await evaluate(
      `new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`,
    );
    const closed = await evaluate(
      `(()=>{const control=document.querySelector('[role="combobox"]'); return {version:document.querySelector('.sidebar-footer .app-version').textContent,footer:document.querySelector('.sidebar-footer').textContent,description:document.getElementById(control.getAttribute('aria-describedby')).textContent,nativeSelects:[...document.querySelectorAll('select')].map(e=>({padding:getComputedStyle(e).paddingRight,arrow:getComputedStyle(e).backgroundPosition})),horizontalOverflow:document.querySelector('.scroll-area').scrollWidth>document.querySelector('.scroll-area').clientWidth};})()`,
    );
    assert.equal(closed.version, `v${version}`);
    assert.equal(closed.footer, `© Goga 2026v${version}`);
    assert.equal(closed.horizontalOverflow, false);
    assert.equal(
      await evaluate(
        `[...document.querySelectorAll('input[type="radio"]')].every(e=>e.getBoundingClientRect().width<=18)`,
      ),
      true,
      "compact radio geometry",
    );
    for (const select of closed.nativeSelects)
      assert.equal(select.padding, "36px");
    writeFileSync(
      path.join(root, `ui-${width}x${height}-closed.png`),
      (await wc.capturePage()).toPNG(),
    );
    await evaluate(`document.querySelector('[role="combobox"]').click()`);
    await until(`!!document.querySelector('[role="listbox"]')`);
    await evaluate(
      `new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`,
    );
    const open = await evaluate(
      `(()=>{const popup=document.querySelector('[role="listbox"]');const rect=popup.getBoundingClientRect(),clip=document.querySelector(".scroll-area").getBoundingClientRect();return {placement:popup.dataset.placement,insideViewport:rect.top>=clip.top-1&&rect.bottom<=Math.min(clip.bottom,innerHeight)+1,optionCount:popup.querySelectorAll('[role="option"]').length,overflow:popup.scrollWidth>popup.clientWidth,valuesContained:[...popup.querySelectorAll('.topic-select-value')].every(e=>{const v=e.getBoundingClientRect(),o=e.closest('[role="option"]').getBoundingClientRect();return v.left>=o.left&&v.right<=o.right-20})}})()`,
    );
    assert.equal(open.optionCount, 2);
    assert.equal(open.insideViewport, true);
    assert.equal(open.overflow, false);
    assert.equal(open.valuesContained, true);
    writeFileSync(
      path.join(root, `ui-${width}x${height}-open.png`),
      (await wc.capturePage()).toPNG(),
    );
    await evaluate(
      `document.querySelector('[role="combobox"]').focus({preventScroll:true})`,
    );
    const outerScroll = await evaluate(
      `document.querySelector('.scroll-area').scrollTop`,
    );
    wc.sendInputEvent({ type: "keyDown", keyCode: "End" });
    wc.sendInputEvent({ type: "keyUp", keyCode: "End" });
    await evaluate(
      `new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`,
    );
    assert.equal(
      await evaluate(`document.querySelector('.scroll-area').scrollTop`),
      outerScroll,
    );
    assert.equal(
      await evaluate(
        `(()=>{const c=document.querySelector('[role="combobox"]'),a=document.getElementById(c.getAttribute('aria-activedescendant')).getBoundingClientRect(),p=document.querySelector('[role="listbox"]').getBoundingClientRect();return a.bottom<=p.bottom+1 && a.top>=p.top-1})()`,
      ),
      true,
    );
    writeFileSync(
      path.join(root, `ui-${width}x${height}-last-option.png`),
      (await wc.capturePage()).toPNG(),
    );
    wc.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    wc.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    await until(`!document.querySelector('[role="listbox"]')`);
    assert.equal(
      await evaluate(`document.activeElement.matches('[role="combobox"]')`),
      true,
    );
    await evaluate(
      `[...document.querySelectorAll('input[type="radio"]')][1].click()`,
    );
    await until(`!!document.querySelector('.topic-new-row')`);
    await evaluate(
      `new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`,
    );
    const created = await evaluate(
      `(()=>{const fields=[...document.querySelectorAll('.topic-new-row input,.topic-new-row select')].map(e=>e.getBoundingClientRect());return {heights:fields.map(r=>r.height),stacked:fields[1].top>fields[0].bottom,overflow:document.querySelector('.scroll-area').scrollWidth>document.querySelector('.scroll-area').clientWidth,sourceCount:document.querySelectorAll('.topic-new-row select').length,modeCount:document.querySelectorAll('input[type="radio"]').length,workspace:document.querySelector('#workspace').textContent}})()`,
    );
    assert.equal(created.heights[0], created.heights[1]);
    assert.equal(created.stacked, width <= 1000);
    assert.equal(created.overflow, false);
    assert.equal(created.sourceCount, 1);
    assert.equal(created.modeCount, 2);
    assert.equal(created.workspace, "Мой компьютер");
    writeFileSync(
      path.join(root, `ui-${width}x${height}-new.png`),
      (await wc.capturePage()).toPNG(),
    );
    await evaluate(
      `[...document.querySelectorAll('input[type="radio"]')][0].click()`,
    );
    await until(`!!document.querySelector('[role="combobox"]')`);
    result.sizes.push({
      created,
      width,
      height,
      closed,
      open,
      escapeRestoredFocus: true,
      endOptionVisibleWithoutOuterScroll: true,
    });
  }
  // Real native modal/focus semantics on disposable renderer data only.
  win.setSize(1320, 1000);
  const setTask = (text: string) =>
    evaluate(
      `(()=>{const e=document.querySelector('.task-editor textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
  const clickText = (text: string) =>
    evaluate(
      `[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)}).click()`,
    );
  const editorText = () =>
    evaluate(`document.querySelector('.task-editor textarea').value`);
  const modalOpen = `!!document.querySelector('dialog[open]')`;
  const paint = () =>
    evaluate(
      `new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`,
    );
  await setTask("Несохранённый тестовый черновик");
  await until(
    `[...document.querySelectorAll('button')].some(b=>b.textContent==='Сохранить и запустить')`,
  );
  const readsBefore = await evaluate("window.fixtureControl.calls()");
  await clickText("Перечитать задачу");
  await until(modalOpen);
  assert.equal(
    await evaluate("document.activeElement.textContent.trim()"),
    "Отмена",
  );
  assert.equal(
    await evaluate(`document.querySelectorAll('textarea').length`),
    1,
  );
  await paint();
  writeFileSync(
    path.join(root, "reload-confirmation.png"),
    (await wc.capturePage()).toPNG(),
  );
  win.setSize(920, 700);
  await paint();
  assert.equal(
    await evaluate(
      `(()=>{const r=document.querySelector('dialog').getBoundingClientRect();return r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight})()`,
    ),
    true,
  );
  writeFileSync(
    path.join(root, "reload-confirmation-small.png"),
    (await wc.capturePage()).toPNG(),
  );
  wc.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  wc.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
  await until(`!(${modalOpen})`);
  assert.equal(await editorText(), "Несохранённый тестовый черновик");
  assert.equal(await evaluate("window.fixtureControl.calls()"), readsBefore);
  win.setSize(1320, 1000);
  await evaluate(`window.fixtureControl.mode('error')`);
  await clickText("Перечитать задачу");
  await until(modalOpen);
  await clickText("Перечитать и сбросить");
  await until(`document.body.textContent.includes('Fixture read failed')`);
  assert.equal(await editorText(), "Несохранённый тестовый черновик");
  assert.equal(
    await evaluate(`document.querySelectorAll('textarea').length`),
    1,
  );
  await evaluate(
    `document.querySelector('.task-editor').scrollIntoView({block:'center'})`,
  );
  await paint();
  writeFileSync(
    path.join(root, "reload-error-preserved.png"),
    (await wc.capturePage()).toPNG(),
  );
  await evaluate(`window.fixtureControl.mode('deferred')`);
  await clickText("Перечитать задачу");
  await until(modalOpen);
  await clickText("Перечитать и сбросить");
  await until(`window.fixtureControl.calls()===${readsBefore + 2}`);
  assert.equal(await editorText(), "Несохранённый тестовый черновик");
  await evaluate(
    `window.fixtureControl.finish('Актуальная задача из тестового файла')`,
  );
  await until(
    `document.querySelector('.task-editor textarea').value==='Актуальная задача из тестового файла'`,
  );
  await evaluate(`window.fixtureControl.mode('success')`);
  await clickText("Перечитать задачу");
  await until(`window.fixtureControl.calls()===${readsBefore + 3}`);
  assert.equal(await evaluate(modalOpen), false);
  await until(
    `document.querySelector('.task-editor textarea').value.includes('Задача выбранного топика')`,
  );
  await clickText("Перечитать задачу");
  await until(`window.fixtureControl.calls()===${readsBefore + 4}`);
  assert.equal(
    await evaluate(`document.querySelectorAll('textarea').length`),
    1,
  );
  result.reload = {
    nativeModal: true,
    cancelDefaultFocus: true,
    escapePreservesDraft: true,
    errorPreservesText: true,
    confirmedSuccessReplaces: true,
    cleanNoDialog: true,
    singleEditorAfterRepeatedReads: true,
  };
  // Full form reset is one transaction; use only the fake API above.
  const formValues = () =>
    evaluate(`(()=>({
    task:document.querySelector('.task-editor textarea').value,
    selects:[...document.querySelectorAll('fieldset select')].map(e=>e.value),
    checks:[...document.querySelectorAll('fieldset input[type="checkbox"]')].map(e=>e.checked),
    topic:document.querySelector('[role="combobox"]')?.textContent
  }))()`);
  const setSelect = (selector: string, value: string) =>
    evaluate(
      `(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
  await setTask("Черновик перед сбросом формы");
  await setSelect(".form-grid label:first-child select", "none");
  await until(`!document.body.textContent.includes('Получаем состав у Goga')`);
  await setSelect(".form-grid label:last-child select", "personal");
  await until(`!document.body.textContent.includes('Получаем состав у Goga')`);
  await evaluate(`document.querySelector('.stage-card input').click()`);
  await until(`!document.body.textContent.includes('Получаем состав у Goga')`);
  await evaluate(
    `document.querySelector('[aria-describedby="clean-warning"]').click();document.querySelector('.confirmation input').click()`,
  );
  await paint();
  const dirtyForm = await formValues();
  const resetReads = await evaluate("window.fixtureControl.calls()");
  const sideEffects = await evaluate("window.fixtureControl.apiCalls()");
  await clickText("Сбросить");
  await until(modalOpen);
  assert.equal(
    await evaluate("document.activeElement.textContent.trim()"),
    "Отмена",
  );
  assert.equal(
    await evaluate(`document.querySelector('dialog h2').textContent`),
    "Сбросить форму?",
  );
  await paint();
  writeFileSync(
    path.join(root, "reset-confirmation.png"),
    (await wc.capturePage()).toPNG(),
  );
  win.setSize(920, 700);
  await paint();
  assert.equal(
    await evaluate(
      `(()=>{const r=document.querySelector('dialog').getBoundingClientRect();return r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight})()`,
    ),
    true,
  );
  writeFileSync(
    path.join(root, "reset-confirmation-small.png"),
    (await wc.capturePage()).toPNG(),
  );
  wc.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  wc.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
  await until(`!(${modalOpen})`);
  assert.deepEqual(await formValues(), dirtyForm);
  assert.equal(await evaluate("window.fixtureControl.calls()"), resetReads);
  assert.deepEqual(
    await evaluate("window.fixtureControl.apiCalls()"),
    sideEffects,
  );
  await clickText("Сбросить");
  await until(modalOpen);
  await clickText("Отмена");
  await until(`!(${modalOpen})`);
  assert.deepEqual(await formValues(), dirtyForm);
  assert.deepEqual(
    await evaluate("window.fixtureControl.apiCalls()"),
    sideEffects,
  );
  await evaluate(`window.fixtureControl.mode('error')`);
  await clickText("Сбросить");
  await until(modalOpen);
  await clickText("Сбросить изменения");
  await until(`document.body.textContent.includes('Fixture read failed')`);
  assert.deepEqual(await formValues(), dirtyForm);
  await evaluate(`window.fixtureControl.mode('deferred')`);
  await clickText("Сбросить");
  await until(modalOpen);
  await clickText("Сбросить изменения");
  await until(`window.fixtureControl.calls()===${resetReads + 2}`);
  assert.deepEqual(await formValues(), dirtyForm);
  await evaluate(
    `window.fixtureControl.finish('Новая задача после полного сброса')`,
  );
  await until(
    `document.querySelector('.task-editor textarea').value==='Новая задача после полного сброса'`,
  );
  const resetForm = await formValues();
  assert.deepEqual(resetForm.selects, ["review", "auto", ""]);
  assert.deepEqual(resetForm.checks, [true, false, false]);
  assert.equal(resetForm.topic, dirtyForm.topic);
  assert.equal(
    await evaluate(`document.querySelectorAll('textarea').length`),
    1,
  );
  const afterReset = await evaluate("window.fixtureControl.apiCalls()");
  assert.equal(afterReset.checkout, sideEffects.checkout);
  assert.equal(afterReset.launch, 0);
  await evaluate(
    `document.querySelector('.task-editor').scrollIntoView({block:'center'})`,
  );
  await paint();
  writeFileSync(
    path.join(root, "reset-success.png"),
    (await wc.capturePage()).toPNG(),
  );
  // The clean reset runs directly and adopts its single prepared preview.
  await evaluate(`window.fixtureControl.mode('success')`);
  await clickText("Сбросить");
  await until(`window.fixtureControl.calls()===${resetReads + 3}`);
  await until(
    `document.querySelector('.task-editor textarea').value.includes('Задача выбранного топика')`,
  );
  assert.equal(await evaluate(modalOpen), false);
  assert.equal(
    (await evaluate("window.fixtureControl.apiCalls()")).preview,
    afterReset.preview + 1,
  );
  result.reset = {
    nativeModal: true,
    cancelDefaultFocus: true,
    escapePreservesAllValues: true,
    cancelPreservesAllValues: true,
    cancelPerformsNoReads: true,
    readErrorPreservesAllValues: true,
    deferredSuccessAtomic: true,
    defaultParametersAndConsents: true,
    exactTopicPreserved: true,
    noCheckoutOrLaunch: true,
    cleanNoDialog: true,
    singlePreparedPreview: true,
    singleEditor: true,
  };
  assert.equal(win.isVisible(), false);
  win.destroy();
  writeFileSync(
    path.join(root, "result.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify({ ok: true, root }));
  clearTimeout(watchdog);
  app.exit(0);
})().catch((e) => {
  console.error(e);
  app.exit(1);
});
