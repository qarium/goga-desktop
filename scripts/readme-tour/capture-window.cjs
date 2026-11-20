const { app, BrowserWindow, nativeImage, session } = require('electron');
const fs = require('node:fs'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const [scratch, renderer, output, locale] = process.argv.slice(-4);
const labels = JSON.parse(fs.readFileSync(path.join(__dirname, 'ui-' + locale + '.json')));
const story = JSON.parse(fs.readFileSync(path.join(__dirname, 'scenario.json')));
const [width, height] = story.viewport;
let frame = 0;
app.setName('Goga README tour');
for (const key of ['userData', 'sessionData', 'crashDumps']) app.setPath(key, path.join(scratch, key));
app.setAppLogsPath(path.join(scratch, 'logs'));
app.commandLine.appendSwitch('lang', locale);
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.disableHardwareAcceleration();
let win, phase = 'loading renderer';
const timeout = setTimeout(() => { console.error('Tour deadline: ' + phase); app.exit(1); }, 75000);
const pause = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  await app.whenReady();
  app.dock?.hide();
  const ses = session.fromPartition('readme-tour'); // in-memory and unique to this fixture process
  const base = pathToFileURL(renderer + path.sep).href;
  ses.webRequest.onBeforeRequest((details, next) => next({
    cancel: !(details.url.startsWith(base) || details.url.startsWith('data:') || details.url === 'about:blank')
  }));
  ses.setPermissionRequestHandler((_contents, _permission, respond) => respond(false));
  win = new BrowserWindow({
    show: false, width, height, enableLargerThanScreen: true, useContentSize: true, frame: false,
    webPreferences: { session: ses, additionalArguments: ['--goga-tour-language='+locale], preload: path.join(__dirname, 'fixture.cjs'), sandbox: true,
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  const wc = win.webContents;
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', event => event.preventDefault());
  wc.on('preload-error', (_event, _file, error) => console.error('Fixture preload:', error.message));
  const js = code => wc.executeJavaScript(code, true);
  async function until(code) {
    for (let i = 0; i < 150; ++i) { if (await js(code)) return; await pause(50); }
    throw Error('Timed out in ' + phase + ': ' + code);
  }
  // Actions are stable selectors; only the small locale pack contains translated labels.
  function element(selector, caption) {
    return `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(e =>
      e.getClientRects().length && !e.closest('[hidden]') && !e.matches(':disabled') &&
      (!${JSON.stringify(caption || '')} || [e.textContent, e.getAttribute('aria-label')].some(t => t?.trim().startsWith(${JSON.stringify(caption || '')}))))`;
  }
  async function click(selector, caption) {
    const expr = element(selector, caption);
    await until('!!(' + expr + ')'); await js('(' + expr + ').click()');
  }
  async function shot(id) {
    if (id !== story.scenes[frame++]?.id) throw Error('Unexpected storyboard scene: ' + id);
    await js('document.fonts.ready.then(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))');
    const image = await wc.capturePage(undefined, { stayHidden: true });
    const source = image.toPNG();
    const w = source.readUInt32BE(16), h = source.readUInt32BE(20);
    if (w * height !== h * width) throw Error('Unexpected capture dimensions: ' + w + 'x' + h);
    const data = w === width ? source : nativeImage.createFromBuffer(source).resize({ width, height, quality: 'best' }).toPNG();
    if (data.readUInt32BE(16) !== width || data.readUInt32BE(20) !== height) throw Error('Unexpected output dimensions');
    fs.writeFileSync(path.join(output, id + '.png'), data);
    console.log('Captured ' + id);
  }
  await win.loadFile(path.join(renderer, 'index.html'));
  await until('!!document.querySelector("#root > *")');
  const pageLocale = await js('document.documentElement.lang');
  if (pageLocale !== locale) throw Error('Built renderer language (' + pageLocale + ') does not match requested UI (' + locale + ')');
  phase = 'project list';
  await until('document.querySelectorAll(".ps-group .ps-row").length >= 2');
  await shot('projects');
  phase = 'add project menu';
  await click('.ps-heading button', labels.add);
  await until('!!(' + element('.project-list-menu [role=menuitem]', labels.createNew) + ')');
  await shot('add-project');
  await click('.project-list-menu [role=menuitem]', labels.openExisting);
  phase = 'group Field Notes';
  const field = '[data-project-target="field-notes"]';
  await click(field + ' .ps-more');
  await until('!!(' + element('.project-list-menu [role=menuitem]', labels.moveToStudio) + ')');
  await shot('move-project');
  await click('.project-list-menu [role=menuitem]', labels.moveToStudio);
  await until('!!document.querySelector(\'.ps-group .ps-members [data-project-target="field-notes"]\') && !document.querySelector(".project-list-menu")');
  await shot('group');
  phase = 'overview';
  await click(field + ' .project-button');
  await click('.topics-nav', labels.overview);
  await until('!!(' + element('.ov-tree-name') + ')');
  await shot('overview');
  phase = 'topic board';
  await click('.topics-nav', labels.topics);
  await click('.topic-view-switch button', labels.board);
  await until('!!(' + element('.topic-board-card') + ')');
  await shot('board');
  phase = 'launch menu';
  await click('.context-launch-trigger');
  for (const label of [labels.pipeline, labels.build, labels.demo]) await until('!!(' + element('.context-launch-menu [role=menuitem]', label) + ')');
  await shot('launch-menu');
  phase = 'refinement form';
  await click('.context-launch-menu [role=menuitem]', labels.pipeline);
  const combo = '.launch-panel [role=combobox]';
  await click(combo);
  for (const id of ['development','refinement']) await until('!!(' + element('.launch-panel [role=option][value=' + id + ']') + ')');
  await shot('choose-refinement');
  await click('.launch-panel [role=option][value=refinement]');
  await until(`!!(${element('.stage-card')}) && !document.querySelector('.stage-cards[aria-busy=true]') && !!(${element('.split-launch-main')})`);
  // The selected pipeline and its four real stage names must be visible together.
  await js('document.querySelector(".launch-panel [role=combobox]").scrollIntoView({block:"start",behavior:"instant"})');
  await until(`document.querySelector(".launch-panel [role=combobox]").textContent.includes("refinement")
    && ["define","discover","specify","review"].every(name => Array.from(document.querySelectorAll(".stage-card strong")).some(card => card.textContent.trim() === name))
    && document.querySelectorAll(".stage-card").length === 4
    && Array.from(document.querySelectorAll(".stage-card")).every(card => card.getBoundingClientRect().bottom <= innerHeight)`);
  await shot('refinement');
  phase = 'completed sample run';
  await click('.split-launch-main');
  await until(`document.body.innerText.includes('Refinement complete.')`);
  await shot('run');
  if (frame !== story.scenes.length) throw Error('Incomplete storyboard');
  clearTimeout(timeout); win.destroy(); app.quit();
})().catch(async error => {
  console.error(error);
  if (win && !win.isDestroyed()) {
    // The fixture contains synthetic data only. Never dump a real application window.
    console.error('Fixture screen:', (await win.webContents.executeJavaScript('document.body.innerText')).slice(-4500));
  }
  clearTimeout(timeout); app.exit(1);
});
