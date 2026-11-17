const CONFIG = /*__CONFIG__*/;

const PREFIX = "QZONE_RESULT ";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const norm = (value) => String(value || "").replace(/[\s\u3000]+/g, "");
const fs = await import("node:fs/promises");

let stage = "init";
let page = null;

async function screenshot() {
  try {
    if (!page) return null;
    const temp = await page.screenshot();
    if (!temp) return null;
    if (CONFIG.shot) {
      await fs.copyFile(temp, CONFIG.shot);
      return CONFIG.shot;
    }
    return temp;
  } catch {
    return null;
  }
}

async function checkLogin() {
  return await page.evaluate(() => {
    const text = document.body.innerText || "";
    return {
      url: location.href,
      loggedIn: text.includes("说点儿什么吧") || !!document.querySelector("a.btn-post"),
      loginBox: /扫码登录|QQ登录|帐号密码登录/.test(text),
    };
  });
}

async function waitFor(fn, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await sleep(500);
  }
  return null;
}

async function main() {
  const task = await taskSpace("qzone-auto-post");
  page = task.page("p1");

  stage = "navigate";
  try {
    await page.goto(CONFIG.mainUrl);
  } catch {
    // qzone often keeps loading third-party resources; continue with a usable DOM
  }
  await sleep(2500);

  stage = "login";
  let login = await checkLogin();
  if (CONFIG.loginOnly) {
    const end = Date.now() + CONFIG.loginWaitMs;
    while (!login.loggedIn && Date.now() < end) {
      await sleep(5000);
      login = await checkLogin();
    }
    return login.loggedIn
      ? { ok: true, loggedIn: true, accountOk: login.url.includes(`/${CONFIG.uin}`), uin: CONFIG.uin, url: login.url }
      : { ok: false, stage: "login", error: "LOGIN_TIMEOUT", url: login.url };
  }
  if (!login.loggedIn) {
    return { ok: false, stage: "login", error: "NOT_LOGGED_IN", detail: login };
  }
  const accountOk = login.url.includes(`/${CONFIG.uin}`);
  if (CONFIG.statusOnly) {
    return { ok: true, loggedIn: true, accountOk, uin: CONFIG.uin, url: login.url };
  }
  if (!accountOk) {
    return {
      ok: false,
      stage: "account",
      error: "WRONG_ACCOUNT",
      detail: login.url,
      hint: `当前登录的不是 ${CONFIG.uin}`,
    };
  }

  const target = norm(CONFIG.text).slice(0, 24);
  const since = Math.floor(Date.now() / 1000) - CONFIG.dedupeMinutes * 60;

  if (CONFIG.dedupeMinutes > 0) {
    stage = "dedupe";
    await waitFor(
      async () =>
        await page.evaluate(
          () => document.querySelectorAll(".f-item i[data-tid]").length >= 2,
        ),
      10000,
    );
    const duplicate = await page.evaluate(
      (target) => {
        const clean = (value) => String(value || "").replace(/[\s\u3000]+/g, "");
        for (const item of document.querySelectorAll(".f-item")) {
          const tid = item.querySelector("i[data-tid]")?.getAttribute("data-tid");
          if (!tid || tid === "0") continue;
          const info = item.querySelector(".f-info");
          const text = clean(info ? info.innerText : item.innerText);
          if (text.includes(target)) {
            return { tid, text: text.slice(0, 80) };
          }
        }
        return null;
      },
      target,
    );
    if (duplicate) {
      return {
        ok: true,
        duplicate: true,
        url: `${CONFIG.baseUrl}/mood/${duplicate.tid}.1`,
        tid: duplicate.tid,
      };
    }
  }

  stage = "editor";
  const editorSel = '[id="$1_content_content"]';
  const editorVisible = async () =>
    await page.evaluate((selector) => {
      const el = document.querySelector(selector);
      return !!el && !!el.offsetHeight;
    }, editorSel);

  if (!(await editorVisible())) {
    await page.click("text=说点儿什么吧");
    const opened = await waitFor(editorVisible, 15000);
    if (!opened) {
      return { ok: false, stage: "editor", error: "EDITOR_NOT_FOUND" };
    }
  }

  // remove anything left by an earlier aborted run
  await page.fill(editorSel, "");
  await page.evaluate(() => {
    document.querySelectorAll(".img-item a.icon-img-remove").forEach((el) => el.click());
  });
  await sleep(300);

  stage = "fill";
  // fill 对 contenteditable 不保留连续换行：段与段之间的空行会被吞成一个。
  // 改为按空行切段，段之间补两次真 Enter（2026-11-17 修复，来源 qzone-poster）。
  {
    const paras = String(CONFIG.text).split(/
{2,}/);
    await page.click(editorSel);
    for (let i = 0; i < paras.length; i += 1) {
      if (i > 0) {
        await page.keyboard.press("Enter");
        await page.keyboard.press("Enter");
      }
      if (paras[i]) await page.keyboard.type(paras[i], { delay: 6 });
    }
  }
  const filled = await waitFor(async () => {
    const text = await page.evaluate((selector) => document.querySelector(selector)?.innerText || "", editorSel);
    return norm(text).includes(target);
  }, 5000);
  if (!filled) {
    return { ok: false, stage: "fill", error: "TEXT_NOT_INSERTED" };
  }

  let imageUploaded = false;
  if (CONFIG.image) {
    stage = "upload";
    try {
      await page.setInputFiles('input[type="file"][accept*="image"]', [CONFIG.image]);
    } catch (error) {
      return { ok: false, stage: "upload", error: "FILE_INPUT_NOT_FOUND", detail: String(error).slice(0, 300) };
    }
    const uploaded = await waitFor(async () => {
      const state = await page.evaluate(() => {
        const items = Array.from(document.querySelectorAll(".img-item"));
        const hint = items.map((item) => item.querySelector(".action-bar-hint-text")?.innerText || "").join("|");
        const hasImage = items.some((item) => item.querySelector("img"));
        const error = (document.body.innerText.match(/上传失败|图片格式不支持|图片过大|超过大小限制/) || [])[0] || null;
        return { hasImage, hint, error };
      });
      if (state.error) return { error: state.error };
      if (state.hasImage && /上传成功/.test(state.hint)) return { ok: true };
      if (state.hasImage && !state.hint) return { ok: true };
      return null;
    }, 45000);
    if (!uploaded) {
      return { ok: false, stage: "upload", error: "UPLOAD_TIMEOUT", screenshot: await screenshot() };
    }
    if (uploaded.error) {
      return { ok: false, stage: "upload", error: "UPLOAD_FAILED", detail: uploaded.error, screenshot: await screenshot() };
    }
    imageUploaded = true;
  }

  if (CONFIG.dryRun) {
    const shot = await screenshot();
    await page.fill(editorSel, "");
    await page.evaluate(() => {
      document.querySelectorAll(".img-item a.icon-img-remove").forEach((el) => el.click());
      document.querySelector("a.btn-dismiss-post")?.click();
    });
    await sleep(700);
    try {
      await page.goto(CONFIG.mainUrl);
    } catch {}
    return { ok: true, dryRun: true, imageUploaded, screenshot: shot };
  }

  stage = "publish";
  const startSec = Math.floor(Date.now() / 1000);
  const receipt = await page.click("a.btn-post");
  if (receipt && receipt.dialog) {
    await page.acceptDialog();
  }

  const closed = await waitFor(async () => !(await editorVisible()), 25000);
  if (!closed) {
    const detail = await page.evaluate(() => {
      const text = document.body.innerText || "";
      return (text.match(/内容为空|不能为空|发表失败|验证码|操作频繁|安全验证/) || [])[0] || null;
    });
    return {
      ok: false,
      stage: "publish",
      error: detail ? "PUBLISH_REJECTED" : "PUBLISH_NOT_CLOSED",
      detail,
      screenshot: await screenshot(),
    };
  }

  stage = "verify";
  let found = null;
  for (let attempt = 0; attempt < 3 && !found; attempt += 1) {
    await sleep(1200 + attempt * 1200);
    try {
      await page.goto(CONFIG.mainUrl);
    } catch {}
    await sleep(2800);
    found = await page.evaluate(
      ({ target, since }) => {
        const clean = (value) => String(value || "").replace(/[\s\u3000]+/g, "");
        for (const item of document.querySelectorAll(".f-item")) {
          const tid = item.querySelector("i[data-tid]")?.getAttribute("data-tid");
          if (!tid || tid === "0") continue;
          const abstime = Number(item.querySelector("i[data-abstime]")?.getAttribute("data-abstime") || 0);
          if (abstime && abstime < since) continue;
          const info = item.querySelector(".f-info");
          const text = clean(info ? info.innerText : item.innerText);
          if (text.includes(target)) {
            return {
              tid,
              abstime,
              text: (info ? info.innerText : item.innerText).trim().slice(0, 120),
              hasImage: !!item.querySelector(".img-box img, .img-item img"),
            };
          }
        }
        return null;
      },
      { target, since: startSec - 120 },
    );
  }

  if (!found) {
    return {
      ok: false,
      stage: "verify",
      error: "POST_NOT_FOUND_AFTER_PUBLISH",
      maybePosted: true,
      screenshot: await screenshot(),
    };
  }

  return {
    ok: true,
    url: `${CONFIG.baseUrl}/mood/${found.tid}.1`,
    tid: found.tid,
    text: found.text,
    imageAttached: found.hasImage,
    imageUploaded,
    postedAt: found.abstime ? new Date(found.abstime * 1000).toISOString() : null,
    duplicate: false,
  };
}

const result = await main().catch(async (error) => ({
  ok: false,
  stage,
  error: String((error && error.message) || error),
  screenshot: await screenshot(),
}));

console.log(PREFIX + JSON.stringify(result));
