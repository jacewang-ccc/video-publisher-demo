const STORAGE_KEY = "mpvpub_config_v1";
const DEFAULTS_URL = "./defaults.json";

let config = null;
let PLATFORMS = [];
let rawEdited = false;
let dirtyConfig = false;

const state = {
  snapshot: null,
  prepared: new Set(),
  extConnected: false,
  lastExtStatusAt: 0
};

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function todayISO() {
  const d = new Date();
  const tzOffset = d.getTimezoneOffset() * 60_000;
  return new Date(d.getTime() - tzOffset).toISOString().slice(0, 10);
}

function addDays(dateISO, days) {
  const d = new Date(dateISO + "T00:00:00");
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function dateTimeISO(dateISO, timeHHmm) {
  const [hh, mm] = timeHHmm.split(":").map(Number);
  const d = new Date(dateISO + "T00:00:00");
  d.setHours(hh, mm, 0, 0);
  return d.toISOString();
}

function el(id) {
  return document.getElementById(id);
}

function log(msg) {
  el("log").textContent = msg;
}

function setDirty(isDirty) {
  dirtyConfig = isDirty;
  const btn = document.getElementById("btnSaveConfig");
  if (!btn) return;
  btn.textContent = dirtyConfig ? "保存（未保存更改）" : "保存";
}

function fileMeta(file) {
  if (!file) return "未选择";
  const kb = Math.round(file.size / 1024);
  return `${file.name} (${kb} KB)`;
}

function refreshFileMeta() {
  el("videoFileMeta").textContent = fileMeta(el("videoFile").files?.[0]);
  el("verticalCoverMeta").textContent = fileMeta(el("verticalCoverFile").files?.[0]);
  el("horizontalCoverMeta").textContent = fileMeta(el("horizontalCoverFile").files?.[0]);
}

function showPublish() {
  el("pagePublishLeft").style.display = "";
  el("pagePublishRight").style.display = "";
  el("pageConfig").style.display = "none";
}

function showConfig() {
  el("pagePublishLeft").style.display = "none";
  el("pagePublishRight").style.display = "none";
  el("pageConfig").style.display = "";
}

function pill(status) {
  const span = document.createElement("span");
  span.className = "pill " + (status.kind === "ok" ? "ok" : status.kind === "warn" ? "warn" : "bad");
  span.textContent = status.text;
  return span;
}

function simpleValidate(platformId, fields) {
  // MVP stub constraints for demonstration; real version reads config.
  const changes = [];
  let title = fields.title || "";
  const titleMax = config?.platformConstraints?.douyin?.titleMax ?? 30;
  if (platformId === "douyin" && title.length > titleMax) {
    title = title.slice(0, titleMax);
    changes.push(`标题超限：已截断至${titleMax}字`);
  }
  const tags = Array.from(new Set(fields.tags || [])).filter(Boolean);
  if (tags.length > 10) {
    changes.push("tag过多：已裁剪至10个");
    tags.length = 10;
  }
  const validation = changes.length ? { kind: "warn", text: "已自动修正" } : { kind: "ok", text: "通过" };
  return { ...fields, title, tags, _changes: changes, _validation: validation };
}

function buildFields(input, platform) {
  const settings = {
    visibility: config?.userDefaults?.visibility ?? "public",
    saveAllowed: config?.userDefaults?.saveAllowed ?? false
  };
  const baseDate = input.baseDate;
  const scheduleDate = addDays(baseDate, platform.offsetDays);
  const scheduleDateTime = dateTimeISO(scheduleDate, platform.time);

  const tagsFixed = config?.templates?.tags?.fixed ?? ["小X计划", "自我成长", "个人管理"];
  let tags = [...tagsFixed];
  if (input.dailyTheme) tags.push(input.dailyTheme);

  const declarationType = input.hasAi === "yes" ? "ai_generated" : "self_shot";
  const declaration = {
    type: declarationType,
    shootCity: declarationType === "self_shot" ? (config?.userDefaults?.city ?? "深圳") : null,
    shootDate: declarationType === "self_shot" ? baseDate : null
  };

  // Simple template demo:
  const hook = input.topic || "记录一下";
  const tplDaily = config?.templates?.title?.daily?.[0] ?? "打卡第{day_n}天｜{daily_theme}｜{hook}";
  const tplSideline = config?.templates?.title?.sideline?.[0] ?? "{topic}｜{hook}";
  const tplMainline = config?.templates?.title?.mainline?.[0] ?? "{topic}";

  const baseTpl =
    input.majorTheme === "daily" ? tplDaily : input.majorTheme === "sideline" ? tplSideline : tplMainline;

  let title = "";
  {
    // If a pipeline exists for this field, apply it first.
    const pipe = resolvePipeline(platform.id, input.subTheme, "title");
    const vars = {
      day_n: input.dayN || "?",
      daily_theme: input.dailyTheme || "日更",
      topic: input.topic || "今天想聊聊",
      hook: input.hook || hook
    };
    const pipeRes = applyPipeline(pipe, vars, buildChoiceMap(input, platform.id, "title"));

    title = pipeRes.value || generateByMode("template", {
      template: applyTemplate(baseTpl, {
        day_n: vars.day_n,
        daily_theme: vars.daily_theme,
        topic: vars.topic,
        hook
      }),
      topic: input.topic,
      coreIdea: input.coreIdea,
      fallback: "（待生成标题）"
    });
  }

  let description = "";
  {
    const pipe = resolvePipeline(platform.id, input.subTheme, "description");
    const vars = { day_n: input.dayN || "?", daily_theme: input.dailyTheme || "日更", topic: input.topic || "", hook: input.hook || "" };
    const pipeRes = applyPipeline(pipe, vars, buildChoiceMap(input, platform.id, "description"));
    description = pipeRes.value || generateByMode("template", {
      template: applyTemplate(config?.templates?.description?.daily?.[0] ?? "{desc}", { desc: "" }),
      topic: input.topic,
      coreIdea: input.coreIdea,
      fallback: ""
    });
  }

  {
    const pipe = resolvePipeline(platform.id, input.subTheme, "tags");
    if (pipe) {
      const vars = { topic: input.topic || "", daily_theme: input.dailyTheme || "", hook: input.hook || "" };
      const res = applyPipeline(pipe, vars, buildChoiceMap(input, platform.id, "tags"));
      const extra = res.value
        .split(/[,，\n]+/g)
        .map((s) => s.trim())
        .filter(Boolean);
      if (extra.length) tags = Array.from(new Set([...tags, ...extra]));
    }
  }

  return {
    scheduleDateTime,
    title,
    description,
    tags,
    topics: [],
    collection: null,
    settings,
    declaration,
    cover: { verticalMode: "upload", horizontalMode: "always_upload" }
  };
}

function buildChoiceMap(input, platformId, field) {
  const out = {};
  const choices = input?.choices?.[platformId] || {};
  for (const [k, v] of Object.entries(choices)) {
    const [f, stepId] = String(k).split(":");
    if (f === field && stepId) out[stepId] = v;
  }
  return out;
}

function generateByMode(mode, ctx) {
  if (mode === "manual") return ctx.fallback || "";
  if (mode === "template") return ctx.template || ctx.fallback || "";
  if (mode === "fixed_template") {
    const idea = ctx.coreIdea ? `（补充：${ctx.coreIdea}）` : "";
    return (ctx.template || "") + idea;
  }
  if (mode === "ai") {
    const t = ctx.topic ? `主题：${ctx.topic}` : "";
    const i = ctx.coreIdea ? `想法：${ctx.coreIdea}` : "";
    return `【AI待接入】${t}${t && i ? "；" : ""}${i}`.trim();
  }
  return ctx.template || ctx.fallback || "";
}

function pickKeywords(text, max) {
  const parts = String(text)
    .replace(/[，。；、!！?？\n\r\t]+/g, " ")
    .split(" ")
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.slice(0, max);
}

// choice selections are not exposed on the publish page for now; pipelines will auto-pick:
// - 1 option: fixed
// - manual/first: first option
// - random: random option

function normalizePlatformsMatch(platforms, platformId) {
  if (!Array.isArray(platforms) || platforms.length === 0) return true;
  if (platforms.includes("*")) return true;
  return platforms.includes(platformId);
}

// If/Then rule engine removed. Model automation only via pipelines.

function renderMatrix(snapshot) {
  const tbody = el("matrix").querySelector("tbody");
  tbody.innerHTML = "";
  for (const platform of PLATFORMS) {
    const p = snapshot.platforms[platform.id];
    const tr = document.createElement("tr");
    tr.appendChild(tdText(platform.name));
    tr.appendChild(tdText(new Date(p.fields.scheduleDateTime).toLocaleString()));
    tr.appendChild(
      tdText(
        `竖封面=${snapshot.assets?.verticalCover ? "已选" : "缺失"}；横封面=${snapshot.assets?.horizontalCover ? "已选" : "缺失"}`
      )
    );
    tr.appendChild(tdText(p.fields.title));
    tr.appendChild(tdText(p.fields.description));
    tr.appendChild(tdText(p.fields.tags.join(", ")));
    tr.appendChild(tdText(p.fields.declaration.type));
    tr.appendChild(tdText(`公开；不允许保存`));
    const td = document.createElement("td");
    td.appendChild(pill(p.validation));
    if (p.changeLog.length) {
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = "修正清单";
      details.appendChild(summary);
      const ul = document.createElement("ul");
      ul.style.margin = "6px 0 0 18px";
      for (const c of p.changeLog) {
        const li = document.createElement("li");
        li.textContent = c;
        ul.appendChild(li);
      }
      if (p.ruleLog && p.ruleLog.length) {
        const li = document.createElement("li");
        li.textContent = `规则：${p.ruleLog.join("；")}`;
        ul.appendChild(li);
      }
      details.appendChild(ul);
      td.appendChild(details);
    } else if (p.ruleLog && p.ruleLog.length) {
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = "规则";
      details.appendChild(summary);
      const ul = document.createElement("ul");
      ul.style.margin = "6px 0 0 18px";
      for (const c of p.ruleLog) {
        const li = document.createElement("li");
        li.textContent = c;
        ul.appendChild(li);
      }
      details.appendChild(ul);
      td.appendChild(details);
    }
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
}

function tdText(text) {
  const td = document.createElement("td");
  td.textContent = text;
  return td;
}

function applyTemplate(tpl, vars) {
  return String(tpl || "").replace(/\{(\w+)\}/g, (_, k) => (vars?.[k] ?? `{${k}}`));
}

function createSnapshot(input) {
  const id = "snap_" + Math.random().toString(16).slice(2);
  const createdAt = new Date().toISOString();
  const platforms = {};
  for (const p of PLATFORMS) {
    const raw = buildFields(input, p);
    const ruleLog = [...(raw._ruleChangeLog || [])];
    delete raw._ruleChangeLog;
    const fixed = simpleValidate(p.id, raw);
    platforms[p.id] = {
      status: "ready_to_prepare",
      fields: fixed,
      changeLog: fixed._changes,
      validation: fixed._validation,
      ruleLog
    };
    delete platforms[p.id].fields._changes;
    delete platforms[p.id].fields._validation;
  }
  return {
    id,
    createdAt,
    baseDate: input.baseDate,
    assets: {
      video: input.videoFileMeta,
      verticalCover: input.verticalCoverMeta,
      horizontalCover: input.horizontalCoverMeta
    },
    platforms
  };
}

function getInput() {
  const videoFile = el("videoFile").files?.[0] || null;
  const verticalCover = el("verticalCoverFile").files?.[0] || null;
  const horizontalCover = el("horizontalCoverFile").files?.[0] || null;

  const choices = {};
  const selects = document.querySelectorAll('select[id^="autoChoice_"]');
  for (const sel of selects) {
    const id = sel.id; // autoChoice_{platformId}_{field}_{stepId}
    const parts = id.split("_");
    if (parts.length < 4) continue;
    const platformId = parts[1];
    const field = parts[2];
    const stepId = parts.slice(3).join("_");
    choices[platformId] = choices[platformId] || {};
    choices[platformId][`${field}:${stepId}`] = sel.value;
  }

  return {
    baseDate: el("baseDate").value,
    majorTheme: el("majorTheme").value,
    subTheme: el("subTheme").value,
    hasAi: el("hasAi").value,
    topic: el("topic").value.trim(),
    hook: (el("hook")?.value || "").trim(),
    dayN: el("dayN").value.trim(),
    dailyTheme: el("dailyTheme").value,
    coreIdea: el("coreIdea").value.trim(),
    choices,
    videoFileMeta: videoFile ? { name: videoFile.name, size: videoFile.size, type: videoFile.type } : null,
    verticalCoverMeta: verticalCover ? { name: verticalCover.name, size: verticalCover.size, type: verticalCover.type } : null,
    horizontalCoverMeta: horizontalCover ? { name: horizontalCover.name, size: horizontalCover.size, type: horizontalCover.type } : null
  };
}

async function loadDefaultConfig() {
  const res = await fetch(DEFAULTS_URL, { cache: "no-store" });
  if (!res.ok) throw new Error("无法加载默认配置 defaults.json");
  return res.json();
}

function loadUserConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveUserConfig(next) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next, null, 2));
}

function buildPlatformsFromConfig(cfg) {
  const pt = cfg?.schedulePolicy?.platformTimes || {};
  const mk = (id, name) => ({
    id,
    name,
    offsetDays: pt?.[id]?.offsetDays ?? (id === "douyin" ? 0 : 1),
    time: pt?.[id]?.time ?? (id === "douyin" ? "20:00" : "10:00")
  });
  return [mk("douyin", "抖音"), mk("xiaohongshu", "小红书"), mk("channels", "视频号"), mk("bilibili", "B站")];
}

function buildTaxonomyIndex(cfg) {
  const roots = cfg?.taxonomy?.roots || [];
  const major = roots.map((r) => ({ id: r.id, name: r.name, children: r.children || [] }));
  const majorById = new Map(major.map((m) => [m.id, m]));
  return { major, majorById };
}

function setSelectOptions(selectEl, options, selectedValue) {
  selectEl.innerHTML = "";
  for (const o of options) {
    const opt = document.createElement("option");
    opt.value = o.value;
    opt.textContent = o.label;
    selectEl.appendChild(opt);
  }
  if (selectedValue && options.some((o) => o.value === selectedValue)) selectEl.value = selectedValue;
}

function refreshThemeSelectors() {
  const idx = buildTaxonomyIndex(config);
  const majorSel = el("majorTheme");
  const subSel = el("subTheme");

  if (!idx.major.length) {
    majorSel.innerHTML = "";
    subSel.innerHTML = "";
    el("metaPanel").style.display = "none";
    const aip = document.getElementById("autoInputsPanel");
    if (aip) aip.style.display = "none";
    return;
  }

  setSelectOptions(
    majorSel,
    idx.major.map((m) => ({ value: m.id, label: m.name })),
    majorSel.value || idx.major[0]?.id
  );

  const curMajor = idx.majorById.get(majorSel.value) || idx.major[0];
  const subs = (curMajor?.children || []).map((c) => ({ value: c.id, label: c.name }));
  setSelectOptions(subSel, subs, subSel.value || subs[0]?.value);

  // Show panels only after subTheme exists
  const hasSub = Boolean(subSel.value);
  el("metaPanel").style.display = hasSub ? "" : "none";
  const aip = document.getElementById("autoInputsPanel");
  if (aip) aip.style.display = hasSub ? "" : "none";

  // dailyTheme/dayN only matters for 日更 major
  const isDaily = majorSel.value === "daily";
  el("dailyTheme").disabled = !isDaily;
  el("dayN").disabled = !isDaily;

  renderAutoInputsForSelection();
}

function computeAutomationDefaults(subThemeId) {
  const defs = Array.isArray(config?.automationDefaults) ? config.automationDefaults : [];
  const matches = defs
    .filter((d) => d && d.enabled !== false)
    .filter((d) => {
      const prefix = d?.match?.subThemePrefix;
      if (!prefix) return false;
      return String(subThemeId || "").startsWith(String(prefix));
    })
    .sort((a, b) => Number(b?.priority || 0) - Number(a?.priority || 0));

  const base = { titleMode: "template", descriptionMode: "template", tagsMode: "template" };
  return matches[0]?.defaults ? { ...base, ...matches[0].defaults } : base;
}

function computeAutomationDefaultsForPlatform(platformId, subThemeId) {
  let next = computeAutomationDefaults(subThemeId);
  // Deprecated: mode-default rules are now superseded by automationPipelines (step-based).
  return next;
}

function renderAutoMatrix() {
  // UI removed for now to keep the publish page clean.
}

function flowTypeToMode(type) {
  if (type === "ai_stub") return "ai";
  if (type === "manual") return "manual";
  if (type === "template_fixed") return "fixed_template";
  return "template";
}

function tdAutoSelect(id, value) {
  const td = document.createElement("td");
  const sel = document.createElement("select");
  sel.id = id;
  const opts = [
    { v: "template", t: "A 模板套用" },
    { v: "ai", t: "B AI生成" },
    { v: "fixed_template", t: "C 固定模板加工" },
    { v: "manual", t: "D 手动" }
  ];
  for (const o of opts) {
    const opt = document.createElement("option");
    opt.value = o.v;
    opt.textContent = o.t;
    sel.appendChild(opt);
  }
  sel.value = value;
  td.appendChild(sel);
  return td;
}

function fillConfigForm(cfg) {
  rawEdited = false;
  setDirty(false);
  el("cfgCity").value = cfg?.userDefaults?.city ?? "深圳";
  el("cfgVisibility").value = cfg?.userDefaults?.visibility ?? "public";
  el("cfgSaveAllowed").value = String(Boolean(cfg?.userDefaults?.saveAllowed));
  el("cfgTimeDouyin").value = cfg?.schedulePolicy?.platformTimes?.douyin?.time ?? "20:00";
  el("cfgTimeXhs").value = cfg?.schedulePolicy?.platformTimes?.xiaohongshu?.time ?? "10:00";
  el("cfgTimeChannels").value = cfg?.schedulePolicy?.platformTimes?.channels?.time ?? "12:00";
  el("cfgTimeBili").value = cfg?.schedulePolicy?.platformTimes?.bilibili?.time ?? "18:00";
  el("cfgFixedTags").value = (cfg?.templates?.tags?.fixed ?? []).join(",");
  el("cfgTplDailyTitle").value = cfg?.templates?.title?.daily?.[0] ?? "打卡第{day_n}天｜{daily_theme}｜{hook}";
  el("cfgTplSidelineTitle").value = cfg?.templates?.title?.sideline?.[0] ?? "{topic}｜{hook}";
  el("cfgTplMainlineTitle").value = cfg?.templates?.title?.mainline?.[0] ?? "{topic}";
  el("cfgRaw").value = JSON.stringify(cfg, null, 2);
}

function readConfigForm(current) {
  const next = deepClone(current);
  next.userDefaults = next.userDefaults || {};
  next.schedulePolicy = next.schedulePolicy || {};
  next.schedulePolicy.platformTimes = next.schedulePolicy.platformTimes || {};

  next.userDefaults.city = el("cfgCity").value.trim() || "深圳";
  next.userDefaults.visibility = el("cfgVisibility").value;
  next.userDefaults.saveAllowed = el("cfgSaveAllowed").value === "true";

  next.schedulePolicy.platformTimes.douyin = { offsetDays: 0, time: el("cfgTimeDouyin").value.trim() || "20:00" };
  next.schedulePolicy.platformTimes.xiaohongshu = { offsetDays: 1, time: el("cfgTimeXhs").value.trim() || "10:00" };
  next.schedulePolicy.platformTimes.channels = { offsetDays: 1, time: el("cfgTimeChannels").value.trim() || "12:00" };
  next.schedulePolicy.platformTimes.bilibili = { offsetDays: 1, time: el("cfgTimeBili").value.trim() || "18:00" };

  next.templates = next.templates || {};
  next.templates.tags = next.templates.tags || {};
  next.templates.tags.fixed = el("cfgFixedTags").value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  next.templates.title = next.templates.title || {};
  next.templates.title.daily = [el("cfgTplDailyTitle").value.trim() || "打卡第{day_n}天｜{daily_theme}｜{hook}"];
  next.templates.title.sideline = [el("cfgTplSidelineTitle").value.trim() || "{topic}｜{hook}"];
  next.templates.title.mainline = [el("cfgTplMainlineTitle").value.trim() || "{topic}"];

  return next;
}

// automationFlowRules/autoFlowTable removed in favor of automationPipelines (step-based).

function updateRawFromConfig() {
  el("cfgRaw").value = JSON.stringify(config, null, 2);
  setDirty(true);
}

function tdEnabled(rule) {
  const td = document.createElement("td");
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = rule.enabled !== false;
  input.addEventListener("change", () => {
    rule.enabled = input.checked;
    updateRawFromConfig();
  });
  td.appendChild(input);
  return td;
}

function tdPriority(rule) {
  const td = document.createElement("td");
  const input = document.createElement("input");
  input.type = "number";
  input.value = String(rule.priority ?? 0);
  input.style.maxWidth = "90px";
  input.addEventListener("input", () => {
    rule.priority = Number(input.value || 0);
    updateRawFromConfig();
  });
  td.appendChild(input);
  return td;
}

function tdPlatform(rule) {
  const td = document.createElement("td");
  const sel = document.createElement("select");
  const opts = [
    { v: "*", t: "全部" },
    { v: "douyin", t: "抖音" },
    { v: "xiaohongshu", t: "小红书" },
    { v: "channels", t: "视频号" },
    { v: "bilibili", t: "B站" }
  ];
  for (const o of opts) {
    const opt = document.createElement("option");
    opt.value = o.v;
    opt.textContent = o.t;
    sel.appendChild(opt);
  }
  const current = Array.isArray(rule.platforms) && rule.platforms.length ? rule.platforms[0] : "*";
  sel.value = current;
  sel.addEventListener("change", () => {
    rule.platforms = [sel.value];
    updateRawFromConfig();
  });
  td.appendChild(sel);
  return td;
}

// (If/Then rules UI removed)

function flattenSubThemes(cfg) {
  const roots = cfg?.taxonomy?.roots || [];
  const out = [];
  for (const r of roots) {
    const children = Array.isArray(r.children) ? r.children : [];
    for (const c of children) out.push({ id: c.id, name: `${r.name} / ${c.name}` });
  }
  return out;
}

function findPipelines(platformId, subThemeId, field) {
  const pipes = Array.isArray(config?.automationPipelines) ? config.automationPipelines : [];
  return pipes
    .filter((p) => p && p.enabled !== false)
    .filter((p) => normalizePlatformsMatch(p.platforms, platformId))
    .filter((p) => p.field === field)
    .filter((p) => {
      if (p.match?.subThemeId) return p.match.subThemeId === subThemeId;
      if (p.match?.subThemePrefix) return String(subThemeId || "").startsWith(String(p.match.subThemePrefix));
      return false;
    })
    .sort((a, b) => Number(b?.priority || 0) - Number(a?.priority || 0));
}

function resolvePipeline(platformId, subThemeId, field) {
  const list = findPipelines(platformId, subThemeId, field);
  return list[0] || null;
}

function pipelineToMode(pipeline) {
  if (!pipeline) return null;
  // Pipeline results in a deterministic/generated string; treat as "template" for UI purposes.
  return "template";
}

function applyPipeline(pipeline, vars, selectionValueByStepId) {
  if (!pipeline || !Array.isArray(pipeline.steps)) return { value: "", log: [] };
  const parts = [];
  const log = [];
  for (const step of pipeline.steps) {
    if (!step || !step.type) continue;
    if (step.type === "fixed") {
      parts.push(String(step.text ?? ""));
      continue;
    }
    if (step.type === "var") {
      const v = vars?.[step.var] ?? "";
      parts.push(String(v));
      continue;
    }
    if (step.type === "choice") {
      const options = Array.isArray(step.options) ? step.options : [];
      let pick = "";
      if (options.length === 1) {
        pick = options[0];
      } else if (step.selectionMode === "manual") {
        const chosen = selectionValueByStepId?.[step.id];
        // If UI isn't exposed, default to first option.
        pick = chosen ?? options[0] ?? "";
      } else if (step.selectionMode === "first") {
        pick = options[0] ?? "";
      } else {
        pick = options.length ? options[Math.floor(Math.random() * options.length)] : "";
      }
      parts.push(applyTemplate(pick, vars));
      log.push(`${step.label || step.id}: ${pick}`);
      continue;
    }
  }
  return { value: applyTemplate(parts.join(""), vars), log };
}

function pipelineNeeds(pipeline) {
  if (!pipeline || !Array.isArray(pipeline.steps)) return { vars: [], choices: [] };
  const vars = new Set();
  const choices = [];
  for (const s of pipeline.steps) {
    if (!s || !s.type) continue;
    if (s.type === "var" && s.var) vars.add(s.var);
    if (s.type === "choice") {
      const options = Array.isArray(s.options) ? s.options : [];
      if (options.length <= 1) continue;
      if (s.selectionMode === "manual") choices.push({ id: s.id, label: s.label || s.id, options });
    }
  }
  return { vars: Array.from(vars), choices };
}

function collectNeedsForSubTheme(subThemeId) {
  const fields = ["title", "description", "tags"];
  const allVars = new Set();
  const choiceRows = [];

  for (const p of PLATFORMS) {
    for (const f of fields) {
      const pipe = resolvePipeline(p.id, subThemeId, f);
      if (!pipe) continue;
      const needs = pipelineNeeds(pipe);
      for (const v of needs.vars) allVars.add(v);
      for (const c of needs.choices) {
        choiceRows.push({ platformId: p.id, platformName: p.name, field: f, ...c });
      }
    }
  }
  return { vars: Array.from(allVars), choiceRows };
}

function renderAutoInputsForSelection() {
  const subThemeId = el("subTheme").value;
  const panel = document.getElementById("autoInputsPanel");
  if (!panel) return;
  if (!subThemeId) {
    el("autoInputsNeeds").textContent = "（请先选择子主题）";
    el("autoInputsChoices").querySelector("tbody").innerHTML = "";
    return;
  }

  const { vars, choiceRows } = collectNeedsForSubTheme(subThemeId);
  const varName = (v) =>
    v === "day_n"
      ? "打卡天数(day_n)"
      : v === "daily_theme"
        ? "日更主题(daily_theme)"
        : v === "topic"
          ? "主题(topic)"
          : v === "hook"
            ? "钩子(hook)"
            : v;
  el("autoInputsNeeds").textContent = vars.length ? `需要填写变量：${vars.map(varName).join("，")}` : "（当前子主题没有必须填写的变量）";

  // Reflect: enable/show corresponding inputs in metaPanel
  const needDay = vars.includes("day_n");
  const needDailyTheme = vars.includes("daily_theme");
  const needTopic = vars.includes("topic");
  const needHook = vars.includes("hook");
  el("dayN").disabled = !needDay && el("majorTheme").value !== "daily";
  el("dailyTheme").disabled = !needDailyTheme && el("majorTheme").value !== "daily";
  el("topic").placeholder = needTopic ? "必填：请输入主题/关键词" : "例如：表达 / 讲书：xxx / AI工具：xxx";
  el("hook").placeholder = needHook ? "可选：用于标题钩子" : "例如：记录一下 / 今天学到一个点…";

  const tbody = el("autoInputsChoices").querySelector("tbody");
  tbody.innerHTML = "";
  const fieldLabel = (f) => (f === "title" ? "标题" : f === "description" ? "简介" : "tag");
  for (const row of choiceRows) {
    const tr = document.createElement("tr");
    tr.appendChild(tdText(row.platformName));
    tr.appendChild(tdText(fieldLabel(row.field)));
    tr.appendChild(tdText(row.label));
    const tdSel = document.createElement("td");
    const sel = document.createElement("select");
    sel.id = `autoChoice_${row.platformId}_${row.field}_${row.id}`;
    for (const o of row.options) {
      const opt = document.createElement("option");
      opt.value = o;
      opt.textContent = o;
      sel.appendChild(opt);
    }
    tdSel.appendChild(sel);
    tr.appendChild(tdSel);
    tbody.appendChild(tr);
  }
}

function renderFlowsTable() {
  const tbody = el("flowsTable").querySelector("tbody");
  tbody.innerHTML = "";
  const flows = Array.isArray(config?.automationPipelines) ? config.automationPipelines : [];
  const subThemes = new Map(flattenSubThemes(config).map((s) => [s.id, s.name]));
  const platformName = (p) =>
    p === "*" ? "全部" : p === "douyin" ? "抖音" : p === "xiaohongshu" ? "小红书" : p === "channels" ? "视频号" : "B站";
  const fieldName = (f) => (f === "title" ? "标题" : f === "description" ? "简介" : "tag");
  const typeName = () => "单元组合";

  for (const flow of flows) {
    const tr = document.createElement("tr");
    tr.appendChild(tdEnabled(flow));
    tr.appendChild(tdPriority(flow));
    const tdSub = document.createElement("td");
    tdSub.textContent = subThemes.get(flow.match?.subThemeId) || flow.match?.subThemePrefix || "(未设置)";
    tr.appendChild(tdSub);
    const tdPlat = document.createElement("td");
    tdPlat.textContent = platformName((flow.platforms?.[0] || "*"));
    tr.appendChild(tdPlat);
    const tdField = document.createElement("td");
    tdField.textContent = fieldName(flow.field);
    tr.appendChild(tdField);
    const tdType = document.createElement("td");
    tdType.textContent = typeName();
    tr.appendChild(tdType);
    const tdTpl = document.createElement("td");
    tdTpl.textContent = summarizeSteps(flow.steps || []);
    tr.appendChild(tdTpl);
    const tdCount = document.createElement("td");
    tdCount.textContent = String(Array.isArray(flow.steps) ? flow.steps.length : 0);
    tr.appendChild(tdCount);

    const tdEdit = document.createElement("td");
    const btnEdit = document.createElement("button");
    btnEdit.className = "secondary";
    btnEdit.textContent = flow.id === editingPipelineId ? "编辑中" : "编辑";
    btnEdit.addEventListener("click", () => {
      startEditingPipeline(flow.id);
      log(`正在编辑流程：${flow.id}（可在下方调整单元顺序/内容，完成后点“保存”）`);
    });
    tdEdit.appendChild(btnEdit);
    tr.appendChild(tdEdit);

    const tdDel = document.createElement("td");
    const btn = document.createElement("button");
    btn.className = "secondary";
    btn.textContent = "删除";
    btn.addEventListener("click", () => {
      config.automationPipelines = (config.automationPipelines || []).filter((f) => f !== flow);
      updateRawFromConfig();
      renderFlowsTable();
    });
    tdDel.appendChild(btn);
    tr.appendChild(tdDel);
    tbody.appendChild(tr);
  }
}

function summarizeSteps(steps) {
  const parts = [];
  for (const s of steps.slice(0, 4)) {
    if (s.type === "fixed") parts.push(`"${String(s.text || "").slice(0, 8)}"`);
    else if (s.type === "var") parts.push(`{${s.var}}`);
    else if (s.type === "choice") parts.push(`choice(${(s.options || []).length})`);
    else parts.push(s.type);
  }
  if (steps.length > 4) parts.push("…");
  return parts.join(" + ");
}

function refreshFlowSubThemeSelect() {
  const subs = flattenSubThemes(config);
  setSelectOptions(
    el("flowSubTheme"),
    subs.map((s) => ({ value: s.id, label: s.name })),
    subs[0]?.id
  );
}

function renderChoiceTable() {
  // UI removed for now to keep the publish page clean.
}

let editingPipelineId = null;

function getEditingPipeline() {
  if (!editingPipelineId) return null;
  const list = Array.isArray(config?.automationPipelines) ? config.automationPipelines : [];
  return list.find((p) => p.id === editingPipelineId) || null;
}

function startEditingPipeline(pipelineId) {
  editingPipelineId = pipelineId;
  const pipe = getEditingPipeline();
  const editorArea = document.getElementById("flowEditorArea");
  if (editorArea) editorArea.style.display = pipe ? "" : "none";
  if (pipe) {
    const plat = pipe.platforms?.[0] || "*";
    const field = pipe.field;
    el("editingFlowMeta").textContent = `编辑中：subTheme=${pipe.match?.subThemeId || pipe.match?.subThemePrefix || "?"} / platform=${plat} / field=${field} / priority=${pipe.priority ?? 0} / id=${pipe.id}`;

    // Sync selectors so user understands what they're editing.
    if (document.getElementById("flowSubTheme")) el("flowSubTheme").value = pipe.match?.subThemeId || el("flowSubTheme").value;
    if (document.getElementById("flowPlatform")) el("flowPlatform").value = plat;
    if (document.getElementById("flowField")) el("flowField").value = field;
    if (document.getElementById("flowPriority")) el("flowPriority").value = String(pipe.priority ?? 0);
  } else {
    el("editingFlowMeta").textContent = "未选择流程";
  }
  renderStepsTable();
  renderPreview();
}

function renderStepsTable() {
  const tbody = el("stepsTable").querySelector("tbody");
  tbody.innerHTML = "";
  const pipe = getEditingPipeline();
  if (!pipe) {
    const tr = document.createElement("tr");
    tr.appendChild(tdText("—"));
    tr.appendChild(tdText("—"));
    tr.appendChild(tdText("请先新增流程，或在列表中点“编辑”。"));
    tr.appendChild(tdText(""));
    tbody.appendChild(tr);
    return;
  }
  const steps = Array.isArray(pipe.steps) ? pipe.steps : [];

  steps.forEach((s, idx) => {
    const tr = document.createElement("tr");
    tr.appendChild(tdText(String(idx + 1)));
    tr.appendChild(tdText(s.type));

    const tdCfg = document.createElement("td");
    tdCfg.appendChild(stepEditor(s));
    tr.appendChild(tdCfg);

    const tdOps = document.createElement("td");
    tdOps.style.whiteSpace = "nowrap";
    const up = document.createElement("button");
    up.className = "secondary";
    up.textContent = "上移";
    up.disabled = idx === 0;
    up.addEventListener("click", () => {
      if (idx === 0) return;
      const tmp = steps[idx - 1];
      steps[idx - 1] = steps[idx];
      steps[idx] = tmp;
      updateRawFromConfig();
      renderStepsTable();
    });
    const down = document.createElement("button");
    down.className = "secondary";
    down.textContent = "下移";
    down.disabled = idx === steps.length - 1;
    down.addEventListener("click", () => {
      if (idx >= steps.length - 1) return;
      const tmp = steps[idx + 1];
      steps[idx + 1] = steps[idx];
      steps[idx] = tmp;
      updateRawFromConfig();
      renderStepsTable();
    });
    const del = document.createElement("button");
    del.className = "secondary";
    del.textContent = "删除";
    del.addEventListener("click", () => {
      pipe.steps = steps.filter((x) => x !== s);
      updateRawFromConfig();
      renderStepsTable();
    });
    tdOps.appendChild(up);
    tdOps.appendChild(down);
    tdOps.appendChild(del);
    tr.appendChild(tdOps);

    tbody.appendChild(tr);
  });
}

function stepEditor(step) {
  const wrap = document.createElement("div");
  wrap.style.display = "flex";
  wrap.style.gap = "8px";
  wrap.style.flexWrap = "wrap";

  if (step.type === "fixed") {
    const input = document.createElement("input");
    input.placeholder = "固定文本";
    input.value = step.text ?? "";
    input.addEventListener("input", () => {
      step.text = input.value;
      updateRawFromConfig();
    });
    wrap.appendChild(input);
    return wrap;
  }

  if (step.type === "var") {
    const sel = document.createElement("select");
    for (const v of ["day_n", "daily_theme", "topic", "hook"]) {
      const opt = document.createElement("option");
      opt.value = v;
      opt.textContent = v;
      sel.appendChild(opt);
    }
    sel.value = step.var || "day_n";
    sel.addEventListener("change", () => {
      step.var = sel.value;
      updateRawFromConfig();
    });
    wrap.appendChild(sel);
    return wrap;
  }

  if (step.type === "choice") {
    const label = document.createElement("input");
    label.placeholder = "单元名称（可选）";
    label.value = step.label ?? "";
    label.addEventListener("input", () => {
      step.label = label.value;
      updateRawFromConfig();
    });
    wrap.appendChild(label);

    const mode = document.createElement("select");
    for (const v of [
      { v: "manual", t: "发布时手选" },
      { v: "first", t: "固定第1个" },
      { v: "random", t: "随机" }
    ]) {
      const opt = document.createElement("option");
      opt.value = v.v;
      opt.textContent = v.t;
      mode.appendChild(opt);
    }
    mode.value = step.selectionMode || "manual";
    mode.addEventListener("change", () => {
      step.selectionMode = mode.value;
      updateRawFromConfig();
    });
    wrap.appendChild(mode);

    const ta = document.createElement("textarea");
    ta.style.minHeight = "70px";
    ta.placeholder = "每行一个选项";
    ta.value = (Array.isArray(step.options) ? step.options : []).join("\n");
    ta.addEventListener("input", () => {
      step.options = ta.value
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      updateRawFromConfig();
    });
    wrap.appendChild(ta);
    return wrap;
  }

  wrap.appendChild(document.createTextNode("（未知单元类型）"));
  return wrap;
}

function pipelineStructurePreview(pipeline) {
  if (!pipeline || !Array.isArray(pipeline.steps)) return "";
  const parts = [];
  for (const s of pipeline.steps) {
    if (!s || !s.type) continue;
    if (s.type === "fixed") {
      parts.push(String(s.text ?? ""));
      continue;
    }
    if (s.type === "var") {
      parts.push(`{${s.var || "var"}}`);
      continue;
    }
    if (s.type === "choice") {
      const options = Array.isArray(s.options) ? s.options : [];
      if (options.length === 1) parts.push(options[0]);
      else parts.push(`{${s.label || "choice"}}`);
      continue;
    }
  }
  return parts.join("");
}

function renderPreview() {
  const pipe = getEditingPipeline();
  const outEl = el("pvOutput");
  const structureEl = el("pvStructure");
  const needsEl = el("pvNeeds");
  if (!pipe) {
    outEl.textContent = "（未选择流程）";
    structureEl.textContent = "（未选择流程）";
    needsEl.textContent = "（未选择流程）";
    el("editingFlowMeta").textContent = "未选择流程";
    return;
  }
  const vars = {
    day_n: String(el("pvDayN").value || ""),
    daily_theme: el("pvDailyTheme").value || "",
    topic: el("pvTopic").value || "",
    hook: el("pvHook").value || ""
  };
  structureEl.textContent = pipelineStructurePreview(pipe) || "（空）";
  const res = applyPipeline(pipe, vars, {});
  outEl.textContent = res.value || "（空）";

  const needs = pipelineNeeds(pipe);
  const varName = (v) =>
    v === "day_n"
      ? "打卡天数(day_n)"
      : v === "daily_theme"
        ? "日更主题(daily_theme)"
        : v === "topic"
          ? "主题(topic)"
          : v === "hook"
            ? "钩子(hook)"
            : v;
  const parts = [];
  if (needs.vars?.length) parts.push(`变量：${needs.vars.map(varName).join("，")}`);
  if (needs.choices?.length) parts.push(`下拉需选择：${needs.choices.map((c) => c.label).join("，")}`);
  needsEl.textContent = parts.length ? parts.join("；") : "（无，需要项为空）";
}

async function checkExtension() {
  // If extension is installed, it can respond to a ping via window.postMessage bridge.
  const statusEl = el("extStatus");
  const timeout = (ms) => new Promise((r) => setTimeout(r, ms));
  let ok = false;
  window.postMessage({ type: "MPVPUB_PING" }, "*");
  const handler = (ev) => {
    if (ev.data && ev.data.type === "MPVPUB_PONG") ok = true;
  };
  window.addEventListener("message", handler);
  await timeout(250);
  window.removeEventListener("message", handler);
  state.extConnected = ok;
  statusEl.textContent = "Extension: " + (ok ? "connected" : "not detected");
}

async function lockAndPrepare() {
  const snap = state.snapshot;
  if (!snap) return;
  log("已锁定快照，开始后台 Prepare（扩展将打开各平台发布页并填充）…");
  // Ask extension to prepare. If extension missing, simulate prepare.
  window.postMessage({ type: "MPVPUB_PREPARE", snapshot: snap }, "*");
  // Demo fallback: if no extension status arrives, simulate prepare completion.
  const startedAt = Date.now();
  setTimeout(() => {
    if (state.extConnected && state.lastExtStatusAt > startedAt) return;
    for (const p of PLATFORMS) state.prepared.add(p.id);
    el("btnCommit").disabled = false;
    log("（Demo）全部平台已就绪，可点击“最终发布”。");
  }, 1500);
}

function commitAll() {
  const snap = state.snapshot;
  if (!snap) return;
  log("开始最终发布（Commit）…");
  window.postMessage({ type: "MPVPUB_COMMIT", snapshotId: snap.id }, "*");
  // Demo fallback:
  setTimeout(() => log("（Demo）已发布：抖音/小红书/视频号/B站"), 1200);
}

function init() {
  el("navPublish").addEventListener("click", showPublish);
  el("navConfig").addEventListener("click", () => {
    fillConfigForm(config);
    renderTaxonomyEditor();
    refreshFlowSubThemeSelect();
    renderFlowsTable();
    renderStepsTable();
    renderPreview();
    const editorArea = document.getElementById("flowEditorArea");
    if (editorArea) editorArea.style.display = editingPipelineId ? "" : "none";
    showConfig();
  });

  el("btnSaveConfig").addEventListener("click", () => {
    try {
      // Default: save from form fields (safe for non-coders).
      // Only if user explicitly edited raw JSON, parse and use it.
      let next = readConfigForm(config);
      if (rawEdited) {
        const raw = el("cfgRaw").value.trim();
        if (raw) next = JSON.parse(raw);
      }
      config = next;
      PLATFORMS = buildPlatformsFromConfig(config);
      saveUserConfig(config);
      fillConfigForm(config);
      refreshThemeSelectors();
      refreshFlowSubThemeSelect();
      renderFlowsTable();
      renderStepsTable();
      renderPreview();
      setDirty(false);
      // After saving, exit editing mode to reduce confusion.
      editingPipelineId = null;
      const editorArea = document.getElementById("flowEditorArea");
      if (editorArea) editorArea.style.display = "none";
      el("editingFlowMeta").textContent = "未选择流程";
      log("配置已保存（保存在本机浏览器）。返回“发布”即可生效。");
    } catch (e) {
      log("配置保存失败：" + String(e?.message || e));
    }
  });

  el("btnResetConfig").addEventListener("click", async () => {
    const defaults = await loadDefaultConfig();
    config = defaults;
    PLATFORMS = buildPlatformsFromConfig(config);
    localStorage.removeItem(STORAGE_KEY);
    fillConfigForm(config);
    refreshThemeSelectors();
    refreshFlowSubThemeSelect();
    renderFlowsTable();
    renderStepsTable();
    renderPreview();
    setDirty(false);
    log("已恢复默认配置。");
  });

  el("btnExportConfig").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "mpvpub.config.json";
    a.click();
    URL.revokeObjectURL(url);
  });

  el("btnImportConfig").addEventListener("click", () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const text = await file.text();
      try {
        const next = JSON.parse(text);
        config = next;
        PLATFORMS = buildPlatformsFromConfig(config);
        saveUserConfig(config);
        fillConfigForm(config);
        refreshThemeSelectors();
        refreshFlowSubThemeSelect();
        renderFlowsTable();
        renderStepsTable();
        renderPreview();
        setDirty(false);
        log("配置已导入并保存。");
      } catch (e) {
        log("导入失败：JSON格式不正确。");
      }
    };
    input.click();
  });

  el("btnAddFlow").addEventListener("click", () => {
    config.automationPipelines = Array.isArray(config.automationPipelines) ? config.automationPipelines : [];
    const subThemeId = el("flowSubTheme").value;
    const platform = el("flowPlatform").value;
    const field = el("flowField").value;
    const priority = Number(el("flowPriority").value || 0);

    const id = "pipe_" + Math.random().toString(16).slice(2);
    const pipe = {
      id,
      enabled: true,
      priority,
      match: { subThemeId },
      platforms: [platform],
      field,
      steps: []
    };
    config.automationPipelines.push(pipe);
    updateRawFromConfig();
    renderFlowsTable();
    startEditingPipeline(id);
    log("已新增自动化流程（空流程）。请在下方添加单元并调整顺序，然后点“保存”。");
  });

  el("btnAddStep").addEventListener("click", () => {
    const pipe = getEditingPipeline();
    if (!pipe) return log("请先新增一个流程（或未来支持选择已有流程进行编辑）。");
    pipe.steps = Array.isArray(pipe.steps) ? pipe.steps : [];
    const t = el("stepType").value;
    const stepId = "st_" + Math.random().toString(16).slice(2);
    if (t === "fixed") pipe.steps.push({ id: stepId, type: "fixed", text: "" });
    else if (t === "var") pipe.steps.push({ id: stepId, type: "var", var: "day_n" });
    else if (t === "choice") pipe.steps.push({ id: stepId, type: "choice", label: "", selectionMode: "manual", options: ["选项1"] });
    updateRawFromConfig();
    renderStepsTable();
    renderPreview();
  });

  el("btnClearEditing").addEventListener("click", () => {
    editingPipelineId = null;
    el("editingFlowMeta").textContent = "未选择流程";
    const editorArea = document.getElementById("flowEditorArea");
    if (editorArea) editorArea.style.display = "none";
    renderFlowsTable();
    renderStepsTable();
    renderPreview();
  });

  el("btnSaveAndExit").addEventListener("click", () => {
    // Trigger global save, which also exits editing mode.
    el("btnSaveConfig").click();
  });

  for (const id of ["pvDayN", "pvDailyTheme", "pvTopic", "pvHook"]) {
    el(id).addEventListener("input", renderPreview);
  }

  el("btnTaxAddMajor").addEventListener("click", () => {
    const name = el("taxNewName").value.trim();
    if (!name) return log("请先填写“新名称”。");
    config.taxonomy = config.taxonomy || {};
    config.taxonomy.roots = Array.isArray(config.taxonomy.roots) ? config.taxonomy.roots : [];
    const id = "major_" + Math.random().toString(16).slice(2);
    config.taxonomy.roots.push({ id, name, children: [] });
    el("taxNewName").value = "";
    updateRawFromConfig();
    renderTaxonomyEditor();
    refreshThemeSelectors();
    refreshFlowSubThemeSelect();
    log("已新增大主题。");
  });

  el("btnTaxAddSub").addEventListener("click", () => {
    const name = el("taxNewName").value.trim();
    if (!name) return log("请先填写“新名称”。");
    const majorId = el("taxMajorSelect").value;
    const roots = config?.taxonomy?.roots || [];
    const major = roots.find((r) => r.id === majorId);
    if (!major) return log("请选择一个大主题。");
    major.children = Array.isArray(major.children) ? major.children : [];
    const id = majorId + "_" + Math.random().toString(16).slice(2);
    major.children.push({ id, name });
    el("taxNewName").value = "";
    updateRawFromConfig();
    renderTaxonomyEditor();
    refreshThemeSelectors();
    refreshFlowSubThemeSelect();
    log("已新增子主题。");
  });

  el("cfgRaw").addEventListener("input", () => {
    rawEdited = true;
    setDirty(true);
  });

  window.addEventListener("message", (ev) => {
    const msg = ev.data;
    if (!msg || typeof msg.type !== "string") return;
    if (!msg.type.startsWith("MPVPUB_")) return;

    if (msg.type === "MPVPUB_PONG") {
      state.extConnected = true;
      el("extStatus").textContent = "Extension: connected";
      return;
    }

    if (msg.type === "MPVPUB_STATUS") {
      state.lastExtStatusAt = Date.now();
      const p = msg.platformId ? `平台=${msg.platformId}` : "";
      log(`[Extension] ${msg.phase}:${msg.state} ${p}`.trim());
      if (msg.phase === "prepare" && (msg.state === "prepared" || msg.state === "prepared_stub")) {
        if (msg.platformId) state.prepared.add(msg.platformId);
        if (state.prepared.size === PLATFORMS.length) {
          el("btnCommit").disabled = false;
          log("全部平台已就绪，可点击“最终发布”。");
        }
      }
      if (msg.phase === "commit" && msg.state === "done") {
        log("最终发布完成（扩展回报）。");
      }
    }
  });

  el("baseDate").value = todayISO();
  el("videoFile").addEventListener("change", refreshFileMeta);
  el("verticalCoverFile").addEventListener("change", refreshFileMeta);
  el("horizontalCoverFile").addEventListener("change", refreshFileMeta);
  refreshFileMeta();

  refreshThemeSelectors();
  el("majorTheme").addEventListener("change", () => {
    refreshThemeSelectors();
  });
  el("subTheme").addEventListener("change", () => {
    refreshThemeSelectors();
  });

  el("btnAddMajorTheme").addEventListener("click", () => {
    const name = prompt("请输入新大主题名称：");
    if (!name) return;
    config.taxonomy = config.taxonomy || {};
    config.taxonomy.roots = Array.isArray(config.taxonomy.roots) ? config.taxonomy.roots : [];
    const id = "major_" + Math.random().toString(16).slice(2);
    config.taxonomy.roots.push({ id, name: name.trim(), children: [] });
    saveUserConfig(config);
    refreshThemeSelectors();
    log("已新增大主题（已保存）。");
  });

  el("btnAddSubTheme").addEventListener("click", () => {
    const majorId = el("majorTheme").value;
    const name = prompt("请输入新子主题名称：");
    if (!name) return;
    const roots = config?.taxonomy?.roots || [];
    const major = roots.find((r) => r.id === majorId);
    if (!major) return;
    major.children = Array.isArray(major.children) ? major.children : [];
    const id = majorId + "_" + Math.random().toString(16).slice(2);
    major.children.push({ id, name: name.trim() });
    saveUserConfig(config);
    refreshThemeSelectors();
    log("已新增子主题（已保存）。");
  });

  el("btnGenerate").addEventListener("click", () => {
    const input = getInput();
    if (!input.majorTheme) return log("请先选择大主题。");
    if (!input.subTheme) return log("请先选择子主题（如果下拉框为空，请先“新建子主题”）。");
    if (!input.baseDate) return log("请先选择基准日期。");
    state.snapshot = createSnapshot(input);
    el("snapshotInfo").textContent = `snapshot: ${state.snapshot.id} (baseDate=${state.snapshot.baseDate})`;
    renderMatrix(state.snapshot);
    el("btnLock").disabled = false;
    el("btnCommit").disabled = true;
    state.prepared.clear();
    log("预览已生成。确认无误后点击“锁定并准备发布”。");
  });
  el("btnLock").addEventListener("click", async () => {
    el("btnLock").disabled = true;
    await lockAndPrepare();
  });
  el("btnCommit").addEventListener("click", commitAll);
  el("btnReset").addEventListener("click", () => location.reload());
  checkExtension();
}

function renderTaxonomyEditor() {
  const idx = buildTaxonomyIndex(config);
  setSelectOptions(
    el("taxMajorSelect"),
    idx.major.map((m) => ({ value: m.id, label: m.name })),
    el("taxMajorSelect").value || idx.major[0]?.id
  );
}

async function boot() {
  const defaults = await loadDefaultConfig();
  const user = loadUserConfig();
  config = mergeConfig(defaults, user);
  PLATFORMS = buildPlatformsFromConfig(config);
  fillConfigForm(config);
  init();
}

function mergeConfig(defaults, user) {
  if (!user || typeof user !== "object") return deepClone(defaults);
  const merged = deepClone(defaults);

  // Shallow merge known top-level keys; keep user's overrides.
  for (const k of Object.keys(user)) merged[k] = user[k];

  // Ensure required nested keys exist (backward compatible).
  merged.userDefaults = { ...defaults.userDefaults, ...(user.userDefaults || {}) };
  merged.userDefaults.cover = { ...(defaults.userDefaults?.cover || {}), ...(user.userDefaults?.cover || {}) };
  merged.schedulePolicy = { ...defaults.schedulePolicy, ...(user.schedulePolicy || {}) };
  merged.schedulePolicy.platformTimes = {
    ...(defaults.schedulePolicy?.platformTimes || {}),
    ...(user.schedulePolicy?.platformTimes || {})
  };
  merged.taxonomy = user.taxonomy?.roots ? user.taxonomy : defaults.taxonomy;
  merged.templates = { ...defaults.templates, ...(user.templates || {}) };
  merged.templates.title = { ...(defaults.templates?.title || {}), ...(user.templates?.title || {}) };
  merged.templates.description = { ...(defaults.templates?.description || {}), ...(user.templates?.description || {}) };
  merged.templates.tags = { ...(defaults.templates?.tags || {}), ...(user.templates?.tags || {}) };

  merged.platformConstraints = { ...defaults.platformConstraints, ...(user.platformConstraints || {}) };

  // Arrays: keep user's if present, else defaults.
  merged.automationDefaults = Array.isArray(user.automationDefaults) ? user.automationDefaults : defaults.automationDefaults;
  merged.automationPipelines = Array.isArray(user.automationPipelines) ? user.automationPipelines : (defaults.automationPipelines || []);

  return merged;
}

boot().catch((e) => {
  log("启动失败：" + String(e?.message || e));
});
