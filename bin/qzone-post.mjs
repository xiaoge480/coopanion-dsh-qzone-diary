#!/usr/bin/env node
/**
 * qzone-post — 往 QQ 空间「说说」发一条带图/纯文字的动态。
 *
 * 用法:
 *   node qzone-post.mjs --text "今天..." --image "C:\\path\\pic.png"
 *   node qzone-post.mjs --text-file diary.txt --image pic.webp
 *   node qzone-post.mjs --dry-run --text "..." --image "..."
 *   node qzone-post.mjs login
 *   node qzone-post.mjs status
 *   node qzone-post.mjs doctor
 *
 * 输出: 一行 JSON，例如
 *   {"ok":true,"url":"https://user.qzone.qq.com/<你的QQ号>/mood/....1","tid":"..."}
 *
 * 依赖: 已登录 QQ 空间的 Ego 浏览器（ego-browser 在 PATH 中）。
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE = path.join(ROOT, "ego-runner.tpl.mjs");
const RUN_DIR = path.join(ROOT, ".run");
const LOG_DIR = path.join(ROOT, "logs");
const LOCK = path.join(RUN_DIR, "qzone-post.lock");
const UIN = String(process.env.QZONE_UIN || "").trim();
if (!UIN) {
  console.error(JSON.stringify({ ok: false, stage: "config", error: "缺少 QZONE_UIN：请先在插件配置里填写你的 QQ 号" }));
  process.exit(2);
}
const MAIN_URL = `https://user.qzone.qq.com/${UIN}`;
const BASE_URL = MAIN_URL;
const EGO = process.env.EGO_BROWSER || "ego-browser";
const EGO_EXE = process.env.EGO_EXE || "C:\\Program Files\\Citro Labs\\ego lite\\Application\\ego.exe";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg"]);

function usage() {
  return `qzone-post — 发 QQ 空间说说（可带一张图）

用法:
  qzone-post.cmd --text "文字" --image "C:\\图片\\a.png"
  qzone-post.cmd --text-file 日记.txt --image a.webp
  qzone-post.cmd --dry-run --text "..." --image "..."   只填表+传图，不点发表
  qzone-post.cmd login                                   打开 QQ 空间等待扫码登录
  qzone-post.cmd status                                  检查登录态
  qzone-post.cmd doctor                                  检查 Ego 进程/连接/自动拉起条件

参数:
  --text <文字>            说说正文（支持换行）
  --text-file <路径>       从 UTF-8 文件读取正文（长文/多段推荐）
  --image <路径>           配图，支持 jpg/png/gif/webp/bmp/svg，最多 1 张
  --dry-run                上传并截图验证，不发表
  --dedupe-minutes <分钟>  兼容旧参数（去重改为匹配已加载动态的开头）
  --no-dedupe              关闭去重
  --timeout <秒>           整体超时，默认 180
  --job <json文件>         {"text":"...","image":"...","dryRun":false}
  --shot <路径>            截图保存路径
  --json                   输出 JSON（默认）
  --human                  输出中文摘要
  --keep-script            保留生成的 Ego 脚本，便于排查
  --no-autostart           连不上 Ego 时不要自动拉起 ego.exe
`;
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      out._.push(token);
      continue;
    }
    const eq = token.indexOf("=");
    const key = eq >= 0 ? token.slice(2, eq) : token.slice(2);
    let value = eq >= 0 ? token.slice(eq + 1) : undefined;
    const takesValue = new Set([
      "text", "text-file", "image", "dedupe-minutes", "timeout", "job", "shot", "uin", "login-wait",
    ]);
    if (value === undefined && takesValue.has(key)) {
      value = argv[i + 1];
      i += 1;
    }
    out[key] = value === undefined ? true : value;
  }
  return out;
}

function fail(message) {
  const error = new Error(message);
  error.userFacing = true;
  throw error;
}

async function readText(args) {
  if (args["text-file"]) {
    const value = await fs.readFile(path.resolve(String(args["text-file"])), "utf8");
    return value.replace(/^\uFEFF/, "");
  }
  if (typeof args.text === "string") return args.text;
  return "";
}

async function fileExists(target) {
  try {
    return (await fs.stat(target)).isFile();
  } catch {
    return false;
  }
}

function runCapture(command, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(output);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { output += chunk.toString("utf8"); });
    child.on("error", finish);
    child.on("close", finish);
  });
}

async function egoProcessRunning() {
  const output = await runCapture("tasklist", ["/FI", "IMAGENAME eq ego.exe", "/NH", "/FO", "CSV"], 8000);
  return /ego\.exe/i.test(output);
}

async function resolveEgoExe() {
  const candidates = [
    process.env.EGO_EXE,
    EGO_EXE,
    "C:\Program Files\Citro Labs\ego lite\Application\ego.exe",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }
  const output = await runCapture(
    "reg",
    ["query", "HKCU\Software\Microsoft\Windows\CurrentVersion\Run", "/v", "ego lite"],
    6000,
  );
  const match = output.match(/"([^"]*?ego\.exe)"/i);
  if (match && (await fileExists(match[1]))) return match[1];
  return "";
}

async function ensureEgo() {
  const exe = await resolveEgoExe();
  if (!exe) return { ok: false, started: false, error: "EGO_EXE_NOT_FOUND" };
  if (await egoProcessRunning()) return { ok: true, started: false, detail: "already-running" };
  try {
    const child = spawn(exe, ["--no-startup-window"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  } catch (error) {
    return { ok: false, started: false, error: "EGO_START_FAILED", detail: String(error.message || error) };
  }
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    await sleep(700);
    if (await egoProcessRunning()) return { ok: true, started: true, exe };
  }
  return { ok: true, started: true, exe, detail: "process-not-seen-yet" };
}

function isBootstrapFailure(result) {
  const detail = String(result.detail || "");
  if (result.error === "EGO_UNAVAILABLE") {
    if (/ENOENT|not recognized|not found/i.test(detail) && /ego-browser/i.test(detail)) return false;
    return true;
  }
  if (result.error === "EGO_NO_RESULT") {
    return /ego_cli bootstrap|Failed to connect to ego|connect to the ego_cli|ECONNREFUSED/i.test(detail);
  }
  return false;
}

function pingEgo(timeoutMs = 20000) {
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    const child = spawn(EGO, ["nodejs", "-e", "console.log('EGO_PING_OK')"], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish({ ok: false, error: "TIMEOUT", detail: output.slice(-500) });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { output += chunk.toString("utf8"); });
    child.on("error", (error) => finish({ ok: false, error: "SPAWN", detail: String(error.message || error) }));
    child.on("close", (code) => finish({
      ok: code === 0 && output.includes("EGO_PING_OK"),
      code,
      detail: output.slice(-500),
    }));
  });
}

async function doctor() {
  const exe = await resolveEgoExe();
  const running = await egoProcessRunning();
  const ping = await pingEgo();
  const result = {
    ok: ping.ok,
    egoExe: exe || null,
    egoExeExists: !!exe,
    egoRunning: running,
    bootstrapOk: ping.ok,
    autostartAvailable: !!exe,
  };
  if (!exe) {
    result.error = "EGO_EXE_NOT_FOUND";
    result.hint = "找不到 ego.exe：设置环境变量 EGO_EXE 指向 ego.exe，或确认 ego lite 安装路径";
  } else if (!ping.ok) {
    result.error = "EGO_UNAVAILABLE";
    result.hint = "Ego 没连上；发说说时会尝试自动拉起 ego.exe，也可以手动打开 ego lite";
    result.detail = ping.detail;
  }
  return result;
}

async function main() {
  const raw = parseArgs(process.argv.slice(2));
  const command = ["login", "status", "doctor"].includes(raw._[0]) ? raw._[0] : "post";
  if (raw.help || raw.h) {
    process.stdout.write(usage());
    return 0;
  }

  let job = {};
  if (raw.job) {
    const loaded = JSON.parse(await fs.readFile(path.resolve(String(raw.job)), "utf8"));
    job = loaded && typeof loaded === "object" ? loaded : {};
  }

  const text = (await readText(raw) || job.text || "").replace(/\r\n/g, "\n");
  const imageRaw = raw.image || job.image || "";
  const image = imageRaw ? path.resolve(String(imageRaw)) : "";
  const dryRun = !!raw["dry-run"] || !!job.dryRun;
  const statusOnly = command === "status";
  const loginOnly = command === "login";
  const doctorOnly = command === "doctor";
  const dedupeMinutes = raw["no-dedupe"]
    ? 0
    : Number(raw["dedupe-minutes"] ?? job.dedupeMinutes ?? 30);
  const timeoutSec = Number(raw.timeout ?? job.timeoutSeconds ?? 180);
  const loginWaitSec = Number(raw["login-wait"] ?? 300);

  if (!Number.isFinite(dedupeMinutes) || dedupeMinutes < 0) fail("--dedupe-minutes 必须是非负数");
  if (!Number.isFinite(timeoutSec) || timeoutSec < 30) fail("--timeout 至少 30 秒");

  if (!statusOnly && !loginOnly && !doctorOnly) {
    if (!text.trim()) fail("缺少 --text 或 --text-file");
    if (text.length > 3000) fail(`正文过长（${text.length} 字），QQ 空间最多约 1000 字`);
  }

  if (image) {
    let stat;
    try {
      stat = await fs.stat(image);
    } catch {
      fail(`图片不存在: ${image}`);
    }
    if (!stat.isFile()) fail(`图片路径不是文件: ${image}`);
    if (!IMAGE_EXT.has(path.extname(image).toLowerCase())) {
      fail(`图片格式不支持: ${path.extname(image)}（支持 jpg/png/gif/webp/bmp/svg）`);
    }
    if (stat.size > 30 * 1024 * 1024) fail("图片超过 30MB");
  }

  await fs.mkdir(RUN_DIR, { recursive: true });
  await fs.mkdir(LOG_DIR, { recursive: true });

  if (doctorOnly) {
    return emit(await doctor(), raw);
  }

  const lockHandle = await acquireLock();
  if (!lockHandle) {
    return emit({ ok: false, stage: "busy", error: "BUSY", hint: "已有一个发说说任务在运行，请稍后再试" }, raw);
  }

  let scriptPath = "";
  const startedAt = Date.now();
  try {
    const config = {
      mainUrl: MAIN_URL,
      baseUrl: BASE_URL,
      uin: UIN,
      text,
      image,
      dryRun,
      statusOnly,
      loginOnly,
      loginWaitMs: loginWaitSec * 1000,
      dedupeMinutes,
      shot: path.resolve(String(raw.shot || path.join(ROOT, dryRun ? "last-dry-run.png" : "last-run.png"))),
    };

    if (loginOnly) {
      process.stderr.write("正在打开 QQ 空间；如未登录，请在 Ego 窗口扫码，最多等待 " + loginWaitSec + " 秒...\n");
    }

    const template = await fs.readFile(TEMPLATE, "utf8");
    if (!template.includes("/*__CONFIG__*/")) fail("ego-runner.tpl.mjs 缺少配置占位符");
    const source = template.replace("/*__CONFIG__*/", JSON.stringify(config, null, 2));
    scriptPath = path.join(RUN_DIR, `run-${process.pid}-${Date.now()}.mjs`);
    await fs.writeFile(scriptPath, source, "utf8");

    let result = await runEgo(scriptPath, timeoutSec * 1000);

    if (!result.ok && !raw["no-autostart"] && isBootstrapFailure(result)) {
      process.stderr.write("连不上 Ego，尝试自动拉起 ego.exe...\n");
      const ensured = await ensureEgo();
      result.autostarted = ensured.started;
      if (ensured.error) result.autostartError = ensured.error;
      if (ensured.ok) {
        const deadline = Date.now() + 45000;
        let attempt = 0;
        while (Date.now() < deadline && attempt < 4) {
          attempt += 1;
          await sleep(attempt === 1 ? 2500 : 7000);
          const retry = await runEgo(scriptPath, timeoutSec * 1000);
          retry.autostartAttempt = attempt;
          retry.autostarted = ensured.started;
          if (retry.ok || !isBootstrapFailure(retry)) {
            result = retry;
            break;
          }
          result = retry;
        }
      }
    }

    if (!result.ok) {
      result.hint = hintFor(result);
    }

    if (!statusOnly && !loginOnly) await appendLog({
      at: new Date().toISOString(),
      ms: Date.now() - startedAt,
      ok: !!result.ok,
      duplicate: !!result.duplicate,
      dryRun,
      stage: result.stage || "done",
      error: result.error || null,
      url: result.url || null,
      tid: result.tid || null,
      imageAttached: result.imageAttached ?? null,
      autostarted: result.autostarted ?? null,
      text: text.slice(0, 60),
      image: image || null,
    });

    return emit(result, raw);
  } finally {
    await releaseLock(lockHandle);
    if (!raw["keep-script"] && scriptPath) {
      await fs.rm(scriptPath, { force: true }).catch(() => {});
    }
  }
}

async function acquireLock() {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(LOCK, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      return handle;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const stat = await fs.stat(LOCK).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > 10 * 60 * 1000) {
        await fs.rm(LOCK, { force: true });
        continue;
      }
      return null;
    }
  }
  return null;
}

async function releaseLock(handle) {
  try {
    await handle.close();
  } catch {}
  await fs.rm(LOCK, { force: true }).catch(() => {});
}

function runEgo(scriptPath, timeoutMs) {
  return new Promise((resolve) => {
    const url = pathToFileURL(scriptPath).href;
    const code = `await import(${JSON.stringify(url)})`;
    const child = spawn(EGO, ["nodejs", "-e", code], {
      cwd: ROOT,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch {}
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }).on("error", () => {});
      resolve({ ok: false, stage: "timeout", error: "TIMEOUT", detail: `超过 ${Math.round(timeoutMs / 1000)} 秒未完成` });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, stage: "ego", error: "EGO_UNAVAILABLE", detail: String(error.message || error) });
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const combined = `${stdout}\n${stderr}`;
      const marker = "QZONE_RESULT ";
      const index = combined.lastIndexOf(marker);
      if (index < 0) {
        resolve({
          ok: false,
          stage: "ego",
          error: "EGO_NO_RESULT",
          detail: (stderr || stdout).trim().slice(-1200) || `ego-browser 退出码 ${code}`,
        });
        return;
      }
      const end = combined.indexOf("\n", index);
      const payload = combined.slice(index + marker.length, end < 0 ? undefined : end).trim();
      try {
        resolve(JSON.parse(payload));
      } catch (error) {
        resolve({ ok: false, stage: "ego", error: "EGO_BAD_RESULT", detail: String(error).slice(0, 300) });
      }
    });
  });
}

function hintFor(result) {
  switch (result.error) {
    case "NOT_LOGGED_IN":
      return "QQ 空间未登录：先运行 qzone-post.cmd login，在 Ego 里扫码";
    case "LOGIN_TIMEOUT":
      return "等待扫码超时：请在 Ego 里登录后重试，或运行 status 检查";
    case "WRONG_ACCOUNT":
      return `Ego 当前登录的不是 ${UIN}，请切换账号后再发`;
    case "EDITOR_NOT_FOUND":
      return "没找到说说编辑器：确认 Ego 打开的是 user.qzone.qq.com 主页且已登录";
    case "UPLOAD_TIMEOUT":
    case "UPLOAD_FAILED":
      return "图片上传失败：检查图片格式/大小，或稍后重试";
    case "POST_NOT_FOUND_AFTER_PUBLISH":
      return "已点发表但没在动态里找到：可能已发出但加载慢，先别重发，去空间确认";
    case "EGO_UNAVAILABLE":
      return "连不上 Ego：确认 Ego 浏览器已启动，且 ego-browser 在 PATH 中；也可以跑 doctor 检查";
    case "EGO_EXE_NOT_FOUND":
      return "找不到 ego.exe：设置 EGO_EXE 环境变量，或确认 ego lite 安装路径";
    case "BUSY":
      return "已有发说说任务在跑，稍后再试";
    default:
      return undefined;
  }
}

async function appendLog(entry) {
  try {
    await fs.appendFile(path.join(LOG_DIR, "posts.jsonl"), JSON.stringify(entry) + "\n", "utf8");
  } catch {}
}

function emit(result, raw) {
  if (raw.human) {
    if (result.ok && result.duplicate) {
      process.stdout.write(`已在 ${result.url} 发过相同内容，未重复发送。\n`);
    } else if (result.ok && result.dryRun) {
      process.stdout.write(`试运行成功：文字已填入，图片${result.imageUploaded ? "已上传" : "未上传"}。截图: ${result.screenshot || "-"}\n`);
    } else if (result.ok) {
      process.stdout.write(`已发表: ${result.url}\n`);
    } else {
      process.stdout.write(`失败[${result.stage || "?"}]: ${result.error}${result.hint ? " — " + result.hint : ""}\n`);
    }
  } else {
    process.stdout.write(JSON.stringify(result) + "\n");
  }
  return result.ok ? 0 : 1;
}

try {
  process.exitCode = await main();
} catch (error) {
  const result = { ok: false, stage: "cli", error: String(error.message || error) };
  if (error.userFacing) {
    result.hint = error.message;
  }
  process.stdout.write(JSON.stringify(result) + "\n");
  process.exitCode = 1;
}
