/**
 * qzone-diary · 评论扫描（在 Ego 里跑）
 *
 * 由宿主插件通过 `ego-browser nodejs -e "import('file:///…/scan.mjs')"` 载入；
 * 账号从 QZONE_UIN 读，结果打印一行 `SCAN4 <json>`。
 * 只读页面、不发任何评论——回复永远由人决定。
 */
const UIN = String(process.env.QZONE_UIN || globalThis.__QZONE_UIN || "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const task = await taskSpace('qzone-diary');
const page = task.page('p1');

async function quickLogin() {
  try {
    await page.goto(`https://i.qq.com/?s_url=${encodeURIComponent(`http://user.qzone.qq.com/${UIN}`)}`);
  } catch {}
  let base = null;
  for (let i = 0; i < 6 && !base; i++) {
    await sleep(3500);
    base = await page.evaluate(() => {
      const f = document.querySelector('iframe');
      if (!f) return null;
      const b = f.getBoundingClientRect();
      if (b.width < 100) return null;
      return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
    });
  }
  if (!base) return false;
  await page.mouse.click(Math.round(base.x + base.w * 0.545), Math.round(base.y + base.h * 0.536));
  await sleep(8000);
  const u = await page.evaluate(() => location.href);
  return u.includes(UIN);
}

async function scan() {
  return page.evaluate(() => {
    const res = [];
    for (const item of document.querySelectorAll('.f-item, li.f-s-s.f-single')) {
      const tid = item.querySelector('i[data-tid]')?.getAttribute('data-tid');
      if (!tid || tid === '0') continue;
      const list = item.querySelector('.comments-list');
      if (!list) continue;
      const cs = [];
      for (const li of list.querySelectorAll('li.comments-item')) {
        const nick = li.getAttribute('data-nick') || '';
        const uin = li.getAttribute('data-uin') || '';
        const cid = li.getAttribute('data-tid') || '';
        const imgs = Array.from(li.querySelectorAll("img[src*='qpic']")).map((i) => i.src);
        const content = li.querySelector('.comments-content');
        let text = content ? (content.innerText || '').replace(/\s+/g, ' ').trim() : '';
        if (nick) text = text.replace(nick, '').replace(/^\s*:\s*/, '').trim();
        const timeM = (li.innerText || '').match(/\d{1,2}:\d{2}/);
        cs.push({ cid, uin, nick, text: text.slice(0, 160), imgs: imgs.slice(0, 3), time: timeM ? timeM[0] : '' });
      }
      if (cs.length) res.push({ tid, comments: cs });
    }
    return res;
  });
}

let data = [];
for (let attempt = 0; attempt < 2; attempt++) {
  try {
    await page.goto(`https://user.qzone.qq.com/${UIN}`);
  } catch {}
  await sleep(10000);
  await page.evaluate(() => window.scrollTo(0, 500));
  await sleep(2000);
  data = await scan();
  if (Array.isArray(data) && data.length > 0) break;
  const ok = await quickLogin();
  console.log('RELOGIN ' + ok);
  if (!ok) break;
}
console.log('SCAN4 ' + JSON.stringify(data));
