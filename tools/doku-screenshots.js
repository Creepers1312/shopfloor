// Erzeugt die Bilder der Anwenderdoku (frontend/docs/*.webp) im lokalen Modus mit Testdaten.
// Aufruf aus dem Projektordner:  node tools/doku-screenshots.js
// Braucht Playwright (Chromium) und Python mit Pillow für die Umwandlung nach WebP.
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const R = fs.mkdtempSync(path.join(os.tmpdir(), 'doku-')) + '/';
const W = 1440, H = 900;
(async () => {
  const b = await chromium.launch({ args: ['--lang=de-DE'] });
  const ctx = await b.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, colorScheme: 'light', locale: 'de-DE' });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  const wait = (ms) => p.waitForTimeout(ms);
  const shot = async (name, opt = {}) => { await p.screenshot({ path: R + name + '.png', ...opt }); console.log('✓', name); };
  const box = async (sel, pad = 16) => { const r = await p.locator(sel).first().boundingBox(); return { x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), width: Math.min(W, r.width + 2 * pad), height: r.height + 2 * pad }; };
  await p.goto('file://' + path.join(ROOT, 'frontend/index.html')); await wait(1200);
  await shot('anmeldung', { clip: await box('.login-card', 24) });
  await p.click('#modeToggle'); await p.fill('#lFull', 'Anna Admin'); await p.fill('#lName', 'anna');
  await p.fill('#lPass', 'geheim-12345'); await p.fill('#lPass2', 'geheim-12345'); await p.click('#loginSubmit'); await wait(1800);
  await p.mouse.move(W - 5, H - 5);
  await shot('kopfzeile', { clip: { x: 0, y: 0, width: W, height: 96 } });
  await shot('dashboard');
  await p.click('#dashManageBtn'); await wait(400); await shot('dashboards-verwalten', { clip: await box('dialog[open]', 28) }); await p.click('#dlClose');
  await p.click('#dashEditBtn'); await wait(400);
  await p.evaluate(() => scrollTo(0, document.querySelector('#dashToolbar').getBoundingClientRect().top + scrollY - 16)); await wait(300);
  await shot('dashboard-anpassen');
  await p.click('#dashAddBtn'); await wait(400); await shot('widget-hinzufuegen', { clip: await box('dialog[open]', 28) }); await p.keyboard.press('Escape'); await wait(200);
  await p.click('#dashEditDone'); await p.evaluate(() => scrollTo(0, 0));
  // SQIDP-Board
  await p.click('.tab[data-view="board"]'); await wait(600); await shot('sqidp-board');
  await p.locator('#view-board button.cell.nok').nth(3).click(); await wait(400); await shot('board-tag', { clip: await box('dialog[open]', 28) }); await p.keyboard.press('Escape'); await wait(200);
  // Huddle
  await p.click('.tab[data-view="huddle"]'); await wait(500); await shot('huddle-kalender');
  await p.click('.huddle-cal-day:has-text("23")'); await wait(800); await shot('huddle-kennzahlen');
  await p.click('#dtab-prod'); await wait(300); await shot('huddle-produktion');
  await p.click('#dailyDlgClose'); await wait(500);
  await shot('huddle-runde');
  await p.locator('#agendaList .agenda-item').nth(1).click(); await wait(600); await shot('huddle-agenda');
  await p.click('#agOk'); await wait(300);
  await p.locator('#agendaList .agenda-item').nth(4).click(); await wait(600); await shot('huddle-produktivitaet');
  await p.click('#agOk'); await wait(300);
  if (await p.isVisible('#huddleRevBtn')) { await p.click('#huddleRevBtn'); await wait(600); await shot('revision', { clip: await box('dialog[open]', 28) }); await p.keyboard.press('Escape'); await wait(300); }
  else console.log('Revision-Knopf nicht sichtbar');
  // Maßnahmen
  await p.click('.tab[data-view="actions"]'); await wait(600); await shot('massnahmen');
  await p.locator('#kanban .kcard').first().click(); await wait(500); await shot('abweichung', { clip: await box('dialog[open]', 28) }); await p.keyboard.press('Escape'); await wait(200);
  // Tracking, Bericht
  await p.click('.tab[data-view="tracking"]'); await wait(800); await shot('tracking');
  await p.click('.tab[data-view="report"]'); await wait(500); await p.click('#reportPrev'); await wait(600); await shot('tagesbericht');
  // Einstellungen
  await p.click('.tab[data-view="settings"]'); await wait(500);
  for (const [pane, name] of [['stamm', 'stammdaten'], ['users', 'benutzer'], ['mail', 'email'], ['db', 'datenbank']]) {
    await p.click(`.side-item[data-spane="${pane}"]`); await wait(500); await shot(name);
  }
  // TV-Modus
  await p.click('#tvBtn'); await wait(1200); await shot('tv-modus'); await p.keyboard.press('Escape');
  console.log(errs.join('\n') || 'keine Seitenfehler');
  await b.close();
  // PNG → WebP (Qualität 80) nach frontend/docs/
  execFileSync('python3', ['-c', [
    'import sys, glob, os', 'from PIL import Image',
    'for f in glob.glob(os.path.join(sys.argv[1], "*.png")):',
    '    Image.open(f).convert("RGB").save(os.path.join(sys.argv[2], os.path.basename(f)[:-4] + ".webp"), "WEBP", quality=80, method=6)'
  ].join('\n'), R, path.join(ROOT, 'frontend/docs')], { stdio: 'inherit' });
  fs.rmSync(R, { recursive: true, force: true });
  console.log('Bilder aktualisiert: frontend/docs/');
})();
