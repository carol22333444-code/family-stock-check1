import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { URL } from "node:url";

const execFileAsync = promisify(execFile);

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "0.0.0.0";
const IS_PUBLIC_DEPLOY =
  process.env.NODE_ENV === "production" ||
  Boolean(process.env.RENDER || process.env.RAILWAY_ENVIRONMENT || process.env.FLY_APP_NAME || process.env.VERCEL);
const FAMILY_PASSWORD = process.env.FAMILY_PASSWORD || (IS_PUBLIC_DEPLOY ? "" : "123456");
const SESSION_SECRET = process.env.SESSION_SECRET || (IS_PUBLIC_DEPLOY ? "" : randomBytes(32).toString("hex"));
const SESSION_DAYS = 7;
const MAX_FAILS = 5;
const failMap = new Map();
const DATA_MODE = process.env.MARKET_DATA_MODE || "public-quote-crosscheck";
const REFRESH_HOURS = new Set([7, 12, 17]);
const quoteCache = new Map();
const watchedStocks = new Map([["000543", { stockName: "皖能电力", stockCode: "000543" }]]);
let lastScheduledRefreshKey = "";

const publicDir = join(process.cwd(), "public");

if (IS_PUBLIC_DEPLOY && !process.env.FAMILY_PASSWORD) {
  throw new Error("公网部署必须设置 FAMILY_PASSWORD，不能使用默认演示密码。");
}

if (IS_PUBLIC_DEPLOY && !process.env.SESSION_SECRET) {
  throw new Error("公网部署必须设置 SESSION_SECRET，用于保护7天登录会话。");
}

const baseSecurityHeaders = {
  "content-security-policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join("; "),
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), accelerometer=(), gyroscope=()",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin"
};

function parseCookies(header = "") {
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim().split("="))
      .filter(([key, value]) => key && value)
      .map(([key, value]) => [key, decodeURIComponent(value)])
  );
}

function sign(value) {
  return createHmac("sha256", SESSION_SECRET).update(value).digest("base64url");
}

function makeSession() {
  const expiresAt = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  const payload = Buffer.from(JSON.stringify({ ok: true, expiresAt })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function isValidSession(token = "") {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return false;
  const expected = sign(payload);
  if (expected.length !== signature.length) return false;
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return false;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return parsed.ok === true && parsed.expiresAt > Date.now();
  } catch {
    return false;
  }
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...baseSecurityHeaders,
    ...headers
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1e6) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

function clientKey(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
}

function comparePassword(input) {
  const a = Buffer.from(String(input || ""));
  const b = Buffer.from(FAMILY_PASSWORD);
  return a.length === b.length && timingSafeEqual(a, b);
}

function requireSession(req, res) {
  const cookies = parseCookies(req.headers.cookie);
  if (isValidSession(cookies.family_stock_session)) return true;
  sendJson(res, 401, { ok: false, message: "请先输入家庭查看密码" });
  return false;
}

function formatShanghaiTime(date = new Date()) {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day} ${value.hour}:${value.minute}`;
}

function shanghaiParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    key: `${value.year}-${value.month}-${value.day}-${value.hour}-${value.minute}`,
    weekday: value.weekday,
    hour: Number(value.hour),
    minute: Number(value.minute)
  };
}

function isShanghaiWorkday(date = new Date()) {
  return !["Sat", "Sun"].includes(shanghaiParts(date).weekday);
}

function normalizeStockCode(input = {}) {
  const joined = `${input.stockCode || ""} ${input.stockName || ""}`;
  const matched = joined.match(/\b\d{6}\b/);
  return matched?.[0] || "000543";
}

function secidFor(code) {
  return `${code.startsWith("6") ? "1" : "0"}.${code}`;
}

function marketPrefix(code) {
  return code.startsWith("6") ? "sh" : "sz";
}

function tencentSymbol(code) {
  return `${marketPrefix(code)}${code}`;
}

function cninfoPlate(code) {
  return code.startsWith("6") ? "sh" : "sz";
}

function cninfoColumn(code) {
  return code.startsWith("6") ? "sse" : "szse";
}

function cninfoOrgId(code) {
  return `${code.startsWith("6") ? "gssh0" : "gssz0"}${code}`;
}

function quotePrice(value) {
  if (value == null || value === "-") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number / 100 : null;
}

function roundPrice(value) {
  return Number(Number(value).toFixed(2));
}

function average(values) {
  const usable = values.filter((value) => Number.isFinite(value));
  if (!usable.length) return null;
  return usable.reduce((sum, value) => sum + value, 0) / usable.length;
}

function movingAverage(rows, days) {
  if (rows.length < days) return null;
  return average(rows.slice(-days).map((row) => row.close));
}

async function fetchJson(url) {
  const parsed = new URL(url);
  if (!["qt.gtimg.cn", "hq.sinajs.cn", "web.ifzq.gtimg.cn", "www.cninfo.com.cn", "push2.eastmoney.com"].includes(parsed.hostname)) {
    throw new Error("数据源未授权");
  }
  const referer = parsed.hostname.includes("cninfo")
    ? "http://www.cninfo.com.cn/"
    : parsed.hostname.includes("eastmoney")
      ? "https://quote.eastmoney.com/"
      : "https://finance.sina.com.cn/";
  const args = ["-fsSL", "--max-time", "10", "-H", `Referer: ${referer}`, "-H", "User-Agent: Mozilla/5.0", url];
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const { stdout } = await execFileAsync("curl", args, {
        maxBuffer: 8 * 1024 * 1024
      });
      return stdout;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function postForm(url, data) {
  const parsed = new URL(url);
  if (!["www.cninfo.com.cn"].includes(parsed.hostname)) throw new Error("数据源未授权");
  const params = new URLSearchParams(data);
  const args = [
    "-fsSL",
    "--max-time",
    "10",
    "-H",
    "Referer: http://www.cninfo.com.cn/",
    "-H",
    "User-Agent: Mozilla/5.0",
    "-H",
    "Content-Type: application/x-www-form-urlencoded; charset=UTF-8",
    "-d",
    params.toString(),
    url
  ];
  const { stdout } = await execFileAsync("curl", args, {
    maxBuffer: 8 * 1024 * 1024
  });
  return stdout;
}

async function fetchTencentQuote(code) {
  const symbol = tencentSymbol(code);
  const url = `https://qt.gtimg.cn/q=${symbol}`;
  const text = await fetchJson(url);
  const matched = text.match(/="([^"]*)"/);
  if (!matched) throw new Error("腾讯行情数据解析失败");
  const fields = matched[1].split("~");
  const bidPrices = [9, 11, 13, 15, 17].map((index) => Number(fields[index])).filter(Number.isFinite);
  const askPrices = [19, 21, 23, 25, 27].map((index) => Number(fields[index])).filter(Number.isFinite);
  return {
    sourceName: "腾讯证券行情接口",
    sourceUrl: url,
    fetchedAt: formatShanghaiTime(),
    code: fields[2] || code,
    name: fields[1] || "",
    currentPrice: Number(fields[3]),
    high: Number(fields[33]),
    low: Number(fields[34]),
    open: Number(fields[5]),
    previousClose: Number(fields[4]),
    volume: Number(fields[36] || fields[6] || 0),
    amount: Number(fields[57] || 0) * 10000,
    turnoverRate: Number(fields[38]),
    change: Number(fields[31]),
    changePct: Number(fields[32]),
    amplitude: Number(fields[43]),
    bidLow: bidPrices.length ? Math.min(...bidPrices) : null,
    bidHigh: bidPrices.length ? Math.max(...bidPrices) : null,
    askLow: askPrices.length ? Math.min(...askPrices) : null,
    askHigh: askPrices.length ? Math.max(...askPrices) : null,
    limitUp: Number(fields[47]),
    limitDown: Number(fields[48]),
    rawTime: fields[30]
  };
}

async function fetchSinaQuote(code) {
  const symbol = tencentSymbol(code);
  const url = `https://hq.sinajs.cn/list=${symbol}`;
  const text = await fetchJson(url);
  const matched = text.match(/="([^"]*)"/);
  if (!matched) throw new Error("新浪行情数据解析失败");
  const fields = matched[1].split(",");
  return {
    sourceName: "新浪财经行情接口",
    sourceUrl: url,
    name: fields[0],
    open: Number(fields[1]),
    previousClose: Number(fields[2]),
    currentPrice: Number(fields[3]),
    high: Number(fields[4]),
    low: Number(fields[5]),
    volume: Number(fields[8]),
    amount: Number(fields[9])
  };
}

async function fetchTencentKline(code, limit = 260) {
  const symbol = tencentSymbol(code);
  const url = `https://web.ifzq.gtimg.cn/appstock/app/newfqkline/get?_var=kline_dayqfq&param=${symbol},day,,,${limit},qfq`;
  const text = await fetchJson(url);
  const jsonText = text.replace(/^[^{]+=/, "");
  const parsed = JSON.parse(jsonText);
  const rows = parsed.data?.[symbol]?.qfqday || parsed.data?.[symbol]?.day || [];
  return rows
    .map((row) => ({
      date: row[0],
      open: Number(row[1]),
      close: Number(row[2]),
      high: Number(row[3]),
      low: Number(row[4]),
      volume: Number(row[5]),
      turnoverRate: Number(row[7]),
      amount: Number(row[8]) * 10000
    }))
    .filter((row) => Number.isFinite(row.close));
}

function parseTencentLine(line, fallbackName = "") {
  const matched = line.match(/="([^"]*)"/);
  if (!matched) throw new Error("腾讯行情数据解析失败");
  const fields = matched[1].split("~");
  return {
    sourceName: "腾讯证券行情接口",
    fetchedAt: formatShanghaiTime(),
    code: fields[2] || "",
    name: fallbackName || fields[1] || "",
    currentPrice: Number(fields[3]),
    high: Number(fields[33]),
    low: Number(fields[34]),
    open: Number(fields[5]),
    previousClose: Number(fields[4]),
    volume: Number(fields[36] || fields[6] || 0),
    amount: Number(fields[37] || fields[57] || 0) * 10000,
    turnoverRate: Number(fields[38]),
    change: Number(fields[31]),
    changePct: Number(fields[32]),
    amplitude: Number(fields[43]),
    rawTime: fields[30]
  };
}

async function fetchIndexQuotes() {
  const url = "https://qt.gtimg.cn/q=sh000001,sz399001,sz399006";
  const text = await fetchJson(url);
  const lines = text.split("\n").filter(Boolean);
  const names = ["上证指数", "深成指", "创业板指"];
  return lines.map((line, index) => parseTencentLine(line, names[index])).filter((item) => Number.isFinite(item.currentPrice));
}

async function fetchMarketBreadth() {
  const url = "https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&fields=f2,f3,f4,f12,f13,f14,f104,f105,f106&secids=1.000001,0.399001,0.399006";
  const text = await fetchJson(url);
  const json = JSON.parse(text);
  const rows = json.data?.diff || [];
  const breadthRows = rows.filter((item) => ["000001", "399001"].includes(String(item.f12)));
  const up = breadthRows.reduce((sum, item) => sum + (Number(item.f104) || 0), 0);
  const down = breadthRows.reduce((sum, item) => sum + (Number(item.f105) || 0), 0);
  const flat = breadthRows.reduce((sum, item) => sum + (Number(item.f106) || 0), 0);
  const strongest = rows
    .map((item) => `${item.f14}${Number.isFinite(Number(item.f3)) ? `${Number(item.f3).toFixed(1)}%` : ""}`)
    .join("、");
  return { total: up + down + flat, up, down, flat, limitUp: null, limitDown: null, amount: null, strongest };
}

async function fetchMarketSnapshot(directionCards = []) {
  const [indexes, breadthResult] = await Promise.all([
    fetchIndexQuotes().catch(() => []),
    fetchMarketBreadth().catch(() => null)
  ]);
  const avgPct = average(indexes.map((item) => item.changePct)) || 0;
  const upRatio = breadthResult?.total ? breadthResult.up / breadthResult.total : null;
  const limitDown = breadthResult?.limitDown ?? null;

  let level = "watch";
  let weather = "中性";
  if (avgPct > 0.35 && (upRatio == null || upRatio > 0.55) && (limitDown == null || limitDown < 15)) {
    level = "safe";
    weather = "顺风";
  } else if (avgPct < -0.45 || (upRatio != null && upRatio < 0.4) || (limitDown != null && limitDown >= 25)) {
    level = "risk";
    weather = "逆风";
  }

  const turnover = breadthResult?.amount
    ? `${Math.round(breadthResult.amount / 100000000)}亿`
    : indexes.length
      ? `${Math.round(indexes.reduce((sum, item) => sum + (item.amount || 0), 0) / 100000000)}亿`
      : "获取失败";
  const profitEffect = upRatio == null
    ? avgPct > 0.35
      ? "一般偏强"
      : avgPct < -0.35
        ? "弱"
        : "一般"
    : upRatio > 0.58
      ? "强"
      : upRatio < 0.42
        ? "弱"
        : "一般";
  const hotStyle = directionCards
    .filter((item) => Number.isFinite(item.avgChangePct))
    .sort((a, b) => b.avgChangePct - a.avgChangePct)[0]?.name || breadthResult?.strongest || "待确认";
  const sentence = level === "safe"
    ? "市场不算难做，但也别追太急。"
    : level === "risk"
      ? "今天先防风险，少乱动。"
      : "适合看持仓风险，不适合追高。";

  return {
    weather,
    weatherLevel: level,
    turnover,
    profitEffect,
    hotStyle,
    sentence,
    indexes,
    breadth: breadthResult
  };
}

async function fetchCninfoAnnouncements(code, pageSize = 30) {
  const plate = cninfoPlate(code);
  const column = cninfoColumn(code);
  const orgId = cninfoOrgId(code);
  const text = await postForm("https://www.cninfo.com.cn/new/hisAnnouncement/query", {
    pageNum: "1",
    pageSize: String(pageSize),
    column,
    tabName: "fulltext",
    plate,
    stock: `${code},${orgId}`,
    searchkey: "",
    secid: "",
    category: "",
    trade: "",
    seDate: "",
    sortName: "time",
    sortType: "desc",
    isHLtitle: "true"
  });
  const json = JSON.parse(text);
  return (json.announcements || []).map((item) => ({
    title: String(item.announcementTitle || item.shortTitle || ""),
    time: Number(item.announcementTime || 0),
    date: item.announcementTime ? formatShanghaiTime(new Date(Number(item.announcementTime))).slice(0, 10) : "",
    url: item.adjunctUrl ? `https://static.cninfo.com.cn/${item.adjunctUrl}` : ""
  }));
}

function classifyAnnouncements(announcements = [], quote = {}) {
  const now = Date.now();
  const daysAgo = (days) => now - days * 24 * 60 * 60 * 1000;
  const recent = announcements.filter((item) => item.time >= daysAgo(180));
  const last30 = announcements.filter((item) => item.time >= daysAgo(30));
  const findTitle = (pattern, list = recent) => list.find((item) => pattern.test(item.title));
  const eventText = (pattern, emptyText) => {
    const hit = findTitle(pattern);
    return hit ? `${hit.date}：${hit.title}` : emptyText;
  };
  const majorRiskPattern = /立案|处罚|非标|债务逾期|违规担保|重大诉讼|重大仲裁|退市|暂停上市|风险警示|司法冻结|高比例质押/;
  const noticeRiskPattern = /减持|解禁|问询|关注函|监管函|诉讼|仲裁|质押|担保|立案|处罚/;
  const majorRisk = findTitle(majorRiskPattern);
  const noticeRisk = findTitle(noticeRiskPattern, last30);
  const isSt = /^\*?ST/i.test(String(quote.name || ""));

  return {
    sourceOk: true,
    announcements,
    oneVoteState: isSt || majorRisk ? "risk" : "safe",
    oneVoteText: isSt ? "ST风险" : majorRisk ? "近期有重大风险公告" : "无",
    announcementState: noticeRisk ? "risk" : "safe",
    announcementText: noticeRisk ? "有需关注公告" : "暂无重大风险",
    events: [
      { label: "财报披露", state: findTitle(/季度报告|年度报告|半年度报告/) ? "safe" : "missing", text: eventText(/季度报告|年度报告|半年度报告/, "近180天未检索到") },
      { label: "减持公告", state: findTitle(/减持/) ? "risk" : "safe", text: eventText(/减持/, "暂无") },
      { label: "限售解禁", state: findTitle(/限售|解禁/) ? "risk" : "safe", text: eventText(/限售|解禁/, "暂无") },
      { label: "监管问询", state: findTitle(/问询|关注函|监管函/) ? "risk" : "safe", text: eventText(/问询|关注函|监管函/, "暂无") },
      { label: "分红除权", state: findTitle(/分红|权益分派|利润分配/) ? "watch" : "safe", text: eventText(/分红|权益分派|利润分配/, "暂无") }
    ]
  };
}

async function getMarketData(input = {}, force = false) {
  const code = normalizeStockCode(input);
  watchedStocks.set(code, { ...input, stockCode: code });
  const cached = quoteCache.get(code);
  if (!force && cached && Date.now() - cached.cachedAt < 60 * 1000) return cached;

  const [quote, crossCheck, klines, announcements] = await Promise.all([
    fetchTencentQuote(code),
    fetchSinaQuote(code).catch(() => null),
    fetchTencentKline(code).catch(() => []),
    fetchCninfoAnnouncements(code).catch(() => null)
  ]);
  const quoteDiff = crossCheck?.currentPrice ? Math.abs(quote.currentPrice - crossCheck.currentPrice) : null;
  const risk = announcements ? classifyAnnouncements(announcements, quote) : {
    sourceOk: false,
    announcements: [],
    oneVoteState: "missing",
    oneVoteText: "公告获取失败",
    announcementState: "missing",
    announcementText: "公告获取失败",
    events: [
      { label: "财报披露", state: "missing", text: "获取失败" },
      { label: "减持公告", state: "missing", text: "获取失败" },
      { label: "限售解禁", state: "missing", text: "获取失败" },
      { label: "监管问询", state: "missing", text: "获取失败" },
      { label: "分红除权", state: "missing", text: "获取失败" }
    ]
  };
  const bundle = { code, quote, crossCheck, quoteDiff, klines, risk, cachedAt: Date.now() };
  quoteCache.set(code, bundle);
  return bundle;
}

function buildPriceModel(quote, klines = []) {
  const currentPrice = quote.currentPrice || 0;
  const ma20 = movingAverage(klines, 20);
  const ma60 = movingAverage(klines, 60);
  const ma250 = movingAverage(klines, 250);
  const high52 = klines.length ? Math.max(...klines.slice(-252).map((row) => row.high)) : quote.high || currentPrice;
  const low52 = klines.length ? Math.min(...klines.slice(-252).map((row) => row.low)) : quote.low || currentPrice;
  const latest = klines.at(-1);
  const avg20Volume = average(klines.slice(-20).map((row) => row.volume));
  const amountRatio = avg20Volume && latest?.volume ? latest.volume / avg20Volume : null;
  const position52 = high52 > low52 ? (currentPrice - low52) / (high52 - low52) : 0.5;
  const buyBase = Math.min(currentPrice, ma20 || currentPrice, quote.low || currentPrice);
  const sellBase = Math.max(currentPrice, quote.high || currentPrice, ma20 || currentPrice);
  const buyWatchLow = roundPrice(Math.max(low52, buyBase * 0.99));
  const buyWatchHigh = roundPrice(Math.max(buyWatchLow, Math.min(currentPrice, buyBase * 1.005)));
  const sellWatchLow = roundPrice(Math.max(currentPrice, sellBase * 0.995));
  const sellWatchHigh = roundPrice(Math.max(sellWatchLow, sellBase * 1.01));
  const stopLossPrice = roundPrice(Math.max(low52, Math.min(quote.low || currentPrice, ma60 ? ma60 * 0.985 : currentPrice * 0.97)));

  let priceText = "中位观察";
  let priceState = "watch";
  if (position52 <= 0.35 || currentPrice <= buyWatchHigh) {
    priceText = "贴近观察区";
    priceState = "safe";
  } else if (position52 >= 0.75 || currentPrice >= sellWatchLow) {
    priceText = "位置偏高";
    priceState = "watch";
  }

  return {
    currentPrice: roundPrice(currentPrice),
    ma20,
    ma60,
    ma250,
    high52,
    low52,
    position52,
    amountRatio,
    priceText,
    priceState,
    stopLossPrice,
    buyWatchLow,
    buyWatchHigh,
    sellWatchLow,
    sellWatchHigh
  };
}

const directionPools = [
  {
    name: "高股息央国企",
    fit: "稳健型，怕大跌，重视分红的人。",
    reason: "用重点观察股的实时涨跌、52周位置和量能判断是否还在低位。",
    condition: "52周位置不高、短期涨幅不过热、量能没有异常放大。",
    metrics: "实时涨跌幅、52周位置、20日均量、公告风险",
    stocks: [
      ["601088", "中国神华"],
      ["600900", "长江电力"],
      ["601225", "陕西煤业"],
      ["600941", "中国移动"]
    ]
  },
  {
    name: "电力运营",
    fit: "想看防守和周期修复，但不想追高的人。",
    reason: "用电力运营股的实时位置和量能，观察是否低位修复。",
    condition: "接近20日线或60日线，未明显放量冲高，公告无重大风险。",
    metrics: "实时涨跌幅、20日线、60日线、成交量变化",
    stocks: [
      ["000543", "皖能电力"],
      ["600011", "华能国际"],
      ["600795", "国电电力"],
      ["600021", "上海电力"]
    ]
  },
  {
    name: "通信设备",
    fit: "能接受波动，但不想追热门高潮的人。",
    reason: "用通信设备重点股的实时涨跌和52周位置，判断情绪是否过热。",
    condition: "方向不在高潮日，重点股回到相对合理位置再观察。",
    metrics: "实时涨跌幅、52周位置、成交量变化、板块强弱",
    stocks: [
      ["000063", "中兴通讯"],
      ["600522", "中天科技"],
      ["600487", "亨通光电"],
      ["300308", "中际旭创"]
    ]
  }
];

async function summarizeDirection(pool) {
  const rows = await Promise.all(pool.stocks.map(async ([code, name]) => {
    const [quote, klines] = await Promise.all([
      fetchTencentQuote(code).then((item) => ({ ...item, name })).catch(() => null),
      fetchTencentKline(code, 260).catch(() => [])
    ]);
    if (!quote) return null;
    const model = buildPriceModel(quote, klines);
    return {
      code,
      name,
      changePct: quote.changePct,
      position52: model.position52,
      volumeRatio: model.amountRatio,
      currentPrice: model.currentPrice
    };
  }));
  const usable = rows.filter(Boolean);
  const avgChangePct = average(usable.map((item) => item.changePct));
  const avgPosition52 = average(usable.map((item) => item.position52));
  const avgVolumeRatio = average(usable.map((item) => item.volumeRatio));
  let status = "可以观察";
  if (avgChangePct != null && avgChangePct >= 4) status = "不追，等回踩";
  else if (avgPosition52 != null && avgPosition52 <= 0.35) status = "低位观察";
  else if (avgPosition52 != null && avgPosition52 >= 0.75) status = "风险较高";
  const risk = status === "风险较高"
    ? "重点股已经接近52周高位，别把回调当低位。"
    : status === "不追，等回踩"
      ? "短期涨幅偏大，等回踩再看。"
      : "仍需确认公告和成交量，不代表现在就买。";
  const selectedStocks = usable.length
    ? usable.map((item) => `${item.name}${Number.isFinite(item.changePct) ? `(${item.changePct.toFixed(1)}%)` : ""}`).join("、")
    : pool.stocks.map(([, name]) => name).join("、");
  return {
    name: pool.name,
    status,
    fit: pool.fit,
    reason: pool.reason,
    condition: pool.condition,
    stocks: selectedStocks,
    metrics: `${pool.metrics}${avgPosition52 != null ? `；平均52周位置${Math.round(avgPosition52 * 100)}%` : ""}${avgVolumeRatio != null ? `；量能${avgVolumeRatio.toFixed(1)}倍` : ""}`,
    risk,
    avgChangePct,
    avgPosition52
  };
}

async function buildDirectionCards() {
  const settled = await Promise.allSettled(directionPools.map((pool) => summarizeDirection(pool)));
  return settled.map((result, index) => result.status === "fulfilled" ? result.value : {
    name: directionPools[index].name,
    status: "数据获取失败",
    fit: directionPools[index].fit,
    reason: "实时行情或历史行情暂时获取失败，暂不下结论。",
    condition: "等待数据恢复。",
    stocks: directionPools[index].stocks.map(([, name]) => name).join("、"),
    metrics: directionPools[index].metrics,
    risk: "数据未完整获取前，只作观察清单。",
    avgChangePct: null,
    avgPosition52: null
  });
}

async function analyzeStock(input = {}) {
  const [bundle, directions] = await Promise.all([
    getMarketData(input),
    buildDirectionCards()
  ]);
  const { quote, crossCheck, quoteDiff, klines, risk } = bundle;
  const model = buildPriceModel(quote, klines);
  const marketSnapshot = await fetchMarketSnapshot(directions).catch(() => ({
    weather: "数据获取失败",
    weatherLevel: "missing",
    turnover: "获取失败",
    profitEffect: "待确认",
    hotStyle: directions[0]?.name || "待确认",
    sentence: "市场数据暂时获取失败，先不下结论。",
    indexes: [],
    breadth: null
  }));
  const isHolding = input.ownership === "bought";
  const cost = Number(input.costPrice || 7.58);
  const currentPrice = model.currentPrice;
  const profitPct = isHolding && cost > 0 ? ((currentPrice - cost) / cost) * 100 : null;
  const heavyPosition = input.position === "very-heavy" || input.position === "more";
  const allowsT = input.allowT === true && input.habit !== "conservative";
  const liquidityState = quote.amount >= 50_000_000 ? "safe" : "watch";
  const liquidityText = quote.amount >= 50_000_000 ? "正常" : "偏弱";
  const chipsText = model.amountRatio == null
    ? "量能待确认"
    : model.amountRatio > 1.25
      ? "放量分歧"
      : model.amountRatio < 0.75
        ? "缩量观望"
        : "量能平稳";
  const chipsState = model.amountRatio == null ? "missing" : model.amountRatio > 1.25 ? "watch" : "safe";
  const canSmallT = isHolding && allowsT && !heavyPosition && liquidityState === "safe" && risk.oneVoteState !== "risk" && risk.announcementState !== "risk";
  const buyZone = `${model.buyWatchLow}-${model.buyWatchHigh}元`;
  const sellZone = `${model.sellWatchLow}-${model.sellWatchHigh}元`;
  const stopLine = `${model.stopLossPrice}元`;
  const conclusion = risk.oneVoteState === "risk"
    ? "有风险公告，先别乱动"
    : model.priceState === "safe"
      ? "价格接近观察区"
      : "还没到舒服位置";
  const action = risk.oneVoteState === "risk"
    ? "先看公告风险"
    : model.priceState === "safe"
      ? "小心观察，不追高"
      : "继续等回踩";

  return {
    meta: {
      updatedAt: quote.fetchedAt,
      syncStatus: quoteDiff == null || quoteDiff <= 0.01 ? "ok" : "partial",
      dataMode: DATA_MODE,
      sourceName: `${quote.sourceName}${crossCheck ? "，新浪财经行情交叉校验" : ""}，巨潮公告校验，腾讯历史行情测算均线`,
      notice: `实时价格来自${quote.sourceName}${crossCheck ? "，并用新浪财经行情交叉校验" : ""}；公告来自巨潮资讯；均线和价格位置来自腾讯历史行情。`
    },
    market: {
      weather: marketSnapshot.weather,
      weatherLevel: marketSnapshot.weatherLevel,
      turnover: marketSnapshot.turnover,
      profitEffect: marketSnapshot.profitEffect,
      hotStyle: marketSnapshot.hotStyle,
      sentence: marketSnapshot.sentence
    },
    stock: {
      name: input.stockName?.trim() || quote.name || "皖能电力",
      code: quote.code || input.stockCode?.trim() || "000543",
      currentPrice,
      priceSource: `${quote.sourceName}${crossCheck ? "｜新浪校验" : ""}｜${quote.fetchedAt}`,
      conclusion,
      action,
      keyReminder: `${buyZone}附近再看`,
      plainText: "价格尺基于实时盘口、当日高低点、20日线和60日线测算；跌破防守线要先防风险。",
      signals: [
        { label: "价格位置", state: model.priceState, text: model.priceText },
        { label: "一票否决", state: risk.oneVoteState, text: risk.oneVoteText },
        { label: "市场环境", state: marketSnapshot.weatherLevel, text: marketSnapshot.weather },
        { label: "流动性", state: liquidityState, text: liquidityText },
        { label: "公告风险", state: risk.announcementState, text: risk.announcementText },
        { label: "资金筹码", state: chipsState, text: chipsText },
        { label: "做T条件", state: canSmallT ? "watch" : "risk", text: canSmallT ? "只适合小T" : "先别做T" }
      ],
      ruler: {
        stopLossPrice: model.stopLossPrice,
        buyWatchLow: model.buyWatchLow,
        buyWatchHigh: model.buyWatchHigh,
        sellWatchLow: model.sellWatchLow,
        sellWatchHigh: model.sellWatchHigh
      }
    },
    holding: {
      isHolding,
      costPrice: cost,
      profitPct,
      status: risk.oneVoteState === "risk" ? "有公告风险" : heavyPosition ? "仓位偏重，先控风险" : "暂时安全",
      value: model.priceText,
      logic: risk.announcementState === "risk" ? "有公告需关注" : "公告未见重大风险",
      defenseLine: model.stopLossPrice,
      treatment: risk.oneVoteState === "risk" ? "先看公告风险" : heavyPosition ? "先别加仓，按防守线观察" : "继续看价格和防守线",
      explanation: `当前价来自实时行情，防守线按当日低点和60日线测算。若跌破${stopLine}并收不回来，先防风险。`,
      watchConclusion: "可以观察，但不急着追。",
      comfortPrice: buyZone,
      riskLine: stopLine
    },
    tPlan: {
      suitable: canSmallT ? "仅价格区间可观察" : "暂不下结论",
      buyZone,
      sellZone,
      invalidLine: stopLine,
      ratio: canSmallT ? "不超过20%" : "先不做T",
      reason: canSmallT
        ? "区间来自实时盘口、均线和当日高低点测算；空间不大，只适合小比例。"
        : "当前公告、市场环境、仓位或流动性条件不够完整，先不要把它当成做T信号。"
    },
    deepDive: {
      wind: {
        market: marketSnapshot.weather,
        sector: directions.find((item) => item.name.includes("电力"))?.status || "按个股观察",
        industry: directions.find((item) => item.name.includes("电力"))?.status || "按个股观察",
        voice: chipsText,
        explanation: marketSnapshot.weatherLevel === "safe" ? "市场不算逆风，但个股仍要看价格和公告。" : marketSnapshot.weatherLevel === "risk" ? "大盘环境偏弱，先少动。" : "现在不是不能看，但也不是顺风局，更适合等回踩。"
      },
      events: risk.events,
      focus: {
        conflict: "电力股核心看成本、电价和发电量。",
        variables: ["公告和财报是否有经营变化", "电力方向是否低位修复", "成交量是否温和放大而不是过热"],
        explanation: "这只股票不是看故事，先看公告、价格位置和电力方向强弱。"
      },
      expensive: {
        pricePosition: model.priceText,
        ma20: model.ma20 ? (currentPrice >= model.ma20 ? `高于20日线 ${roundPrice(model.ma20)}元` : `低于20日线 ${roundPrice(model.ma20)}元`) : "获取失败",
        ma60: model.ma60 ? (currentPrice >= model.ma60 ? `高于60日线 ${roundPrice(model.ma60)}元` : `低于60日线 ${roundPrice(model.ma60)}元`) : "获取失败",
        volume: chipsText,
        chips: chipsText,
        judgment: model.priceState === "safe" ? "接近观察区，但仍要看公告风险。" : "还没到舒服位置，继续等。"
      }
    },
    directions
  };
}

async function refreshWatchedStocks() {
  const inputs = [...watchedStocks.values()];
  await Promise.allSettled(inputs.map((input) => getMarketData(input, true)));
}

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const filePath = normalize(join(publicDir, requested));
  if (!filePath.startsWith(publicDir) || !existsSync(filePath)) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }
  res.writeHead(200, {
    "content-type": mime[extname(filePath)] || "application/octet-stream",
    "cache-control": "no-cache",
    ...baseSecurityHeaders
  });
  createReadStream(filePath).pipe(res);
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === "/api/session" && req.method === "GET") {
      const cookies = parseCookies(req.headers.cookie);
      sendJson(res, 200, { ok: isValidSession(cookies.family_stock_session) });
      return;
    }

    if (url.pathname === "/api/login" && req.method === "POST") {
      const key = clientKey(req);
      const record = failMap.get(key) || { count: 0, resetAt: 0 };
      if (record.count >= MAX_FAILS && record.resetAt > Date.now()) {
        sendJson(res, 429, { ok: false, message: "密码错误次数较多，稍后再试。" });
        return;
      }
      const body = await readBody(req);
      if (!comparePassword(body.password)) {
        failMap.set(key, { count: record.count + 1, resetAt: Date.now() + 15 * 60 * 1000 });
        sendJson(res, 401, { ok: false, message: "密码不对，再看一下。" });
        return;
      }
      failMap.delete(key);
      sendJson(res, 200, { ok: true }, {
        "set-cookie": `family_stock_session=${encodeURIComponent(makeSession())}; Max-Age=${SESSION_DAYS * 24 * 60 * 60}; HttpOnly; SameSite=Lax; Path=/`
      });
      return;
    }

    if (url.pathname === "/api/logout" && req.method === "POST") {
      sendJson(res, 200, { ok: true }, {
        "set-cookie": "family_stock_session=; Max-Age=0; HttpOnly; SameSite=Lax; Path=/"
      });
      return;
    }

    if (url.pathname === "/api/analyze" && req.method === "POST") {
      if (!requireSession(req, res)) return;
      const body = await readBody(req);
      const data = await analyzeStock(body);
      sendJson(res, 200, { ok: true, data });
      return;
    }

    if (url.pathname === "/api/refresh" && req.method === "POST") {
      if (!requireSession(req, res)) return;
      await refreshWatchedStocks();
      sendJson(res, 200, { ok: true, refreshedAt: formatShanghaiTime() });
      return;
    }

    serveStatic(req, res);
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { ok: false, message: "服务暂时开小差了，请稍后再试。" });
  }
}).listen(PORT, HOST, () => {
  console.log(`A股家庭持仓体检页已启动：http://${HOST}:${PORT}`);
  console.log("行情数据：腾讯证券行情接口为主，新浪财经行情交叉校验。演示默认密码为 123456。部署时请设置 FAMILY_PASSWORD。");
});

setInterval(() => {
  const parts = shanghaiParts();
  if (!isShanghaiWorkday() || parts.minute !== 0 || !REFRESH_HOURS.has(parts.hour)) return;
  if (parts.key === lastScheduledRefreshKey) return;
  lastScheduledRefreshKey = parts.key;
  refreshWatchedStocks().catch((error) => {
    console.error("定时刷新行情失败：", error.message);
  });
}, 60 * 1000);
