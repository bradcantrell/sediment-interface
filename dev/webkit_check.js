// The pages in WebKit (Safari's engine), desktop and iPhone/iPad emulation, through
// Playwright. Not part of the headless harness: it needs a real browser engine.
//
//   PLAYWRIGHT_CORE=<path to playwright-core> WEBKIT_EXE=<Playwright WebKit pw_run.sh> \
//     node dev/webkit_check.js <page URL> [<page URL> ...]
//
// Serve the pages over http (python3 -m http.server), not file://, which logs cross-origin
// messages a real site never shows. playwright-core and the WebKit build must match
// (1.58.0 ships WebKit 2248). Where they live on our machines is in AGENTS.local.md.
//
// For each page and device: no page errors; the model steps and the grains move; a tap (or a
// click) places an object; the flow stays finite; selecting an object brings up the height
// slider, which sets its top; on the river, a wall across the channel spills. Exits 1 on any
// failure.
const pw = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const urls = process.argv.slice(2);
if (!urls.length) { console.error('usage: node dev/webkit_check.js <page URL> ...'); process.exit(2); }
let fails = 0;
const check = (ok, what, detail) => { console.log((ok ? '  PASS  ' : '  FAIL  ') + what + (detail ? '  (' + detail + ')' : '')); if (!ok) fails++; };

async function one(url, device) {
  const b = await pw.webkit.launch(process.env.WEBKIT_EXE ? { executablePath: process.env.WEBKIT_EXE } : {});
  const ctx = await b.newContext(device ? pw.devices[device] : { viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage(), errs = [];
  p.on('pageerror', e => errs.push(e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  await p.goto(url);
  await p.waitForTimeout(2500);
  const tag = `${url.split('/').slice(-2, -1)[0]}, ${device || 'desktop 1440x900'}`;
  const t0 = await p.evaluate('simTime');
  await p.evaluate("typeof setPaused === 'function' ? setPaused(false) : (paused = false)");
  const xs0 = await p.evaluate('particles.slice(0, 200).map(q => q.x)');
  await p.waitForTimeout(4000);
  const t1 = await p.evaluate('simTime'), xs1 = await p.evaluate('particles.slice(0, 200).map(q => q.x)');
  const moved = xs0.filter((x, i) => Math.abs(x - xs1[i]) > 0.5).length;
  check(t1 > t0 && moved > 150, `${tag}: the model steps and the grains move`, `sim time ${t0.toFixed(1)} -> ${t1.toFixed(1)}, ${moved} of 200 moved`);
  // The largest canvas is the scene (the sidebar has a small 3D one).
  const boxes = (await Promise.all((await p.locator('canvas').all()).map(c => c.boundingBox()))).filter(Boolean);
  const box = boxes.sort((a, c) => c.width * c.height - a.width * a.height)[0];
  const n0 = await p.evaluate('obstacles.length'), px = box.x + box.width * 0.6, py = box.y + box.height * 0.5;
  if (device) await p.touchscreen.tap(px, py); else await p.mouse.click(px, py);
  await p.waitForTimeout(800);
  const n1 = await p.evaluate('obstacles.length');
  check(n1 === n0 + 1, `${tag}: a ${device ? 'tap' : 'click'} places an object`, `${n0} -> ${n1}`);
  // The height slider, on the object just placed.
  const hasH = await p.evaluate('!!(model.objectHeight) && obHasHeight(obstacles[obstacles.length - 1])');
  if (hasH) {
    await p.evaluate('selectedIdx = obstacles.length - 1');
    await p.waitForTimeout(400);
    const sb = await p.locator('#ob-height-slider').boundingBox();
    let top = null;
    if (sb) {
      if (device) await p.touchscreen.tap(sb.x + 2, sb.y + sb.height / 2);
      else { await p.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2); await p.mouse.down(); await p.mouse.move(sb.x + 1, sb.y + sb.height / 2, { steps: 8 }); await p.mouse.up(); }
      await p.waitForTimeout(500);
      top = await p.evaluate('obstacles[selectedIdx].top');
    }
    const min = await p.evaluate('model.objectHeight.min');
    check(sb && Math.abs(top - min) < 1e-9, `${tag}: the height slider comes up and sets the top`, sb ? `top ${top}, slider's lowest ${min}` : 'no slider');
  }
  check(await p.evaluate('(() => { for (let k = 0; k < u.length; k++) if (!Number.isFinite(u[k]) || !Number.isFinite(v[k])) return false; return true; })()'),
        `${tag}: the flow stays finite`);
  if (await p.evaluate("model.id === 'river'")) {
    await p.evaluate("obstacles = [{ type: 'rect', x: width * 0.5, y: height / 2, w: 40, h: height * 3, rotation: 0, clips: [{ start: 0, dur: 1e9 }] }]; solidMaskDirty = true");
    await p.waitForTimeout(8000);
    const dam = await p.evaluate('({ spilling: mac.spilling, passable: !!model.passable })');
    check(dam.spilling && dam.passable, `${tag}: a wall across the river spills`, JSON.stringify(dam));
  }
  check(errs.length === 0, `${tag}: no page errors`, errs.slice(0, 3).join(' | '));
  await b.close();
}

(async () => {
  for (const url of urls) for (const d of [null, 'iPhone 13', 'iPad Pro 11']) await one(url, d);
  console.log(fails ? `WEBKIT FAIL — ${fails}` : 'WEBKIT PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
