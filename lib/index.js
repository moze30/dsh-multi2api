// dsh-multi2api —— 宿主侧插件。
//
// 它做三件事：
//   1. 托管本机 multi2api（Go）进程：挑端口、写配置、启动、健康检查、崩溃拉起、重启。
//   2. 把账号池里的每个 WorkBuddy 账号注册成 DSH 里一个独立模型（一个账号一个模型、不串号），
//      另外提供一个 auto 模型走"积分最高的健康账号"。
//   3. 在 Web UI 里提供管理面板用的本地接口：状态 / 签到 / 登录加号 / 删号 / 导号 / 日志 / 重启。
//
// 不改动 multi2api 源码，也不依赖它的任何私有接口：只用它公开的 4 条路由
// （POST /v1/chat/completions、GET /v1/models、GET /status、GET /healthz）。
// 账号文件的增删需要重启被托管进程才会生效（Go 只在启动时读 auths/）。

import z from "@deepseek-ai/schemastery";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

const PROVIDER = "multi2api";
const PLUGIN_NAME = "dsh-multi2api";
const ROUTE_PREFIX = "/plugins/dsh-multi2api";
const SETTINGS_NS_FALLBACK = "multi2api";

const UNIFIED_MODEL = "deepseek-v4.1-flash"; // 上游基础模型名（Go 侧 mapModel 认这个名字）
const DEFAULT_CONTEXT_WINDOW = 976000;
const DEFAULT_MAX_TOKENS = 125000;
const AUTO_MODEL_ID = "auto";

const MODELS_BODY_LIMIT = 65536;
// 批量导入账号时一个请求里可能塞很多份凭证，单独给一个更宽的上限。
const IMPORT_BODY_LIMIT = 8 * 1024 * 1024;
const MAX_LOG_CHARS = 256 * 1024;

// 每个平台的二进制；key = process.platform + "-" + process.arch
const BIN_BY_PLATFORM = {
  "linux-x64": "bin/multi2api-linux-amd64",
  "linux-arm64": "bin/multi2api-linux-arm64",
  "darwin-x64": "bin/multi2api-darwin-amd64",
  "darwin-arm64": "bin/multi2api-darwin-arm64",
  "win32-x64": "bin/multi2api-win32-x64.exe",
};

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

// WorkBuddy（腾讯 CodeBuddy）登录 / 账单相关常量，来源：multi2api cmd/login/workbuddy.go 与
// internal/provider/workbuddy/headers.go。
const WB = {
  chatBaseCN: "https://copilot.tencent.com",
  billingBaseCN: "https://www.codebuddy.cn",
  chatBaseGlobal: "https://www.workbuddy.ai",
  billingBaseGlobal: "https://www.workbuddy.ai",
  originCN: "https://www.codebuddy.cn",
  originGlobal: "https://www.workbuddy.ai",
  ua: "CLI/2.63.2 CodeBuddy/2.63.2",
  pollAttempts: 15,
  pollIntervalMs: 2000,
};

// 一次「添加账号」从点击到完成的总时限。
const LOGIN_TTL_MS = 10 * 60 * 1000;
// 用户点「我已登录完成」后，服务端做一轮**有界**重试的次数（间隔用 WB.pollIntervalMs）。
// 刻意不做无限自动轮询：后台瞎猜不如让用户点一下。
const LOGIN_CONFIRM_ATTEMPTS = 6;

const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const COMPAT = {
  thinkingFormat: "deepseek",
  supportsReasoningEffort: true,
  requiresReasoningContentOnAssistantMessages: true,
  // 上游对 developer 角色返回 11128 风控，必须退回 system。
  supportsDeveloperRole: false,
  supportsStore: false,
};

const THINKING_LEVEL_MAP = {
  off: null,
  minimal: null,
  low: "low",
  medium: null,
  high: "high",
  xhigh: null,
  max: "max",
};

// pi-ai 要求 PiAiAdapterOptions.auth 必填；本插件的鉴权完全走 resolveApiKey，
// 这里给一份"空壳"凭证实现即可（照抄 dsh-codebuddy-cli 的写法）。
const INERT_AUTH = {
  credentials: {
    async read() {},
    async list() {
      return [];
    },
    async modify() {
      throw new Error("dsh-multi2api: multi2api 路由没有 pi-ai 凭证生命周期");
    },
    async delete() {},
  },
  authContext: {
    async env() {},
    async fileExists() {
      return false;
    },
  },
};

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

// 脱敏：JWT、查询串里的 token、以及超长内容。用于回给面板的错误文本。
function safeMessage(error) {
  return String(error?.message ?? error)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[redacted token]")
    .replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, "$1[redacted]")
    .slice(0, 500);
}

function binPathForThisMachine() {
  const key = `${process.platform}-${process.arch}`;
  const rel = BIN_BY_PLATFORM[key];
  if (rel === undefined) {
    throw new Error(`dsh-multi2api: 当前机器（${key}）没有内置的 multi2api 程序，暂时只支持 linux/macOS/Windows 的 x64 与 arm64`);
  }
  return fileURLToPath(new URL(`../${rel}`, import.meta.url));
}

function hostnameOfHost(host) {
  if (typeof host !== "string" || host.length === 0) return "";
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end === -1 ? host : host.slice(0, end + 1);
  }
  const idx = host.lastIndexOf(":");
  if (idx === -1) return host;
  const suffix = host.slice(idx + 1);
  if (host.slice(0, idx).includes(":") || !/^\d+$/.test(suffix)) return host;
  return host.slice(0, idx);
}

function hostIsLoopback(host) {
  return LOOPBACK_HOSTS.has(hostnameOfHost(host));
}

function originIsLoopback(origin) {
  if (typeof origin !== "string" || origin.length === 0) return true;
  try {
    const hostname = new URL(origin).hostname;
    return LOOPBACK_HOSTS.has(hostname) || hostname === "::1";
  } catch {
    return false;
  }
}

function loopbackRequest(req) {
  return hostIsLoopback(req.headers.host) && originIsLoopback(req.headers.origin);
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(payload));
  res.setHeader("Cache-Control", "no-store");
  res.end(payload);
}

async function readBody(req, limit = MODELS_BODY_LIMIT) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      req.destroy();
      throw new Error("request body too large");
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim().length === 0) return {};
  return JSON.parse(text);
}

// 写操作防护分两层，都在这里把关：
//   1. 防 DNS rebinding —— Host 必须是回环地址（见 loopbackRequest）；
//   2. 防跨站伪造 —— Origin 一旦出现，就必须也是回环地址。
//
// 注意：**不能**要求 Origin 必须存在。DSH 桌面端（Electron）把渲染进程的请求经由
// Electron 网络层转发，转发时不带 Origin 头，一旦这里强校验，桌面端整个管理面板
// 的写操作（加号 / 签到 / 删号 / 保存设置 / 重启）会全部 403 origin-required。
// 少了 Origin 校验并不等于失去 CSRF 防护：本接口要求 Content-Type: application/json，
// 跨源 POST 会触发 CORS 预检而被浏览器拦下；跨站表单只能发 text/plain、
// application/x-www-form-urlencoded 或 multipart/form-data，会被下面的 415 挡掉。
function checkLoopbackPost(req, res) {
  if (!loopbackRequest(req)) {
    json(res, 403, { error: "request-not-trusted" });
    return false;
  }
  const contentType = String(req.headers["content-type"] ?? "");
  if (!contentType.toLowerCase().startsWith("application/json")) {
    json(res, 415, { error: "content-type must be application/json" });
    return false;
  }
  return true;
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });
}

async function findFreePort(preferred) {
  for (let port = preferred; port < preferred + 50; port += 1) {
    if (await isPortFree(port)) return port;
  }
  return preferred;
}

function timeoutSignal(ms) {
  if (typeof AbortSignal?.timeout === "function") return AbortSignal.timeout(ms);
  return undefined;
}

async function fetchJson(url, init = {}, timeoutMs = 15000) {
  const response = await fetch(url, { ...init, signal: init.signal ?? timeoutSignal(timeoutMs) });
  const text = await response.text();
  let body;
  try {
    body = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  return { response, body, text };
}

/* ------------------------------------------------------------------ *
 * WorkBuddy 账号：登录、签到、积分
 * ------------------------------------------------------------------ */

function regionOf(domain) {
  const value = String(domain ?? "").trim().toLowerCase();
  if (value === "workbuddy.ai" || value.endsWith(".workbuddy.ai")) return "global";
  return "cn";
}

function chatBaseFor(account) {
  return regionOf(account.domain) === "global" ? WB.chatBaseGlobal : WB.chatBaseCN;
}

function billingBaseFor(account) {
  return regionOf(account.domain) === "global" ? WB.billingBaseGlobal : WB.billingBaseCN;
}

function originRefererFor(account) {
  return regionOf(account.domain) === "global" ? WB.originGlobal : WB.originCN;
}

function commonHeaders(account) {
  const origin = originRefererFor(account);
  return {
    "Content-Type": "application/json",
    Accept: "application/json, text/plain, */*",
    "X-Requested-With": "XMLHttpRequest",
    Origin: origin,
    Referer: `${origin}/`,
    "User-Agent": WB.ua,
  };
}

function billingHeaders(account) {
  const headers = {
    Authorization: `Bearer ${account.accessToken}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (account.uid) headers["X-User-Id"] = account.uid;
  if (account.enterpriseId) {
    headers["X-Enterprise-Id"] = account.enterpriseId;
    headers["X-Tenant-Id"] = account.enterpriseId;
  }
  if (account.domain) headers["X-Domain"] = account.domain;
  return headers;
}

// Go 侧 wbDoJSON：HTTP >= 400 报 http_error；envelope.code != 0 报 code/msg；返回 data。
async function wbDoJson(account, method, url, body, headers) {
  const init = {
    method,
    headers: headers ?? commonHeaders(account),
    signal: timeoutSignal(30000),
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await fetch(url, init);
  const text = await response.text();
  if (response.status >= 400) {
    throw new Error(`http_error: upstream ${response.status}: ${text.slice(0, 200)}`);
  }
  let envelope;
  try {
    envelope = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    throw new Error("invalid upstream response");
  }
  if (envelope?.code !== undefined && Number(envelope.code) !== 0) {
    throw new Error(`code=${envelope.code} msg=${envelope.msg ?? ""}`);
  }
  return envelope?.data;
}

// 第 1 步：拿 state 与登录地址。
async function workbuddyLoginStart() {
  const account = { domain: "www.codebuddy.cn", accessToken: "", uid: "", enterpriseId: "" };
  const url = `${WB.chatBaseCN}/v2/plugin/auth/state?platform=CLI`;
  const data = await wbDoJson(account, "POST", url, {});
  const state = String(data?.state ?? "");
  const authUrl = String(data?.authUrl ?? "");
  if (state.length === 0 || authUrl.length === 0) throw new Error("auth state: missing state or authUrl");
  return { state, authUrl };
}

// 第 2 步：轮询换 token。返回 {accessToken, refreshToken, expiresIn, domain}；
// **登录尚未完成时返回 undefined**（上游此时回 HTTP 200 + code=11217 "login ing..."，
// 或 4xx），这属于"还没好"，必须继续轮询，绝不能被当成失败。
// 只有网络错误和 5xx 才算致命 —— 与 Go 侧 cmd/login/workbuddy.go 的 wbPollToken 判定一致。
async function workbuddyLoginPoll(state) {
  const account = { domain: "www.codebuddy.cn", accessToken: "", uid: "", enterpriseId: "" };
  const url = `${WB.chatBaseCN}/v2/plugin/auth/token?state=${encodeURIComponent(state)}`;
  let response;
  try {
    response = await fetch(url, { headers: commonHeaders(account), signal: timeoutSignal(30000) });
  } catch (error) {
    throw new Error(`token endpoint unreachable: ${messageOf(error)}`);
  }
  if (response.status === 0 || response.status >= 500) {
    throw new Error(`token endpoint error: upstream ${response.status}`);
  }
  const text = await response.text();
  if (response.status >= 400) return undefined;
  let envelope;
  try {
    envelope = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    return undefined;
  }
  if (envelope?.code !== undefined && Number(envelope.code) !== 0) return undefined;
  const accessToken = String(envelope?.data?.accessToken ?? "");
  if (accessToken.length === 0) return undefined;
  return {
    accessToken,
    refreshToken: String(envelope?.data?.refreshToken ?? ""),
    expiresIn: Number(envelope?.data?.expiresIn ?? 0),
    domain: String(envelope?.data?.domain ?? ""),
  };
}

// 第 3 步：用 token 换账号资料。
async function workbuddyFetchAccount(state, accessToken) {
  const account = { domain: "www.codebuddy.cn", accessToken, uid: "", enterpriseId: "" };
  const url = `${WB.chatBaseCN}/v2/plugin/login/account?state=${encodeURIComponent(state)}`;
  const headers = { ...commonHeaders(account), Authorization: `Bearer ${accessToken}` };
  const data = await wbDoJson(account, "GET", url, undefined, headers);
  return {
    uid: String(data?.uid ?? ""),
    enterpriseId: String(data?.enterpriseId ?? ""),
    nickname: String(data?.nickname ?? ""),
  };
}

function isAlreadyCheckedIn(message) {
  const text = String(message ?? "").toLowerCase();
  return message.includes("已签到") || text.includes("already checked") || text.includes("already signed");
}

async function workbuddyCheckin(account) {
  const url = `${billingBaseFor(account)}/v2/billing/meter/daily-checkin`;
  try {
    await wbDoJson(account, "POST", url, {}, billingHeaders(account));
    return { ok: true };
  } catch (error) {
    if (isAlreadyCheckedIn(messageOf(error))) return { ok: true, already: true };
    throw error;
  }
}

async function workbuddyCredit(account) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const format = (d) =>
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const end = new Date(now.getTime() + 365 * 101 * 24 * 3600 * 1000);
  const body = {
    PageNumber: 1,
    PageSize: 100,
    ProductCode: "p_tcaca",
    Status: [0, 3],
    PackageEndTimeRangeBegin: format(now),
    PackageEndTimeRangeEnd: format(end),
  };
  const url = `${billingBaseFor(account)}/v2/billing/meter/get-user-resource`;
  const data = await wbDoJson(account, "POST", url, body, billingHeaders(account));
  const accounts = data?.Response?.Data?.Accounts ?? data?.Accounts ?? [];
  let total = 0;
  for (const item of Array.isArray(accounts) ? accounts : []) {
    const cycleSize = Number(item?.CycleCapacitySize ?? 0);
    const cycleRemain = Number(item?.CycleCapacityRemain ?? 0);
    const cycleUsed = Number(item?.CycleCapacityUsed ?? 0);
    const capacityRemain = Number(item?.CapacityRemain ?? 0);
    let remain;
    if (cycleSize > 0) remain = cycleRemain;
    else if (cycleRemain > 0 || cycleUsed > 0) remain = cycleRemain;
    else remain = capacityRemain;
    if (!Number.isFinite(remain) || remain < 0) remain = 0;
    total += remain;
  }
  return total;
}

/* ------------------------------------------------------------------ *
 * 账号文件读写（形状必须与 Go internal/auth/auth.go saveAtomicLocked 一致）
 * ------------------------------------------------------------------ */

function parseAccountDoc(raw) {
  let doc;
  try {
    doc = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    throw new Error("不是合法的 JSON");
  }
  if (doc === null || typeof doc !== "object") throw new Error("账号内容必须是一个 JSON 对象");
  const nested = doc.auth !== undefined || doc.account !== undefined;
  const auth = nested ? (doc.auth ?? {}) : doc;
  const account = nested ? (doc.account ?? {}) : doc;
  const accessToken = String(auth.accessToken ?? auth.access_token ?? "");
  if (accessToken.length === 0) throw new Error("parse_error: missing accessToken");
  return {
    platform: String(doc.platform ?? "workbuddy"),
    accessToken,
    refreshToken: String(auth.refreshToken ?? auth.refresh_token ?? ""),
    expiresAt: Number(auth.expiresAt ?? auth.expires_at ?? 0),
    domain: String(auth.domain ?? ""),
    apiHost: String(auth.apiHost ?? ""),
    machineId: String(auth.machineId ?? ""),
    deviceId: String(auth.deviceId ?? ""),
    uid: String(account.uid ?? ""),
    enterpriseId: String(account.enterpriseId ?? ""),
    nickname: String(account.nickname ?? ""),
  };
}

function buildAccountDoc(account) {
  return {
    platform: account.platform ?? "workbuddy",
    auth: {
      accessToken: account.accessToken,
      refreshToken: account.refreshToken,
      expiresAt: account.expiresAt,
      domain: account.domain,
      apiHost: account.apiHost ?? "",
      machineId: account.machineId ?? "",
      deviceId: account.deviceId ?? "",
    },
    account: {
      uid: account.uid,
      enterpriseId: account.enterpriseId,
      nickname: account.nickname,
    },
  };
}

async function writeAccountFile(authsDir, account) {
  const doc = buildAccountDoc(account);
  const uid = String(account.uid ?? "").trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(uid)) throw new Error("uid 不合法，无法写入账号文件");
  const target = join(authsDir, `workbuddy-${uid}.json`);
  const tmp = `${target}.tmp-${randomBytes(4).toString("hex")}`;
  await writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, target);
  return target;
}

async function readAccountFile(file) {
  const raw = await readFile(file, "utf8");
  const account = parseAccountDoc(raw);
  if (!account.uid) {
    const match = /^workbuddy-(.+)\.json$/.exec(String(file).split(/[\\/]/).pop() ?? "");
    if (match) account.uid = match[1];
  }
  return account;
}

async function listAccountFiles(authsDir) {
  let names = [];
  try {
    names = await readdir(authsDir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!/^workbuddy-.+\.json$/.test(name)) continue;
    const file = join(authsDir, name);
    try {
      out.push({ file, account: await readAccountFile(file) });
    } catch {
      // 坏文件跳过，避免一个文件坏了整个池子起不来。
    }
  }
  return out;
}

// 昵称（手机号）必须是纯数字，Go 侧 splitModelNick 才会把模型名后缀当账号别名。
// 非纯数字或重名的账号，改写成由 uid 派生的纯数字别名，保证"一账号一模型"始终可用。
function aliasFor(account, used) {
  const nick = String(account.nickname ?? "").trim();
  if (/^\d+$/.test(nick) && !used.has(nick)) return { alias: nick, rewrite: false };
  const digits = String(account.uid ?? "").replace(/\D+/g, "");
  let seed = digits.length >= 6 ? digits.slice(-12) : String(account.uid ?? "").replace(/[^A-Za-z0-9]/g, "");
  let alias = seed.replace(/\D+/g, "");
  if (alias.length < 6) alias = `${alias}${String(Math.abs(hashCode(String(account.uid ?? ""))))}`.slice(0, 12);
  let suffix = 0;
  while (used.has(alias)) {
    suffix += 1;
    alias = `${seed.slice(0, 10)}${suffix}`;
  }
  return { alias, rewrite: true };
}

function hashCode(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash << 5) - hash + text.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

/* ------------------------------------------------------------------ *
 * 子进程托管 + 账号/模型缓存
 * ------------------------------------------------------------------ */

function createRuntime(ctx, config) {
  const dataDir = config.dataDir;
  const authsDir = join(dataDir, "auths");
  const logsDir = join(dataDir, "logs");
  const keyFile = join(dataDir, "api_key");
  const autoCheckinFile = join(dataDir, "auto_checkin.json");
  const selectionFile = join(dataDir, "selection.json");

  const runtime = {
    config,
    dataDir,
    authsDir,
    logsDir,
    settingsNs: resolveSettingsNamespace(ctx),
    apiKey: "",
    port: 0,
    child: null,
    pid: 0,
    stopped: false,
    starting: false,
    lastError: "",
    startedAt: 0,
    restartCount: 0,
    logs: [],
    accounts: [],
    models: [],
    catalog: [],
    catalogAt: 0,
    catalogError: "",
    checkinLog: new Map(),
    pendingLogins: new Map(),
    statusAt: 0,
    statusError: "",
    accountsFingerprint: "",
    modelsFingerprint: "",
    selection: { seeded: false, enabledModels: [], disabledAccounts: [], exists: false },
  };

  runtime.profiles = new Map();
  runtime.invalidate = () => {
    runtime.profiles = new Map([[PROVIDER, runtime.profile]]);
  };

  runtime.baseUrl = () => `http://127.0.0.1:${runtime.port}`;
  runtime.modelsBaseUrl = () => `${runtime.baseUrl()}/v1`;

  runtime.appendLog = (chunk) => {
    const text = String(chunk);
    runtime.logs.push(text);
    let total = runtime.logs.reduce((sum, item) => sum + item.length, 0);
    while (total > MAX_LOG_CHARS && runtime.logs.length > 1) {
      total -= runtime.logs.shift().length;
    }
  };

  runtime.authHeaders = () => ({ Authorization: `Bearer ${runtime.apiKey}` });

  // 自动签到开关：面板点一下会写进这个文件，重启 DSH 也不会丢。
  // 没有这个文件时用插件配置里的默认值（默认开）。
  runtime.readAutoCheckin = () => {
    try {
      const parsed = JSON.parse(readFileSync(autoCheckinFile, "utf8"));
      if (typeof parsed?.enabled === "boolean") return parsed.enabled;
    } catch {
      // 文件不存在或坏了：退回配置默认值。
    }
    return runtime.config.autoCheckin === true;
  };

  runtime.writeAutoCheckin = (enabled) => {
    const next = enabled === true;
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    writeFileSync(autoCheckinFile, `${JSON.stringify({ enabled: next }, null, 2)}\n`);
    runtime.config.autoCheckin = next;
    return next;
  };

  // 启用清单：决定哪些「模型 × 账号」注册进 DSH 的模型列表。
  // 模型是白名单（没勾就不注册），账号是黑名单（只记被关掉的），这样新加的号默认能用。
  runtime.readSelection = () => {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(selectionFile, "utf8"));
    } catch {
      parsed = undefined;
    }
    const enabledModels = Array.isArray(parsed?.enabledModels)
      ? parsed.enabledModels.map((item) => String(item)).filter((item) => item.length > 0)
      : [];
    const disabledAccounts = Array.isArray(parsed?.disabledAccounts)
      ? parsed.disabledAccounts.map((item) => String(item)).filter((item) => item.length > 0)
      : [];
    return { seeded: parsed?.seeded === true, enabledModels, disabledAccounts, exists: parsed !== undefined };
  };

  runtime.writeSelection = (selection) => {
    const next = {
      seeded: selection.seeded === true,
      enabledModels: Array.isArray(selection.enabledModels) ? selection.enabledModels.map(String) : [],
      disabledAccounts: Array.isArray(selection.disabledAccounts) ? selection.disabledAccounts.map(String) : [],
    };
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    writeFileSync(selectionFile, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  };

  // 模型是否启用：白名单。auto 不在这里判断（它永远注册）。
  runtime.modelEnabled = (modelId, selection) =>
    selection.enabledModels.includes(String(modelId));

  runtime.accountEnabled = (uid, selection) =>
    !selection.disabledAccounts.includes(String(uid));

  runtime.ensureApiKey = () => {
    if (existsSync(keyFile)) {
      const existing = readFileSync(keyFile, "utf8").trim();
      if (existing.length > 0) return existing;
    }
    // 首次运行时 dataDir 可能还不存在，写文件前必须先建目录。
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    const generated = randomBytes(24).toString("hex");
    writeFileSync(keyFile, `${generated}\n`, { mode: 0o600 });
    return generated;
  };

  runtime.goConfig = () => ({
    listen: `127.0.0.1:${runtime.port}`,
    api_key: runtime.apiKey,
    auth_dir: "./auths",
    state_file: "./data/state.json",
    providers: {
      workbuddy: {
        region: "cn",
        chat_enabled: true,
        // err_threshold 放大：一账号一模型时，偶发错误不该把账号冷却掉，否则对应模型会 503。
        cooldown: { hard_credit: "12h", soft_rate: "60s", err_threshold: 999999, err_cooldown: "1s" },
        // auto_checkin 关掉后，Go 侧既不注册整点签到任务，也不做启动补签。
        schedule: {
          checkin_hours: [9, 21],
          keepalive_hours: [22],
          auto_checkin: runtime.readAutoCheckin(),
        },
      },
    },
  });

  runtime.prepare = async () => {
    runtime.apiKey = runtime.ensureApiKey();
    await mkdir(authsDir, { recursive: true });
    await mkdir(logsDir, { recursive: true });
    await mkdir(join(dataDir, "data"), { recursive: true });
  };

  runtime.fetchStatus = async (force) => {
    const ttl = Math.max(2, runtime.config.statusRefreshSeconds) * 1000;
    if (!force && runtime.accounts.length > 0 && Date.now() - runtime.statusAt < ttl) return runtime.accounts;
    if (runtime.port === 0) return runtime.accounts;
    try {
      const { response, body } = await fetchJson(`${runtime.baseUrl()}/status`, { headers: runtime.authHeaders() }, 8000);
      if (!response.ok) throw new Error(`status ${response.status}`);
      runtime.accounts = Array.isArray(body?.accounts) ? body.accounts : [];
      runtime.statusError = "";
    } catch (error) {
      runtime.statusError = safeMessage(error);
    }
    runtime.statusAt = Date.now();
    return runtime.accounts;
  };

  // 上游可用模型清单：直接问被托管的 Go 进程要（它去向上游拉，带积分倍率与能力位）。
  // 拉不到就保留上一次的结果，不影响已经注册好的模型。
  runtime.fetchCatalog = async (force) => {
    const ttl = 10 * 60 * 1000;
    if (!force && runtime.catalog.length > 0 && Date.now() - runtime.catalogAt < ttl) return runtime.catalog;
    if (runtime.port === 0) return runtime.catalog;
    try {
      const url = `${runtime.modelsBaseUrl()}/models${force ? "?refresh=1" : ""}`;
      const { response, body } = await fetchJson(url, { headers: runtime.authHeaders() }, 20000);
      if (!response.ok) throw new Error(`models ${response.status}`);
      const rows = Array.isArray(body?.data) ? body.data : [];
      const list = [];
      for (const row of rows) {
        const id = String(row?.id ?? "").trim();
        if (id.length === 0) continue;
        list.push({
          id,
          name: String(row?.name ?? "").trim() || id,
          credits: String(row?.credits ?? "").trim(),
          contextWindow: Number(row?.context_window ?? 0) || 0,
          maxTokens: Number(row?.max_tokens ?? 0) || 0,
          reasoning: row?.supports_reasoning === true,
          images: row?.supports_images === true,
          toolCall: row?.supports_tool_call === true,
        });
      }
      if (list.length > 0) {
        runtime.catalog = list;
        runtime.catalogAt = Date.now();
      }
      runtime.catalogError = String(body?.error ?? "");
    } catch (error) {
      runtime.catalogError = safeMessage(error);
    }
    return runtime.catalog;
  };

  // 账号 × 上游模型 全拼接：每个组合一个 DSH 模型，名字是"模型名 · 账号名"。
  // 模型 id 形如 glm-5.3-13800138000，Go 侧 splitModelNick 会把最后的纯数字后缀当账号别名，
  // 剩下的 glm-5.3 才是真正发给上游的模型名。
  runtime.refreshModels = async (force) => {
    const accounts = await runtime.fetchStatus(force);
    await runtime.fetchCatalog(force);
    const catalog = runtime.catalog;
    const files = await listAccountFiles(authsDir);
    const byUid = new Map(files.map((item) => [item.account.uid, item.account]));
    const used = new Set();
    const perAccount = [];
    const normalized = [];
    const seen = new Set();
    for (const account of accounts) {
      if (String(account.platform ?? "") !== "workbuddy") continue;
      const uid = String(account.uid ?? "");
      if (uid.length === 0 || seen.has(uid)) continue;
      seen.add(uid);
      const { alias, rewrite } = aliasFor({ uid, nickname: account.nickname }, used);
      used.add(alias);
      const fileAccount = byUid.get(uid);
      if (rewrite && fileAccount !== undefined && String(fileAccount.nickname ?? "") !== alias) {
        try {
          await writeAccountFile(authsDir, { ...fileAccount, nickname: alias });
          normalized.push(alias);
        } catch {
          // 写不进去也不影响路由，只是这个账号不会被单独注册成模型。
        }
      }
      perAccount.push({
        alias,
        uid,
        accountName: String(account.nickname ?? "").trim() || alias,
        accountKey: String(account.key ?? ""),
      });
    }

    // 上游模型清单拉不到时，退回一个基础模型，至少保证面板里有东西可选。
    const models_source =
      catalog.length > 0 ? catalog : [{ id: UNIFIED_MODEL, name: UNIFIED_MODEL, credits: "" }];

    // 首次拿到上游清单时，默认只开 deepseek-v4.1-flash：
    // 一个是 DSH 里现成的默认模型就指着它，另一个是不至于一上来就塞几十个模型。
    let selection = runtime.readSelection();
    if (selection.seeded !== true && catalog.length > 0) {
      if (!selection.enabledModels.includes(UNIFIED_MODEL)) {
        selection.enabledModels.push(UNIFIED_MODEL);
      }
      selection = runtime.writeSelection({ ...selection, seeded: true });
    }
    runtime.selection = selection;
    // 上游清单没拉到时不套白名单，否则会一个模型都不剩、连默认模型都用不了。
    const filtering = catalog.length > 0;

    const models = [];
    for (const account of perAccount) {
      if (!runtime.accountEnabled(account.uid, selection)) continue;
      for (const item of models_source) {
        if (filtering && !runtime.modelEnabled(item.id, selection)) continue;
        models.push({
          id: `${item.id}-${account.alias}`,
          name: `${item.name} · ${account.accountName}`,
          modelId: item.id,
          modelName: item.name,
          credits: String(item.credits ?? ""),
          contextWindow: Number(item.contextWindow ?? 0) || runtime.config.contextWindow || DEFAULT_CONTEXT_WINDOW,
          maxTokens: Number(item.maxTokens ?? 0) || runtime.config.maxTokens || DEFAULT_MAX_TOKENS,
          reasoning: item.reasoning !== false,
          images: item.images !== false,
          alias: account.alias,
          uid: account.uid,
          accountName: account.accountName,
          accountKey: account.accountKey,
        });
      }
    }

    runtime.models = models;
    // 账号别名跟「启不启用」无关，面板上始终要显示这行的别名。
    runtime.accountAliases = new Map(perAccount.map((item) => [item.uid, item.alias]));
    runtime.accountsFingerprint = models.map((m) => `${m.id}:${m.uid}`).join(",");
    const aliases = perAccount.map((m) => m.alias).sort().join(",");
    if (normalized.length > 0 && runtime.aliases !== aliases) {
      // 昵称被规范化过 → 需要重启才能让 Go 重新加载这些账号。
      runtime.pendingAliasRestart = true;
    }
    runtime.aliases = aliases;
    // 模型清单变了必须换一个新 Map：pi-ai 的模型快照是按引用比较的。
    if (runtime.modelsFingerprint !== runtime.accountsFingerprint) {
      runtime.modelsFingerprint = runtime.accountsFingerprint;
      runtime.invalidate();
    }
    return models;
  };

  const accountByUid = async (uid) => {
    const files = await listAccountFiles(authsDir);
    const hit = files.find((item) => item.account.uid === uid);
    return hit?.account;
  };

  runtime.accountByUid = accountByUid;

  /* ------------------------------ 子进程 ------------------------------ */

  runtime.env = () => {
    const env = {};
    for (const name of ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "SystemRoot", "windir", "USERPROFILE"]) {
      const value = process.env[name];
      if (typeof value === "string" && value.length > 0) env[name] = value;
    }
    env.MULTI2API_AUTH_DIR = authsDir;
    env.MULTI2API_STATE_FILE = join(dataDir, "data", "state.json");
    return env;
  };

  runtime.start = async () => {
    if (runtime.stopped || runtime.starting) return;
    runtime.starting = true;
    try {
      await runtime.prepare();
      runtime.port = await findFreePort(runtime.config.port);
      const configPath = join(dataDir, "config.json");
      await writeFile(configPath, `${JSON.stringify(runtime.goConfig(), null, 2)}\n`, "utf8");
      const exe = binPathForThisMachine();
      const child = spawn(exe, ["-config", configPath], {
        cwd: dataDir,
        env: runtime.env(),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      runtime.child = child;
      runtime.pid = child.pid ?? 0;
      runtime.startedAt = Date.now();
      runtime.lastError = "";
      child.stdout?.on("data", (chunk) => runtime.appendLog(chunk));
      child.stderr?.on("data", (chunk) => runtime.appendLog(chunk));
      child.on("error", (error) => {
        runtime.lastError = safeMessage(error);
        runtime.appendLog(`spawn error: ${messageOf(error)}\n`);
      });
      child.on("exit", (code, signal) => {
        runtime.appendLog(`multi2api exited code=${code} signal=${signal}\n`);
        runtime.child = null;
        runtime.pid = 0;
        if (!runtime.stopped) {
          runtime.restartCount += 1;
          const delay = Math.min(30000, 1000 * 2 ** Math.min(runtime.restartCount, 5));
          const timer = setTimeout(() => {
            if (!runtime.stopped) void runtime.start();
          }, delay);
          if (typeof timer.unref === "function") timer.unref();
        }
      });
      await runtime.waitForHealth();
      await runtime.refreshModels(true);
    } catch (error) {
      runtime.lastError = safeMessage(error);
      ctx.logger.error("dsh-multi2api: 启动 multi2api 进程失败", error);
    } finally {
      runtime.starting = false;
    }
  };

  runtime.waitForHealth = async () => {
    for (let i = 0; i < 40; i += 1) {
      if (runtime.stopped) return false;
      try {
        const response = await fetch(`${runtime.baseUrl()}/healthz`, { signal: timeoutSignal(2000) });
        if (response.ok) return true;
      } catch {
        // 还没起来，继续等。
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    runtime.lastError = "multi2api 启动后健康检查超时";
    return false;
  };

  runtime.terminateChild = async () => {
    const child = runtime.child;
    if (child === null || child === undefined) return;
    await new Promise((resolve) => {
      const done = () => resolve();
      child.once("exit", done);
      try {
        child.kill("SIGTERM");
      } catch {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // 已经退出。
        }
        resolve();
      }, 5000);
      if (typeof timer.unref === "function") timer.unref();
    });
  };

  runtime.restart = async (reason) => {
    runtime.appendLog(`restart requested: ${reason ?? "manual"}\n`);
    // 先置 stopped，避免子进程退出回调把它当成崩溃又拉起一个。
    runtime.stopped = true;
    runtime.restartCount = 0;
    await runtime.terminateChild();
    runtime.stopped = false;
    await runtime.start();
    return { ok: true, pid: runtime.pid, port: runtime.port };
  };

  runtime.stop = async () => {
    runtime.stopped = true;
    await runtime.terminateChild();
  };

  runtime.checkinAll = async (uid) => {
    const files = await listAccountFiles(runtime.authsDir);
    const results = [];
    for (const item of files) {
      if (uid !== undefined && item.account.uid !== uid) continue;
      const entry = { uid: item.account.uid, nickname: item.account.nickname };
      try {
        const checkin = await workbuddyCheckin(item.account);
        entry.ok = true;
        entry.already = checkin.already === true;
        try {
          entry.credits = await workbuddyCredit(item.account);
        } catch (error) {
          entry.creditsError = safeMessage(error);
        }
      } catch (error) {
        entry.ok = false;
        entry.error = safeMessage(error);
      }
      const today = new Date().toISOString().slice(0, 10);
      runtime.checkinLog.set(item.account.uid, { date: today, ok: entry.ok === true, at: Date.now() });
      results.push(entry);
    }
    await runtime.refreshModels(true);
    return results;
  };

  return runtime;
}

/* ------------------------------------------------------------------ *
 * pi-ai 适配器
 * ------------------------------------------------------------------ */

function toPiModel(info, baseUrl, contextWindow, maxTokens) {
  const model = {
    id: info.id,
    name: info.name,
    api: "openai-completions",
    provider: PROVIDER,
    baseUrl,
    input: info.images === false ? ["text"] : ["text", "image"],
    reasoning: info.reasoning !== false,
    thinkingLevelMap: { ...THINKING_LEVEL_MAP },
    cost: { ...NO_COST },
    contextWindow: Number(info.contextWindow ?? 0) || contextWindow,
    maxTokens: Number(info.maxTokens ?? 0) || maxTokens,
    compat: { ...COMPAT },
  };
  // 账号级隔离：Go 侧优先认模型名后缀（reqNick），X-Account-Uid 作为第二保险。
  if (typeof info.uid === "string" && info.uid.length > 0) {
    model.headers = { "X-Account-Uid": info.uid };
  }
  return model;
}

function createAdapter(runtime) {
  const buildModels = () => {
    const base = runtime.modelsBaseUrl();
    const contextWindow = runtime.config.contextWindow || DEFAULT_CONTEXT_WINDOW;
    const maxTokens = runtime.config.maxTokens || DEFAULT_MAX_TOKENS;
    const models = [
      toPiModel({ id: AUTO_MODEL_ID, name: "自动（积分最高的健康账号）", uid: "" }, base, contextWindow, maxTokens),
    ];
    for (const item of runtime.models) {
      models.push(toPiModel(item, base, contextWindow, maxTokens));
    }
    return models;
  };

  const provider = {
    ...createProvider({
      id: PROVIDER,
      name: "Multi2API",
      auth: {
        apiKey: {
          name: "Multi2API",
          async resolve({ credential }) {
            const apiKey = credential?.key ?? runtime.apiKey;
            if (apiKey === undefined || apiKey.length === 0) return undefined;
            return { auth: { apiKey }, source: "Multi2API" };
          },
        },
      },
      models: buildModels(),
      api: openAICompletionsApi(),
    }),
    getModels: () => buildModels(),
  };

  const profile = {
    provider,
    displayName: "Multi2API",
    streamIdleTimeoutMs: 300000,
    retryPolicy: resolveRetryPolicy(undefined, "Multi2API retryPolicy"),
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
    maxRequestImageBytes: 20971520,
    requestImagePixelBudget: 4194304,
    requestImageMaxBytes: 1048576,
    piProvider: provider,
  };

  runtime.profile = profile;
  runtime.invalidate();

  const adapter = new PiAiAdapter({
    profiles: () => runtime.profiles,
    resolveApiKey: async () => runtime.apiKey,
    auth: INERT_AUTH,
  });

  return { adapter, provider, profile };
}

/* ------------------------------------------------------------------ *
 * settings：拿到本插件在 profile 里的条目 id 当命名空间
 * ------------------------------------------------------------------ */

function entryNamespaceOf(ctx) {
  const fiber = ctx?.fiber;
  const candidates = [
    fiber?.entry?.options?.id,
    fiber?.entry?.id,
    typeof ctx?.loader?.locate === "function" ? ctx.loader.locate(fiber) : undefined,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return undefined;
}

function resolveSettingsNamespace(ctx) {
  return entryNamespaceOf(ctx) ?? SETTINGS_NS_FALLBACK;
}

function installSettings(ctx, runtime) {
  try {
    ctx.inject(["settings"], (settingsCtx) => {
      const settings = settingsCtx.get("settings");
      if (settings === undefined) return;
      try {
        if (typeof settings.configure === "function") {
          settingsCtx.effect(() => {
            const dispose = settings.configure({ auto: false }, ctx.fiber);
            return typeof dispose === "function" ? dispose : () => {};
          }, "dsh-multi2api: settings section");
        } else if (typeof settings.installSection === "function") {
          settingsCtx.effect(
            () => settings.installSection(runtime.settingsNs, Config, {}),
            "dsh-multi2api: settings section",
          );
        }
      } catch (error) {
        ctx.logger.warn("dsh-multi2api: 注册设置项失败（不影响使用）", error);
      }
    });
  } catch (error) {
    ctx.logger.warn("dsh-multi2api: settings 服务不可用（不影响使用）", error);
  }
}

/* ------------------------------------------------------------------ *
 * Web 路由
 * ------------------------------------------------------------------ */

function registerRoutes(ctx, runtime) {
  const routes = [];
  const add = (path, handler) => {
    routes.push(ctx.webServer.register({ kind: "exact", path: `${ROUTE_PREFIX}${path}`, handler }));
  };

  const guardGet = (req, res) => {
    if (req.method !== "GET") {
      json(res, 405, { error: "method not allowed" });
      return false;
    }
    if (!loopbackRequest(req)) {
      json(res, 403, { error: "request-not-trusted" });
      return false;
    }
    return true;
  };

  const summarizeAccounts = () =>
    runtime.accounts.map((account) => {
      const uid = String(account.uid ?? "");
      const model = runtime.models.find((item) => item.uid === uid);
      const alias = model?.alias ?? runtime.accountAliases?.get(uid) ?? "";
      const checkin = runtime.checkinLog.get(uid);
      const today = new Date().toISOString().slice(0, 10);
      return {
        uid,
        nickname: String(account.nickname ?? ""),
        displayName: String(account.nickname ?? "").trim() || alias || uid.slice(0, 8),
        alias,
        modelId: model?.id ?? "",
        credits: Number(account.credits ?? 0),
        cooling: account.cooling === true,
        until: String(account.until ?? ""),
        reason: String(account.reason ?? ""),
        disabled: account.disabled === true,
        enabled: runtime.accountEnabled(uid, runtime.selection),
        errCount: Number(account.err_count ?? 0),
        checkedInToday: checkin !== undefined && checkin.date === today,
      };
    });

  // GET /status
  add("/status", async (req, res) => {
    if (!guardGet(req, res)) return;
    try {
      const force = String(req.url ?? "").includes("refresh=1");
      await runtime.refreshModels(force);
      json(res, 200, {
        running: runtime.pid > 0,
        pid: runtime.pid,
        port: runtime.port,
        baseUrl: runtime.port > 0 ? runtime.baseUrl() : "",
        dataDir: runtime.dataDir,
        startedAt: runtime.startedAt,
        error: runtime.lastError,
        statusError: runtime.statusError,
        catalogError: runtime.catalogError,
        accounts: summarizeAccounts(),
        catalog: runtime.catalog.map((item) => ({
          id: item.id,
          name: item.name,
          credits: item.credits,
          contextWindow: item.contextWindow,
          maxTokens: item.maxTokens,
          reasoning: item.reasoning,
          images: item.images,
          toolCall: item.toolCall,
          enabled: runtime.modelEnabled(item.id, runtime.selection),
        })),
        models: runtime.models.map((item) => ({
          id: item.id,
          name: item.name,
          modelId: item.modelId,
          modelName: item.modelName,
          credits: item.credits,
          uid: item.uid,
          alias: item.alias,
          accountName: item.accountName,
        })),
        autoModelId: AUTO_MODEL_ID,
      });
    } catch (error) {
      json(res, 500, { error: safeMessage(error) });
    }
  });

  // GET /logs
  add("/logs", (req, res) => {
    if (!guardGet(req, res)) return;
    const url = new URL(String(req.url ?? "/"), "http://127.0.0.1");
    const lines = Math.max(10, Math.min(2000, Number(url.searchParams.get("lines") ?? runtime.config.logLines) || 300));
    const text = runtime.logs.join("");
    const all = text.split("\n");
    json(res, 200, { text: all.slice(-lines).join("\n") });
  });

  // POST /check-in 只给内部用（启动自动签到）；面板不再暴露单个或全部签到入口。
  add("/check-in", async (req, res) => {
    if (req.method !== "POST") {
      json(res, 405, { error: "method not allowed" });
      return;
    }
    if (!checkLoopbackPost(req, res)) return;
    try {
      const body = await readBody(req);
      const uid = typeof body?.uid === "string" && body.uid.length > 0 ? body.uid : undefined;
      const results = await runtime.checkinAll(uid);
      json(res, 200, { ok: true, results });
    } catch (error) {
      json(res, 200, { ok: false, error: safeMessage(error) });
    }
  });

  // GET /settings —— 面板读开关状态。
  add("/settings", (req, res) => {
    if (!guardGet(req, res)) return;
    const selection = runtime.selection ?? runtime.readSelection();
    json(res, 200, {
      ok: true,
      autoCheckin: runtime.readAutoCheckin(),
      selection: {
        seeded: selection.seeded === true,
        enabledModels: selection.enabledModels,
        disabledAccounts: selection.disabledAccounts,
      },
    });
  });

  // POST /selection/save —— 面板勾选「启用哪些模型 / 关掉哪些账号」。
  // body: {kind:"model", id, enabled} 或 {kind:"account", uid, enabled}
  add("/selection/save", async (req, res) => {
    if (req.method !== "POST") {
      json(res, 405, { error: "method not allowed" });
      return;
    }
    if (!checkLoopbackPost(req, res)) return;
    try {
      const body = await readBody(req);
      const kind = String(body?.kind ?? "");
      const enabled = body?.enabled === true;
      const current = runtime.selection ?? runtime.readSelection();
      const enabledModels = new Set(current.enabledModels);
      const disabledAccounts = new Set(current.disabledAccounts);

      if (kind === "model") {
        const id = String(body?.id ?? "");
        if (id.length === 0) {
          json(res, 400, { ok: false, error: "缺少模型 id" });
          return;
        }
        if (enabled) enabledModels.add(id);
        else enabledModels.delete(id);
      } else if (kind === "account") {
        const uid = String(body?.uid ?? "");
        if (uid.length === 0) {
          json(res, 400, { ok: false, error: "缺少账号 uid" });
          return;
        }
        if (enabled) disabledAccounts.delete(uid);
        else disabledAccounts.add(uid);
      } else {
        json(res, 400, { ok: false, error: "kind 只能是 model 或 account" });
        return;
      }

      runtime.selection = runtime.writeSelection({
        seeded: true,
        enabledModels: [...enabledModels],
        disabledAccounts: [...disabledAccounts],
      });
      // 清单变了，立刻重建模型列表并换掉 pi-ai 的快照（它按引用比较）。
      await runtime.refreshModels(true);
      runtime.invalidate();
      json(res, 200, {
        ok: true,
        selection: {
          seeded: true,
          enabledModels: runtime.selection.enabledModels,
          disabledAccounts: runtime.selection.disabledAccounts,
        },
        modelCount: runtime.models.length,
      });
    } catch (error) {
      json(res, 200, { ok: false, error: safeMessage(error) });
    }
  });

  // POST /settings —— 面板拨开关。只写一个小文件，不重启进程。
  add("/settings/save", async (req, res) => {
    if (req.method !== "POST") {
      json(res, 405, { error: "method not allowed" });
      return;
    }
    if (!checkLoopbackPost(req, res)) return;
    try {
      const body = await readBody(req);
      const enabled = runtime.writeAutoCheckin(body?.autoCheckin === true);
      // 开关落盘后重启被托管进程，让 Go 侧按新配置重建（开=重启后补签一次，关=不再注册签到任务）。
      void runtime.restart("auto checkin changed");
      json(res, 200, { ok: true, autoCheckin: enabled });
    } catch (error) {
      json(res, 200, { ok: false, error: safeMessage(error) });
    }
  });

  // POST /restart
  add("/restart", async (req, res) => {
    if (req.method !== "POST") {
      json(res, 405, { error: "method not allowed" });
      return;
    }
    if (!checkLoopbackPost(req, res)) return;
    try {
      const result = await runtime.restart("panel");
      json(res, 200, { ok: true, ...result });
    } catch (error) {
      json(res, 200, { ok: false, error: safeMessage(error) });
    }
  });

  // POST /accounts/delete  body: {uid}
  add("/accounts/delete", async (req, res) => {
    if (req.method !== "POST") {
      json(res, 405, { error: "method not allowed" });
      return;
    }
    if (!checkLoopbackPost(req, res)) return;
    try {
      const body = await readBody(req);
      const uid = String(body?.uid ?? "");
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(uid)) {
        json(res, 400, { ok: false, error: "uid 不合法" });
        return;
      }
      await rm(join(runtime.authsDir, `workbuddy-${uid}.json`), { force: true });
      const result = await runtime.restart("account deleted");
      json(res, 200, { ok: true, ...result });
    } catch (error) {
      json(res, 200, { ok: false, error: safeMessage(error) });
    }
  });

  // POST /accounts/import  body: {doc} | {text} | {path}
  add("/accounts/import", async (req, res) => {
    if (req.method !== "POST") {
      json(res, 405, { error: "method not allowed" });
      return;
    }
    if (!checkLoopbackPost(req, res)) return;
    try {
      const body = await readBody(req, IMPORT_BODY_LIMIT);
      const imported = [];
      const failed = [];
      const rawList = [];
      if (typeof body?.path === "string" && body.path.length > 0) {
        const target = body.path;
        const statModule = await import("node:fs/promises");
        const info = await statModule.stat(target);
        if (info.isDirectory()) {
          const names = await readdir(target);
          for (const name of names) {
            if (!name.endsWith(".json")) continue;
            rawList.push(await readFile(join(target, name), "utf8"));
          }
        } else {
          rawList.push(await readFile(target, "utf8"));
        }
      } else if (Array.isArray(body?.docs)) {
        for (const doc of body.docs) rawList.push(doc);
      } else if (body?.doc !== undefined) {
        rawList.push(body.doc);
      } else if (typeof body?.text === "string") {
        rawList.push(body.text);
      }
      if (rawList.length === 0) {
        json(res, 400, { ok: false, error: "没有可导入的内容" });
        return;
      }
      for (const raw of rawList) {
        try {
          const account = parseAccountDoc(raw);
          if (account.uid.length === 0) {
            // 没有 uid 时无法定位账号文件，跳过（Go 侧也需要 uid 做挑号）。
            failed.push({ error: "缺少 uid，无法导入" });
            continue;
          }
          await writeAccountFile(runtime.authsDir, account);
          imported.push({ uid: account.uid, nickname: account.nickname });
        } catch (error) {
          failed.push({ error: safeMessage(error) });
        }
      }
      if (imported.length > 0) await runtime.restart("accounts imported");
      json(res, 200, { ok: imported.length > 0, imported, failed });
    } catch (error) {
      json(res, 200, { ok: false, error: safeMessage(error) });
    }
  });

  // POST /login/start
  add("/login/start", async (req, res) => {
    if (req.method !== "POST") {
      json(res, 405, { error: "method not allowed" });
      return;
    }
    if (!checkLoopbackPost(req, res)) return;
    try {
      const started = await workbuddyLoginStart();
      runtime.pendingLogins.set(started.state, Date.now());
      // 清理超过时限还没完成的登录。
      for (const [state, at] of runtime.pendingLogins) {
        if (Date.now() - at > LOGIN_TTL_MS) runtime.pendingLogins.delete(state);
      }
      json(res, 200, { ok: true, authUrl: started.authUrl, state: started.state });
    } catch (error) {
      json(res, 200, { ok: false, error: safeMessage(error) });
    }
  });

  // POST /login/confirm  body: {state}
  // 由用户主动触发：他在浏览器里登录完成后，回到面板点「我已登录完成」。
  // 服务端只做一轮**有界**重试，不做无限自动轮询 —— 后台瞎猜不如让用户说一句。
  add("/login/confirm", async (req, res) => {
    if (req.method !== "POST") {
      json(res, 405, { error: "method not allowed" });
      return;
    }
    if (!checkLoopbackPost(req, res)) return;
    try {
      const body = await readBody(req);
      const state = String(body?.state ?? "");
      if (state.length === 0) {
        json(res, 400, { ok: false, error: 'expected {"state": string}' });
        return;
      }
      const startedAt = runtime.pendingLogins.get(state);
      if (startedAt === undefined) {
        // 会话里没有这个 state：多半是插件被重载过，或 state 已被回收。
        json(res, 200, {
          ok: false,
          done: true,
          error: "登录会话已失效，请重新点击「添加账号」",
        });
        return;
      }
      if (Date.now() - startedAt > LOGIN_TTL_MS) {
        runtime.pendingLogins.delete(state);
        json(res, 200, {
          ok: false,
          done: true,
          error: "登录超时（超过 10 分钟），请重新点击「添加账号」",
        });
        return;
      }
      // 有界重试：最多试 LOGIN_CONFIRM_ATTEMPTS 次，每次间隔 WB.pollIntervalMs。
      let token;
      for (let attempt = 1; attempt <= LOGIN_CONFIRM_ATTEMPTS; attempt += 1) {
        token = await workbuddyLoginPoll(state);
        if (token !== undefined) break;
        if (attempt < LOGIN_CONFIRM_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, WB.pollIntervalMs));
        }
      }
      if (token === undefined) {
        // 还没好：保留登录会话原样返回，让用户稍等几秒再点一次。
        json(res, 200, { ok: false, done: false, retry: true });
        return;
      }
      let account = { uid: "", enterpriseId: "", nickname: "" };
      try {
        account = await workbuddyFetchAccount(state, token.accessToken);
      } catch {
        // 拿不到资料也要把号存下来（与 Go 登录命令行为一致）。
      }
      if (account.uid.length === 0) {
        json(res, 200, { ok: false, done: true, error: "拿到了 token 但读不到 uid，请重试登录" });
        return;
      }
      const expiresAt = token.expiresIn > 0 ? Math.floor(Date.now() / 1000) + token.expiresIn : 0;
      const saved = {
        platform: "workbuddy",
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        expiresAt,
        domain: token.domain,
        uid: account.uid,
        enterpriseId: account.enterpriseId,
        nickname: account.nickname,
      };
      await writeAccountFile(runtime.authsDir, saved);
      runtime.pendingLogins.delete(state);
      let credits;
      try {
        credits = await workbuddyCredit(saved);
      } catch {
        credits = undefined;
      }
      await runtime.restart("account added");
      json(res, 200, {
        ok: true,
        done: true,
        account: { uid: saved.uid, nickname: saved.nickname, credits },
      });
    } catch (error) {
      json(res, 200, { ok: false, done: true, error: safeMessage(error) });
    }
  });

  // POST /refresh-models —— 面板点「刷新模型」时强制重拉上游清单。
  add("/refresh-models", async (req, res) => {
    if (req.method !== "POST") {
      json(res, 405, { error: "method not allowed" });
      return;
    }
    if (!checkLoopbackPost(req, res)) return;
    try {
      await runtime.fetchCatalog(true);
      await runtime.refreshModels(true);
      json(res, 200, {
        ok: true,
        catalog: runtime.catalog,
        models: runtime.models.map((item) => ({ id: item.id, name: item.name, credits: item.credits })),
      });
    } catch (error) {
      json(res, 200, { ok: false, error: safeMessage(error) });
    }
  });

  return () => {
    for (const dispose of routes) {
      try {
        dispose();
      } catch {
        // 已经被释放。
      }
    }
  };
}

/* ------------------------------------------------------------------ *
 * 配置
 * ------------------------------------------------------------------ */

export const Config = z.object({
  dataDir: z
    .string()
    .description("数据目录（账号池、配置、日志都放这里）。留空 = ~/.dsh/multi2api")
    .default("")
    .volatile(),
  port: z.natural().description("本地监听端口（被占用时自动往后找空闲端口）").default(7864).volatile(),
  contextWindow: z.natural().description("模型上下文窗口").default(DEFAULT_CONTEXT_WINDOW).volatile(),
  maxTokens: z.natural().description("单次回复最大 token 数").default(DEFAULT_MAX_TOKENS).volatile(),
  statusRefreshSeconds: z.natural().description("账号状态刷新间隔（秒）").default(30).volatile(),
  logLines: z.natural().description("日志面板默认显示行数").default(300).volatile(),
  autoStart: z.boolean().description("插件加载时自动启动 multi2api 进程").default(true).volatile(),
  autoCheckin: z
    .boolean()
    .description("自动签到：开启后每次启动 DSH 都会给所有账号签到一次")
    .default(true)
    .volatile(),
});

function unwrapValue(value, fallback) {
  const raw = value !== null && typeof value === "object" && typeof value.get === "function" ? value.get() : value;
  return raw === undefined || raw === null ? fallback : raw;
}

function readConfig(raw) {
  const source = raw ?? {};
  const configuredDir = String(unwrapValue(source.dataDir, "")).trim();
  const defaultDir = join(resolveDshHome(), "multi2api");
  const port = Number(unwrapValue(source.port, 7864));
  const contextWindow = Number(unwrapValue(source.contextWindow, DEFAULT_CONTEXT_WINDOW));
  const maxTokens = Number(unwrapValue(source.maxTokens, DEFAULT_MAX_TOKENS));
  const statusRefreshSeconds = Number(unwrapValue(source.statusRefreshSeconds, 30));
  const logLines = Number(unwrapValue(source.logLines, 300));
  const autoStart = Boolean(unwrapValue(source.autoStart, true));
  const autoCheckin = Boolean(unwrapValue(source.autoCheckin, true));
  return {
    dataDir: configuredDir.length > 0 ? configuredDir : defaultDir,
    port: Number.isFinite(port) && port > 0 ? Math.floor(port) : 7864,
    contextWindow: Number.isFinite(contextWindow) && contextWindow > 0 ? Math.floor(contextWindow) : DEFAULT_CONTEXT_WINDOW,
    maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : DEFAULT_MAX_TOKENS,
    statusRefreshSeconds:
      Number.isFinite(statusRefreshSeconds) && statusRefreshSeconds > 0 ? Math.floor(statusRefreshSeconds) : 30,
    logLines: Number.isFinite(logLines) && logLines > 0 ? Math.floor(logLines) : 300,
    autoStart,
    autoCheckin,
  };
}

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */

export const name = PLUGIN_NAME;
export const inject = ["llm"];

export function apply(ctx, rawConfig) {
  const config = readConfig(rawConfig);
  const runtime = createRuntime(ctx, config);

  installSettings(ctx, runtime);

  // 动态模型列表：后台定时刷新账号 → 模型映射；getModels() 每次读当前快照。
  ctx.effect(() => {
    const timer = setInterval(() => {
      void runtime.refreshModels(false);
    }, Math.max(5, config.statusRefreshSeconds) * 1000);
    if (typeof timer.unref === "function") timer.unref();
    return () => clearInterval(timer);
  }, "dsh-multi2api: 模型列表定时刷新");

  // webServer 惰性注入：拿不到就不注册面板接口，不影响模型转发。
  ctx.inject(["webServer"], (webCtx) => {
    const dispose = registerRoutes(webCtx, runtime);
    webCtx.effect(() => dispose, "dsh-multi2api: Web 管理接口");
  });

  // 进程生命周期跟着插件走。
  ctx.effect(
    () => () => {
      void runtime.stop();
    },
    "dsh-multi2api: 停止被托管的进程",
  );

  if (config.autoStart) {
    // 启动流程：先把被托管进程拉起来（内部会等健康检查通过），再按开关给所有账号签到一次。
    void (async () => {
      try {
        await runtime.start();
        if (runtime.readAutoCheckin()) await runtime.checkinAll();
      } catch (error) {
        ctx.logger.warn("dsh-multi2api: 启动自动签到失败", error);
      }
    })();
  }

  // 注册 pi-ai 供应商路由。
  try {
    const { adapter } = createAdapter(runtime);
    const releaseAdapter = ctx.llm.registerAdapter([PROVIDER], adapter);
    const releaseDirectory = ctx.llm.registerConfigurableProviders([
      {
        provider: PROVIDER,
        displayName: "Multi2API",
        settingsNs: runtime.settingsNs,
        settingsPath: [],
        declared: false,
      },
    ]);
    try {
      ctx.effect(
        () => () => {
          releaseAdapter();
          releaseDirectory();
        },
        "dsh-multi2api: 供应商注册",
      );
    } catch (error) {
      releaseAdapter();
      releaseDirectory();
      throw error;
    }
  } catch (error) {
    ctx.logger.error("dsh-multi2api: 注册供应商失败", error);
  }
}
