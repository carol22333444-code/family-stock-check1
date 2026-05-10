const app = document.querySelector("#app");
const STATIC_SNAPSHOT = true;
let staticDataPromise = null;

const watchlist = [
  { name: "皖能电力", code: "000543", defaultCost: "7.58" },
  { name: "沃尔核材", code: "002130", defaultCost: "" },
  { name: "东方财富", code: "300059", defaultCost: "" }
];

const stateIcon = {
  safe: "🟢",
  watch: "🟡",
  risk: "🔴",
  missing: "⚪"
};

const stateClass = {
  safe: "safe",
  watch: "watch",
  risk: "risk",
  missing: "missing"
};

const formState = {
  stockName: "皖能电力",
  stockCode: "000543",
  ownership: "bought",
  costPrice: "7.58",
  position: "some",
  habit: "auto",
  allowT: true
};

let analysis = null;
let currentStep = 1;
let formError = "";
let lastClientRefreshKey = "";

async function api(path, options = {}) {
  if (STATIC_SNAPSHOT) {
    if (path === "/api/session" || path === "/api/login" || path === "/api/logout") return { ok: true };
    if (path === "/api/analyze") {
      const payload = options.body ? JSON.parse(options.body) : {};
      if (!staticDataPromise) {
        staticDataPromise = fetch("data.json", { cache: "no-store" }).then((res) => {
          if (!res.ok) throw new Error("静态数据读取失败");
          return res.json();
        });
      }
      const snapshot = await staticDataPromise;
      const code = normalizeWatchlistCode(payload);
      const selected = snapshot.analyses?.[code] || snapshot.analyses?.[snapshot.defaultCode] || snapshot;
      return { ok: true, data: applyClientInputToAnalysis(selected, payload) };
    }
  }
  const res = await fetch(path, {
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    credentials: "same-origin",
    ...options
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.message || "请求失败");
  return body;
}

function yuan(value) {
  return `${Number(value).toFixed(2)}元`;
}

function pct(value) {
  if (value == null) return "";
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}%`;
}

function setForm(key, value) {
  formState[key] = value;
  renderMain();
}

function selectStock(code) {
  const selected = watchlist.find((item) => item.code === code);
  if (!selected) return;
  const previousCode = formState.stockCode;
  formState.stockName = selected.name;
  formState.stockCode = selected.code;
  if (previousCode !== selected.code) {
    formState.costPrice = selected.defaultCost;
    if (!selected.defaultCost) formState.ownership = "watch";
  }
  renderMain();
}

function choice(label, key, value) {
  const active = formState[key] === value ? "active" : "";
  return `<button class="choice ${active}" data-set="${key}" data-value="${value}">${label}</button>`;
}

function stockChoice(item) {
  const active = formState.stockCode === item.code ? "active" : "";
  return `
    <button class="choice stock-choice ${active}" data-stock-code="${item.code}">
      <strong>${item.name}</strong>
      <span>${item.code}</span>
    </button>
  `;
}

function normalizeWatchlistCode(input = {}) {
  const joined = `${input.stockCode || ""} ${input.stockName || ""}`;
  const code = joined.match(/\b\d{6}\b/)?.[0];
  if (code && watchlist.some((item) => item.code === code)) return code;
  const byName = watchlist.find((item) => joined.includes(item.name));
  return byName?.code || watchlist[0].code;
}

function applyClientInputToAnalysis(rawData, input = {}) {
  const data = JSON.parse(JSON.stringify(rawData));
  const isHolding = input.ownership === "bought";
  const cost = Number(input.costPrice || 0);
  const heavyPosition = input.position === "very-heavy" || input.position === "more";
  const allowsT = input.allowT === true && input.habit !== "conservative";
  data.holding.isHolding = isHolding;
  if (isHolding && cost > 0) {
    data.holding.costPrice = cost;
    data.holding.profitPct = ((data.stock.currentPrice - cost) / cost) * 100;
  } else {
    data.holding.profitPct = null;
  }
  const tSignal = data.stock.signals.find((item) => item.label === "做T条件");
  if (!isHolding || !allowsT || heavyPosition) {
    data.tPlan.suitable = "暂不下结论";
    data.tPlan.ratio = "先不做T";
    data.tPlan.reason = "静态快照只能给观察区间；没有底仓、仓位偏重或不允许做T时，不把它当成做T信号。";
    if (tSignal) {
      tSignal.state = "risk";
      tSignal.text = "先别做T";
    }
  }
  if (heavyPosition && isHolding) {
    data.holding.status = "仓位偏重，先控风险";
    data.holding.treatment = "先别加仓，按防守线观察";
  }
  return data;
}

function orderedSignals(signals = []) {
  const order = { risk: 0, watch: 1, safe: 2, missing: 3 };
  return [...signals].sort((a, b) => (order[a.state] ?? 9) - (order[b.state] ?? 9));
}

function updateBar(meta = {}) {
  if (meta.updateFailed) return `<div class="update-bar">数据最近更新失败，请稍后重试</div>`;
  const suffix = meta.syncStatus === "partial" ? "｜部分数据待同步" : "";
  const notice = meta.notice ? `<div class="update-notice">${meta.notice}</div>` : "";
  return `<div class="update-bar">数据最近更新：${meta.updatedAt || "2026-05-10 14:35"}${suffix}</div>${notice}`;
}

function sectionHeader(type, icon, title, subtitle) {
  return `
    <div class="section-banner ${type}">
      <div class="section-banner-title">${icon} ${title}</div>
      <div class="section-banner-subtitle">${subtitle}</div>
    </div>
  `;
}

function progressSteps() {
  const steps = [
    ["1", "输入"],
    ["2", "结论"],
    ["3", "价位"],
    ["4", "原因"]
  ];
  const subtitles = {
    1: "输入股票信息",
    2: "体检结论",
    3: "关键价位",
    4: "理由拆解"
  };
  return `
    <div class="stock-flow-head">
      <div class="stock-flow-title">个股体检 · 第 ${currentStep} 步</div>
      <div class="stock-flow-subtitle">${subtitles[currentStep]}</div>
    </div>
    <div class="stepper" aria-label="个股分析进度">
      ${steps.map(([num, label], index) => `
        <div class="step ${currentStep === index + 1 ? "active" : ""} ${currentStep > index + 1 ? "done" : ""}">
          <span>${num}</span>${label}
        </div>
      `).join("<div class=\"step-arrow\">→</div>")}
    </div>
  `;
}

function pager(leftLabel, rightLabel) {
  return `
    <div class="pager">
      <button class="secondary" data-nav="prev">${leftLabel}</button>
      <button class="primary" data-nav="${rightLabel === "回到开始" ? "start" : "next"}">${rightLabel}</button>
    </div>
  `;
}

function weatherCard(data) {
  return `
    <section class="card">
      <div class="weather-line">
        <div>
          <h2 class="section-title">今天市场天气</h2>
          <div class="weather-main">${data.weather}</div>
        </div>
      </div>
      <div class="mini-grid">
        <div class="metric"><span>成交额</span><strong>${data.turnover}</strong></div>
        <div class="metric"><span>赚钱效应</span><strong>${data.profitEffect}</strong></div>
        <div class="metric"><span>热门风格</span><strong>${data.hotStyle}</strong></div>
        <div class="metric"><span>市场天气</span><strong>中性</strong></div>
      </div>
      <p class="sentence">今日一句话：${data.sentence}</p>
    </section>
  `;
}

function inputCard() {
  const bought = formState.ownership === "bought";
  return `
    <section class="card" id="inputCard">
      <div class="field">
        <div class="label">选择自选股</div>
        <div class="stock-options">
          ${watchlist.map(stockChoice).join("")}
        </div>
        <p class="helper-text">第一版只分析这三只自选股，避免把不完整数据说成确定结论。</p>
      </div>
      <div class="field">
        <div class="label">我是否已经买了</div>
        <div class="segmented">
          ${choice("已买入", "ownership", "bought")}
          ${choice("只是看看", "ownership", "watch")}
        </div>
      </div>
      <div class="${bought ? "" : "hidden"}">
        <div class="field">
          <label class="label" for="costPrice">我的成本价</label>
          <input class="input" id="costPrice" inputmode="decimal" placeholder="请输入，如 7.80" value="${formState.costPrice}" />
        </div>
        <div class="field">
          <div class="label">我的仓位</div>
          <div class="choice-row four">
            ${choice("很少一点", "position", "little")}
            ${choice("不多", "position", "some")}
            ${choice("比较多", "position", "more")}
            ${choice("已经很重", "position", "very-heavy")}
          </div>
        </div>
      </div>
      <div class="field">
        <div class="label">操作习惯</div>
        <div class="choice-row four">
          ${choice("保守，不想折腾", "habit", "conservative")}
          ${choice("可以偶尔做T", "habit", "t")}
          ${choice("想看中线", "habit", "mid")}
          ${choice("不确定，让系统判断", "habit", "auto")}
        </div>
      </div>
      <div class="field">
        <div class="label">是否允许做T</div>
        <div class="segmented">
          <button class="choice ${formState.allowT ? "active" : ""}" data-allow="true">允许</button>
          <button class="choice ${!formState.allowT ? "active" : ""}" data-allow="false">不允许</button>
        </div>
      </div>
      <div class="error compact" id="formError">${formError}</div>
      <button class="primary" id="analyzeBtn">开始分析</button>
    </section>
  `;
}

function resultCard(data) {
  const signals = orderedSignals(data.stock.signals);
  return `
    <section class="card hero-result">
      <div class="result-head">
        <span>股票体检结果</span>
        <span>${data.stock.name} ${data.stock.code}</span>
      </div>
      <div class="big-conclusion"><span class="conclusion-mark">◐</span>${data.stock.conclusion}</div>
      <div class="action-list">
        <div class="action-line"><span>当前价</span><strong class="key-price">${yuan(data.stock.currentPrice)}</strong></div>
        <div class="action-line"><span>行情说明</span><strong>${data.stock.priceSource || "待同步"}</strong></div>
        <div class="action-line"><span>适合动作</span><strong>${data.stock.action}</strong></div>
        <div class="action-line"><span>关键提醒</span><strong class="key-price">${data.stock.keyReminder}</strong></div>
      </div>
    </section>
    <section class="card">
      <h2 class="section-title">信号灯标签</h2>
      <div class="signal-strip">
        ${signals.map((item) => `
          <div class="signal ${stateClass[item.state]}">${stateIcon[item.state]} ${item.label}：${item.text}</div>
        `).join("")}
      </div>
    </section>
    ${pager("上一页", "下一页")}
  `;
}

function activeCostPrice() {
  if (formState.ownership !== "bought") return null;
  const cost = Number(formState.costPrice);
  return Number.isFinite(cost) && cost > 0 ? Number(cost.toFixed(2)) : null;
}

function rulerStyle(r, currentPrice, costPrice) {
  const values = [
    Number(r.stopLossPrice),
    Number(r.buyWatchLow),
    Number(r.buyWatchHigh),
    Number(currentPrice),
    Number(r.sellWatchLow),
    Number(r.sellWatchHigh),
    Number(costPrice)
  ].filter(Number.isFinite);
  const min = Math.min(...values) * 0.995;
  const max = Math.max(...values) * 1.005;
  const span = max - min || 1;
  const pos = (value) => `${Math.max(0, Math.min(100, ((Number(value) - min) / span) * 100)).toFixed(2)}%`;
  return [
    `--risk-pos: ${pos(r.stopLossPrice)}`,
    `--buy-start: ${pos(r.buyWatchLow)}`,
    `--buy-end: ${pos(r.buyWatchHigh)}`,
    `--current-pos: ${pos(currentPrice)}`,
    `--sell-start: ${pos(r.sellWatchLow)}`,
    `--sell-end: ${pos(r.sellWatchHigh)}`,
    `--cost-pos: ${costPrice ? pos(costPrice) : "-999%"}`
  ].join(";");
}

function priceRuler(stock) {
  const r = stock.ruler;
  const costPrice = activeCostPrice();
  return `
    <section class="card">
      <h2 class="section-title">价格尺</h2>
      <div class="ruler-wrap">
        <div class="ruler-labels"><span>风险线</span><span>低吸区</span><span>当前价</span><span>高抛区</span></div>
        <div class="ruler-values"><span>${r.stopLossPrice}</span><span>${r.buyWatchLow}-${r.buyWatchHigh}</span><span>${stock.currentPrice}</span><span>${r.sellWatchLow}-${r.sellWatchHigh}</span></div>
        <div class="ruler" aria-label="价格尺" style="${rulerStyle(r, stock.currentPrice, costPrice)}">
          <span class="ruler-track"></span>
          <span class="ruler-segment risk-segment"></span>
          <span class="ruler-segment buy-segment"></span>
          <span class="ruler-segment sell-segment"></span>
          <span class="tick tick-risk"></span>
          <span class="tick tick-buy"></span>
          <span class="dot dot-current"></span>
          ${costPrice ? "<span class=\"tick tick-cost\"></span><span class=\"dot dot-cost\"></span>" : ""}
          <span class="tick tick-sell"></span>
        </div>
        <div class="ruler-legend">
          <span><i class="legend-dot current"></i>实心圆：当前价 ${stock.currentPrice}</span>
          ${costPrice ? `<span><i class="legend-dot cost"></i>空心点：成本价 ${costPrice}</span>` : ""}
        </div>
      </div>
      <p class="plain">${stock.plainText}</p>
    </section>
  `;
}

function stockFlowPage(data) {
  if (currentStep === 1) return inputCard();
  if (currentStep === 2) return resultCard(data);
  if (currentStep === 3) {
    return `
      ${priceRuler(data.stock)}
      ${holdingTab(data)}
      ${pager("上一页", "下一页")}
    `;
  }
  return `
    ${deepTab(data)}
    ${pager("上一页", "回到开始")}
  `;
}

function tabs(data) {
  return `
    <section>
      <div class="tabs">
        <button class="tab ${formState.tab === "hold" ? "active" : ""}" data-tab="hold">我的持仓 & 做T</button>
        <button class="tab ${formState.tab === "deep" ? "active" : ""}" data-tab="deep">深入看看</button>
      </div>
      ${formState.tab === "hold" ? holdingTab(data) : deepTab(data)}
    </section>
  `;
}

function holdingTab(data) {
  const h = data.holding;
  const holdingBlock = h.isHolding ? `
    <section class="card">
      <h2 class="section-title">我的持仓状态</h2>
      <div class="info-list">
        <div class="info-row"><span>当前浮盈/浮亏</span><strong>${pct(h.profitPct)}</strong></div>
        <div class="info-row"><span>状态</span><strong>✓ ${h.status}</strong></div>
        <div class="info-row"><span>持仓性价比</span><strong>◐ ${h.value}</strong></div>
        <div class="info-row"><span>核心逻辑</span><strong>✓ ${h.logic}</strong></div>
        <div class="info-row"><span>防守线</span><strong>${yuan(h.defenseLine)}</strong></div>
        <div class="info-row"><span>持仓处理</span><strong>${h.treatment}</strong></div>
      </div>
      <p class="plain">${h.explanation}</p>
    </section>
  ` : `
    <section class="card">
      <h2 class="section-title">这只股票值得观察吗？</h2>
      <div class="info-list">
        <div class="info-row"><span>结论</span><strong>${h.watchConclusion}</strong></div>
        <div class="info-row"><span>舒服观察价</span><strong>${h.comfortPrice}</strong></div>
        <div class="info-row"><span>风险线</span><strong>${h.riskLine}</strong></div>
      </div>
      <p class="plain">不追高，等它自己走到舒服位置。</p>
    </section>
  `;

  return `
    ${holdingBlock}
    <section class="card">
      <h2 class="section-title">做T参考</h2>
      <div class="info-list">
        <div class="info-row"><span>适合T吗</span><strong>◐ ${data.tPlan.suitable}</strong></div>
        <div class="info-row"><span>低吸观察区</span><strong>${data.tPlan.buyZone}</strong></div>
        <div class="info-row"><span>高抛观察区</span><strong>${data.tPlan.sellZone}</strong></div>
        <div class="info-row"><span>失效防守位</span><strong>${data.tPlan.invalidLine}</strong></div>
        <div class="info-row"><span>T仓比例</span><strong>${data.tPlan.ratio}</strong></div>
      </div>
      <p class="plain">${data.tPlan.reason}</p>
    </section>
  `;
}

function deepTab(data) {
  const d = data.deepDive;
  return `
    <section class="card">
      <h2 class="section-title">这只股票顺不顺风？</h2>
      <div class="info-list">
        <div class="info-row"><span>大盘环境</span><strong>${d.wind.market}</strong></div>
        <div class="info-row"><span>所属板块</span><strong>${d.wind.sector}</strong></div>
        <div class="info-row"><span>行业状态</span><strong>${d.wind.industry}</strong></div>
        <div class="info-row"><span>市场声量</span><strong>${d.wind.voice}</strong></div>
      </div>
      <p class="plain">${d.wind.explanation}</p>
    </section>
    <section class="card">
      <h2 class="section-title">未来30天有没有雷？</h2>
      <div class="info-list">
        ${d.events.map((item) => `<div class="info-row"><span>${stateIcon[item.state]} ${item.label}</span><strong>${item.text}</strong></div>`).join("")}
      </div>
    </section>
    <section class="card">
      <h2 class="section-title">这只股票真正要盯什么？</h2>
      <p class="plain"><strong>核心矛盾：</strong>${d.focus.conflict}</p>
      <div class="info-list">
        ${d.focus.variables.map((item, index) => `<div class="info-row"><span>关键变量${index + 1}</span><strong>${item}</strong></div>`).join("")}
      </div>
      <p class="plain">${d.focus.explanation}</p>
    </section>
    <section class="card">
      <h2 class="section-title">现在是不是买贵了？</h2>
      <div class="info-list">
        <div class="info-row"><span>价格位置</span><strong>${d.expensive.pricePosition}</strong></div>
        <div class="info-row"><span>20日线</span><strong>${d.expensive.ma20}</strong></div>
        <div class="info-row"><span>60日线</span><strong>${d.expensive.ma60}</strong></div>
        <div class="info-row"><span>成交量</span><strong>${d.expensive.volume}</strong></div>
        <div class="info-row"><span>资金筹码</span><strong>${d.expensive.chips}</strong></div>
        <div class="info-row"><span>吝啬判断</span><strong>${d.expensive.judgment}</strong></div>
      </div>
    </section>
  `;
}

function directionCards(items) {
  return `
    <section>
      ${items.map((item) => `
        <article class="card direction-card">
          <h3>${item.name}</h3>
          <div class="status-line watch">◐ ${item.status}</div>
          <div class="info-list">
            <div class="info-row"><span>适合人群</span><strong>${item.fit}</strong></div>
            <div class="info-row"><span>关注理由</span><strong>${item.reason}</strong></div>
            <div class="info-row"><span>埋伏条件</span><strong>${item.condition}</strong></div>
            <div class="info-row"><span>重点观察股</span><strong>${item.stocks}</strong></div>
            <div class="info-row"><span>观察指标</span><strong>${item.metrics}</strong></div>
            <div class="info-row"><span>风险点</span><strong>${item.risk}</strong></div>
          </div>
        </article>
      `).join("")}
    </section>
  `;
}

function renderLogin(message = "") {
  app.innerHTML = `
    <div class="login-page">
      <section class="card login-card">
        <h1>请输入家庭查看密码</h1>
        <div class="field">
          <label class="label" for="password">密码</label>
          <input class="input" id="password" type="password" autocomplete="current-password" />
        </div>
        <div class="error" id="loginError">${message}</div>
        <button class="primary" id="loginBtn">进入</button>
      </section>
    </div>
  `;
  document.querySelector("#loginBtn").addEventListener("click", login);
  document.querySelector("#password").addEventListener("keydown", (event) => {
    if (event.key === "Enter") login();
  });
}

async function login() {
  const password = document.querySelector("#password").value;
  try {
    await api("/api/login", { method: "POST", body: JSON.stringify({ password }) });
    currentStep = 1;
    await analyze(false);
  } catch (error) {
    renderLogin(error.message);
  }
}

function parseStockInput(value) {
  const trimmed = value.trim();
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (!parts.length) {
    formState.stockName = "";
    formState.stockCode = "";
    return;
  }
  if (/^\d{6}$/.test(parts[0])) {
    formState.stockCode = parts[0];
    formState.stockName = parts.slice(1).join("") || "";
    return;
  }
  formState.stockName = parts[0] || "";
  formState.stockCode = parts.find((part) => /^\d{6}$/.test(part)) || parts[1] || "";
}

function validateInput() {
  if (!watchlist.some((item) => item.code === formState.stockCode)) {
    formError = "先选择一只自选股。";
    return false;
  }
  if (formState.ownership === "bought" && !String(formState.costPrice || "").trim()) {
    formError = "已买入时，需要填一下成本价。";
    return false;
  }
  formError = "";
  return true;
}

function beijingRefreshParts(date = new Date()) {
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

function shouldAutoRefreshNow() {
  const parts = beijingRefreshParts();
  if (["Sat", "Sun"].includes(parts.weekday)) return false;
  if (![7, 12, 17].includes(parts.hour) || parts.minute !== 0) return false;
  if (parts.key === lastClientRefreshKey) return false;
  lastClientRefreshKey = parts.key;
  return true;
}

function renderMain() {
  if (!analysis) return;
  app.innerHTML = `
    <div class="shell">
      ${updateBar(analysis.meta)}
      <header class="topbar">
        <div class="brand">A股家庭持仓体检页</div>
        <button class="ghost-btn" id="logoutBtn">快照版</button>
      </header>
      ${sectionHeader("market", "☁️", "今天市场天气", "先看今天市场适不适合乱动")}
      ${weatherCard(analysis.market)}
      ${sectionHeader("stock", "🩺", "看看这只股票现在能不能碰", "输入股票和成本价，看看安不安全")}
      ${progressSteps()}
      ${stockFlowPage(analysis)}
      ${sectionHeader("directions", "🔍", "近期可关注的低位方向", "只看低位，不追热门高潮")}
      ${directionCards(analysis.directions)}
      <p class="footnote">实时价格来自腾讯证券行情接口，并用新浪财经与东方财富行情交叉校验；公告来自巨潮资讯；均线和价格位置来自腾讯历史行情；方向池基于客观候选池实时行情测算。不接入券商账户，不保存真实资金账户信息。</p>
    </div>
  `;

  document.querySelectorAll("[data-set]").forEach((button) => {
    button.addEventListener("click", () => setForm(button.dataset.set, button.dataset.value));
  });
  document.querySelectorAll("[data-stock-code]").forEach((button) => {
    button.addEventListener("click", () => selectStock(button.dataset.stockCode));
  });
  document.querySelectorAll("[data-allow]").forEach((button) => {
    button.addEventListener("click", () => setForm("allowT", button.dataset.allow === "true"));
  });
  document.querySelector("#stockName")?.addEventListener("input", (event) => parseStockInput(event.target.value));
  const costInput = document.querySelector("#costPrice");
  if (costInput) costInput.addEventListener("input", (event) => { formState.costPrice = event.target.value; });
  document.querySelector("#analyzeBtn")?.addEventListener("click", () => analyze(true));
  document.querySelectorAll("[data-nav]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.nav === "prev") currentStep = Math.max(1, currentStep - 1);
      if (button.dataset.nav === "next") currentStep = Math.min(4, currentStep + 1);
      if (button.dataset.nav === "start") currentStep = 1;
      formError = "";
      renderMain();
      document.querySelector(".section-banner.stock")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
  document.querySelector("#logoutBtn").addEventListener("click", () => {
    currentStep = 1;
    renderMain();
  });
}

async function analyze(advance = true) {
  parseStockInput(document.querySelector("#stockName")?.value || `${formState.stockName} ${formState.stockCode}`);
  if (document.querySelector("#costPrice")) formState.costPrice = document.querySelector("#costPrice").value;
  if (advance && !validateInput()) {
    renderMain();
    return;
  }
  const payload = {
    stockName: formState.stockName,
    stockCode: formState.stockCode,
    ownership: formState.ownership,
    costPrice: formState.costPrice,
    position: formState.position,
    habit: formState.habit,
    allowT: formState.allowT
  };
  try {
    const body = await api("/api/analyze", { method: "POST", body: JSON.stringify(payload) });
    analysis = body.data;
    if (advance) currentStep = 2;
    renderMain();
  } catch (error) {
    formError = advance ? "数据暂时获取失败，请稍后再试。" : "";
    if (analysis) renderMain();
    else throw error;
  }
}

async function boot() {
  const session = await api("/api/session");
  if (session.ok) {
    await analyze(false);
  } else {
    renderLogin();
  }
}

boot().catch(() => renderLogin());

setInterval(() => {
  if (!analysis || document.hidden || !shouldAutoRefreshNow()) return;
  analyze(false).catch(() => {});
}, 60 * 1000);
