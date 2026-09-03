import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  currentMonitor,
  getCurrentWindow,
  PhysicalPosition,
} from "@tauri-apps/api/window";

interface GpuInfo {
  index: number;
  name: string;
  utilPct: number;
  memUsedMb: number;
  memTotalMb: number;
}

interface ProcessInfo {
  name: string;
  memoryMb: number;
}

interface Snapshot {
  cpuUsage: number;
  memoryUsage: number;
  memoryUsedGb: number;
  memoryTotalGb: number;
  diskUsage: number;
  diskReadSpeed: number;
  diskWriteSpeed: number;
  netDownloadSpeed: number;
  netUploadSpeed: number;
  gpus: GpuInfo[];
  processes: ProcessInfo[];
}

interface Settings {
  autoStart: boolean;
  closeAction: string;
  desktopMode: string;
  textColor: string;
  fontSize: number;
  opacity: number;
  alwaysOnTop: boolean;
  // 显示风格
  stylePreset: string; // default | curve | minimal | cards | custom
  layout: string; // list | grid
  cpuDisplay: string; // ring | spark | bar | text
  memDisplay: string; // bar | spark | text
  gpuDisplay: string; // bar | spark | text
  diskDisplay: string; // bar | spark | text
  netDisplay: string; // stats | text | spark
}

const win = getCurrentWindow();
const MAX_POINTS = 60;
const RING_CIRC = 2 * Math.PI * 26;

// ── 风格预设：layout + 每个模块的显示方式 ──
const PRESETS: Record<
  string,
  { layout: string; cpu: string; mem: string; gpu: string; disk: string; net: string }
> = {
  default: { layout: "list", cpu: "ring", mem: "bar", gpu: "bar", disk: "bar", net: "stats" },
  curve: { layout: "list", cpu: "spark", mem: "spark", gpu: "spark", disk: "spark", net: "spark" },
  minimal: { layout: "list", cpu: "text", mem: "text", gpu: "text", disk: "text", net: "text" },
  cards: { layout: "grid", cpu: "bar", mem: "bar", gpu: "bar", disk: "bar", net: "stats" },
};

const DEFAULT_SETTINGS: Settings = {
  autoStart: false,
  closeAction: "toTray",
  desktopMode: "floating",
  textColor: "#FFFFFF",
  fontSize: 12,
  opacity: 1,
  alwaysOnTop: true,
  stylePreset: "default",
  layout: "list",
  cpuDisplay: "ring",
  memDisplay: "bar",
  gpuDisplay: "bar",
  diskDisplay: "bar",
  netDisplay: "stats",
};

let settings: Settings = { ...DEFAULT_SETTINGS };
let lastSnap: Snapshot = {
  cpuUsage: 0, memoryUsage: 0, memoryUsedGb: 0, memoryTotalGb: 0,
  diskUsage: 0, diskReadSpeed: 0, diskWriteSpeed: 0,
  netDownloadSpeed: 0, netUploadSpeed: 0,
  gpus: [], processes: [],
};

// ── 曲线历史缓存（spark 用）──
const hist = {
  cpu: [] as number[],
  mem: [] as number[],
  gpu: [] as number[][],
  diskR: [] as number[],
  diskW: [] as number[],
  netD: [] as number[],
  netU: [] as number[],
};

function push(arr: number[], v: number) {
  arr.push(v);
  if (arr.length > MAX_POINTS) arr.shift();
}

function updateHist(s: Snapshot) {
  push(hist.cpu, s.cpuUsage);
  push(hist.mem, s.memoryUsage);
  push(hist.diskR, s.diskReadSpeed);
  push(hist.diskW, s.diskWriteSpeed);
  push(hist.netD, s.netDownloadSpeed);
  push(hist.netU, s.netUploadSpeed);
  while (hist.gpu.length < s.gpus.length) hist.gpu.push([]);
  s.gpus.forEach((g) => push(hist.gpu[g.index] ?? (hist.gpu[g.index] = []), g.utilPct));
}

// ── DOM 引用 ──
const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;

// ── 模块图标 ──
const ICONS = {
  cpu: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="var(--accent)" d="M6 18V6h12v12H6zm2-2h8V8H8v8zm-3 3H3v2h2v-2zm0-14H3v2h2V5zm14 0h-2v2h2V5zm0 14h-2v2h2v-2z"/></svg>',
  mem: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="#10B981" d="M4 5h16v14H4V5zm2 2v10h12V7H6zm1 1h10v8H7V8zm2 2v4h2v-4H9zm4 0v4h2v-4h-2z"/></svg>',
  gpu: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="#8B5CF6" d="M3 4h18v12H3V4zm2 2v8h14V6H5zm2 2h10v4H7V8z"/></svg>',
  disk: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="#F59E0B" d="M6 2h12a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm0 12v4h12v-4H6zm9-1.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z"/></svg>',
  net: '<svg viewBox="0 0 24 24" width="14" height="14"><path fill="#8B5CF6" d="M12 3a9 9 0 0 0-9 9h2a7 7 0 0 1 7-7V3zm0 4a5 5 0 0 0-5 5h2a3 3 0 0 1 3-3V7zm0 4a1 1 0 1 0 0 2 1 1 0 0 0 0-2zm-7 5H3v3h3v-3zm4 0H7v3h3v-3zm3 0h-1v3h3v-3zm4 0h-2v3h3v-3z"/></svg>',
};

// ── 生效的显示配置：预设 or 自定义 ──
function eff() {
  if (settings.stylePreset === "custom") {
    return {
      layout: settings.layout || "list",
      cpu: settings.cpuDisplay, mem: settings.memDisplay,
      gpu: settings.gpuDisplay, disk: settings.diskDisplay, net: settings.netDisplay,
    };
  }
  const p = PRESETS[settings.stylePreset] ?? PRESETS.default;
  return { layout: p.layout, cpu: p.cpu, mem: p.mem, gpu: p.gpu, disk: p.disk, net: p.net };
}

// ── 设置 ──
async function loadSettings() {
  try {
    settings = { ...DEFAULT_SETTINGS, ...(await invoke<Settings>("get_settings")) };
  } catch {
    /* 默认值兜底 */
  }
  applySettings();
}

function applySettings() {
  const root = document.documentElement;
  root.style.setProperty("--text", settings.textColor);
  root.style.setProperty("--muted", hexWithAlpha(settings.textColor, 0.55));
  root.style.setProperty("--faint", hexWithAlpha(settings.textColor, 0.24));
  root.style.setProperty("--font-size-base", `${settings.fontSize}px`);
  // 透明度只作用于主窗口（设置窗口始终不透明）。
  // Win32 LWA_ALPHA 对 WS_EX_NOREDIRECTIONBITMAP 的 WebView2 窗口无效，改用 CSS opacity。
  if (win.label !== "settings") {
    document.body.style.opacity = String(settings.opacity);
  }

  const setOpacity = $("set-opacity") as HTMLInputElement | null;
  const setFontsize = $("set-fontsize") as HTMLInputElement | null;
  const setAlwaysTop = $("set-alwaystop") as HTMLInputElement | null;
  const setAuto = $("set-autostart") as HTMLInputElement | null;
  const setCloseAction = $("set-closeaction") as HTMLSelectElement | null;
  const setDesktop = $("set-desktopmode") as HTMLSelectElement | null;
  const opacityVal = $("opacity-val");
  const fontSizeVal = $("font-size-val");
  if (opacityVal) opacityVal.textContent = `${Math.round(settings.opacity * 100)}%`;
  if (setOpacity) setOpacity.value = String(Math.round(settings.opacity * 100));
  if (setFontsize) setFontsize.value = String(settings.fontSize);
  if (fontSizeVal) fontSizeVal.textContent = String(settings.fontSize);
  if (setAlwaysTop) setAlwaysTop.checked = settings.alwaysOnTop;
  (document.querySelectorAll(".color-dot") as NodeListOf<HTMLButtonElement>).forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.color === settings.textColor);
  });
  if (setAuto) setAuto.checked = settings.autoStart;
  if (setCloseAction) setCloseAction.value = settings.closeAction;
  if (setDesktop) setDesktop.value = settings.desktopMode;

  // 风格相关控件同步
  (document.querySelectorAll(".preset-btn") as NodeListOf<HTMLButtonElement>).forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.preset === settings.stylePreset);
  });
  const setSel = (id: string, val: string) => {
    const el = $(id) as HTMLSelectElement | null;
    if (el) el.value = val;
  };
  setSel("set-cpu-display", settings.cpuDisplay);
  setSel("set-mem-display", settings.memDisplay);
  setSel("set-gpu-display", settings.gpuDisplay);
  setSel("set-disk-display", settings.diskDisplay);
  setSel("set-net-display", settings.netDisplay);
}

function hexWithAlpha(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

async function saveSettings(patch: Partial<Settings>) {
  settings = { ...settings, ...patch };
  applySettings();
  try {
    await invoke("update_settings", { settings });
  } catch {}
}

// ── 初始化 ──
async function init() {
  await loadSettings();

  // 区分主窗口 vs 设置窗口（同一个 index.html）
  const isSettingsWindow = win.label === "settings";

  if (isSettingsWindow) {
    applySettings();
    // 设置窗口也监听 settings-changed：托盘「置顶/取消置顶」等非本窗口发起的变更要同步到控件
    listen<Settings>("settings-changed", (event) => {
      settings = { ...settings, ...event.payload };
      applySettings();
    });
    // 设置窗口：显示设置面板，隐藏主内容
    const sp = $("settings-panel");
    const content = document.querySelector(".content");
    const titlebar = document.querySelector(".titlebar");
    sp?.classList.remove("hidden");
    content?.classList.add("hidden");
    titlebar?.classList.add("hidden");
    $("resize-grip")?.classList.add("hidden"); // 设置窗口用系统标题栏，不需要手柄
    // 文字颜色
    (document.querySelectorAll(".color-dot") as NodeListOf<HTMLButtonElement>).forEach((btn) => {
      btn.addEventListener("click", () => saveSettings({ textColor: btn.dataset.color! }));
    });
    // 透明度 → 保存（主窗口 CSS 实时应用）
    $("set-opacity")?.addEventListener("input", (e) => {
      saveSettings({ opacity: Number((e.target as HTMLInputElement).value) / 100 });
    });
    // 字号
    $("set-fontsize")?.addEventListener("input", (e) => {
      saveSettings({ fontSize: Number((e.target as HTMLInputElement).value) });
    });
    // 始终置顶
    $("set-alwaystop")?.addEventListener("change", (e) => {
      const v = (e.target as HTMLInputElement).checked;
      saveSettings({ alwaysOnTop: v });
    });
    $("set-autostart")?.addEventListener("change", (e) => {
      saveSettings({ autoStart: (e.target as HTMLInputElement).checked });
    });
    $("set-closeaction")?.addEventListener("change", (e) => {
      saveSettings({ closeAction: (e.target as HTMLSelectElement).value });
    });
    $("set-desktopmode")?.addEventListener("change", (e) => {
      saveSettings({ desktopMode: (e.target as HTMLSelectElement).value });
    });
    // 风格预设按钮：整套套用
    (document.querySelectorAll(".preset-btn") as NodeListOf<HTMLButtonElement>).forEach((btn) => {
      btn.addEventListener("click", () => {
        const name = btn.dataset.preset!;
        const p = PRESETS[name];
        if (!p) return;
        saveSettings({
          stylePreset: name, layout: p.layout,
          cpuDisplay: p.cpu, memDisplay: p.mem, gpuDisplay: p.gpu,
          diskDisplay: p.disk, netDisplay: p.net,
        });
      });
    });
    // 分模块下拉：改任意一项 → 切到自定义
    const bindDisplay = (
      id: string,
      key: "cpuDisplay" | "memDisplay" | "gpuDisplay" | "diskDisplay" | "netDisplay",
    ) => {
      $(id)?.addEventListener("change", (ev) => {
        saveSettings({
          stylePreset: "custom",
          [key]: (ev.target as HTMLSelectElement).value,
        } as Partial<Settings>);
      });
    };
    bindDisplay("set-cpu-display", "cpuDisplay");
    bindDisplay("set-mem-display", "memDisplay");
    bindDisplay("set-gpu-display", "gpuDisplay");
    bindDisplay("set-disk-display", "diskDisplay");
    bindDisplay("set-net-display", "netDisplay");
    return;
  }

  // ── 主窗口逻辑 ──
  applySettings();

  await listen<Snapshot>("snapshot", (event) => {
    lastSnap = event.payload;
    updateHist(lastSnap);
    renderAll();
  });
  // 设置变更（来自设置窗口的广播）→ 主窗口重新应用字号/颜色/风格/桌面位置
  await listen<Settings>("settings-changed", (event) => {
    settings = { ...settings, ...event.payload };
    applySettings();
    renderAll();
    applyDesktopMode(settings.desktopMode);
  });
  // 设置按钮 → 打开独立设置窗口
  $("btn-settings")?.addEventListener("click", () => invoke("open_settings_window").catch(() => {}));
  await listen("open-settings", () => invoke("open_settings_window").catch(() => {}));

  $("btn-procs")?.addEventListener("click", () => $("proc-wrap")?.classList.toggle("hidden"));
  $("btn-close")?.addEventListener("click", () => invoke("request_close"));

  // 标题栏拖动（设置窗口打开也可拖动——不再有拦截）
  const titlebar = document.querySelector(".titlebar") as HTMLElement;
  titlebar?.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement | null;
    if (!target || target.closest(".tb-btn")) return;
    win.startDragging().catch(() => {});
  });

  // 右下角手柄 → 调整窗口大小（无边框窗口边缘热区太小，靠它）
  $("resize-grip")?.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    win.startResizeDragging("SouthEast").catch(() => {});
  });

  await applyDesktopMode(settings.desktopMode);

  renderAll();
}

// ── 渲染辅助 ──
function cardHead(icon: string, title: string, valueHtml: string): string {
  return `<div class="card-head"><div class="card-title">${icon}<span>${title}</span></div>${valueHtml}</div>`;
}

function textRow(icon: string, label: string, val: string, unit = ""): string {
  return `<div class="text-row"><span class="tr-label">${icon}<span>${escapeHtml(label)}</span></span><span class="tr-val">${val}${unit ? `<span class="unit">${unit}</span>` : ""}</span></div>`;
}

function sparkVal(v: string, unit = ""): string {
  return `<span class="spark-val">${v}${unit ? `<span class="unit">${unit}</span>` : ""}</span>`;
}

// ── 主渲染 ──
function renderAll() {
  const el = $("modules");
  if (!el) return;
  const e = eff();
  el.className = e.layout === "grid" ? "grid" : "";
  const s = lastSnap;
  el.innerHTML =
    renderCpu(e.cpu, s, e.layout) +
    renderMem(e.mem, s) +
    renderGpus(e.gpu, s) +
    renderDisk(e.disk, s) +
    renderNet(e.net, s);
  drawCanvases(e, s);
  renderProcs(s.processes);
}

function renderCpu(mode: string, s: Snapshot, layout: string): string {
  const v = s.cpuUsage.toFixed(0);
  if (mode === "text") return textRow(ICONS.cpu, "CPU", `${v}%`);
  if (mode === "bar") {
    return `<div class="card">${cardHead(ICONS.cpu, "CPU", `<span class="card-value">${v}%</span>`)}<div class="bar"><div class="bar-fill" style="width:${Math.min(100, s.cpuUsage)}%;background:var(--accent)"></div></div></div>`;
  }
  if (mode === "spark") {
    return `<div class="card spark-card">${cardHead(ICONS.cpu, "CPU", sparkVal(`${v}%`))}<canvas id="sp-cpu"></canvas></div>`;
  }
  // ring（默认）：双列布局时占满整行
  const off = RING_CIRC * (1 - Math.min(100, s.cpuUsage) / 100);
  return `<div class="card${layout === "grid" ? " span-full" : ""}">
    ${cardHead(ICONS.cpu, "CPU", `<span class="card-value">${v}%</span>`)}
    <div class="cpu-row">
      <div class="ring-wrap">
        <svg class="ring" viewBox="0 0 60 60">
          <circle class="ring-bg" cx="30" cy="30" r="26"/>
          <circle class="ring-fg" cx="30" cy="30" r="26" style="stroke-dashoffset:${off}"/>
        </svg>
        <span class="ring-text">${v}</span>
      </div>
      <canvas id="cpu-chart"></canvas>
    </div>
  </div>`;
}

function renderMem(mode: string, s: Snapshot): string {
  const v = s.memoryUsage.toFixed(0);
  const gb = `${s.memoryUsedGb.toFixed(1)} / ${s.memoryTotalGb.toFixed(1)} GB`;
  if (mode === "text") return textRow(ICONS.mem, "内存", `${v}%`, `${s.memoryUsedGb.toFixed(1)}/${s.memoryTotalGb.toFixed(0)}G`);
  if (mode === "spark") {
    return `<div class="card spark-card">${cardHead(ICONS.mem, "内存", sparkVal(`${v}%`))}<canvas id="sp-mem"></canvas><div class="sub-text">${gb}</div></div>`;
  }
  return `<div class="card">${cardHead(ICONS.mem, "内存", `<span class="card-value">${v}%</span>`)}<div class="bar"><div class="bar-fill" style="width:${Math.min(100, s.memoryUsage)}%;background:#10B981"></div></div><div class="sub-text">${gb}</div></div>`;
}

function renderGpus(mode: string, s: Snapshot): string {
  return s.gpus
    .map((g) => {
      const title = `GPU${g.index} · ${g.name}`;
      const v = g.utilPct.toFixed(0);
      const memText = `显存 ${g.memUsedMb.toFixed(0)} / ${g.memTotalMb.toFixed(0)} MB`;
      if (mode === "text") return textRow(ICONS.gpu, title, `${v}%`, `显存${(g.memUsedMb / 1024).toFixed(1)}G`);
      if (mode === "spark") {
        return `<div class="card spark-card">${cardHead(ICONS.gpu, escapeHtml(title), sparkVal(`${v}%`))}<canvas id="sp-gpu-${g.index}"></canvas><div class="sub-text">${memText}</div></div>`;
      }
      return `<div class="card">${cardHead(ICONS.gpu, escapeHtml(title), `<span class="card-value">${v}%</span>`)}<div class="bar"><div class="bar-fill" style="width:${Math.min(100, g.utilPct)}%;background:#8B5CF6"></div></div><div class="sub-text">${memText}</div></div>`;
    })
    .join("");
}

function renderDisk(mode: string, s: Snapshot): string {
  const v = s.diskUsage.toFixed(0);
  const rw = `<div class="mini-stats"><span class="mini"><svg viewBox="0 0 24 24" width="11" height="11"><path fill="currentColor" d="M11 5h2v14h-2zM7 9h2v10H7zm8-2h2v12h-2z"/></svg>读 <b>${s.diskReadSpeed.toFixed(1)}</b> MB/s</span><span class="mini"><svg viewBox="0 0 24 24" width="11" height="11"><path fill="currentColor" d="M11 5h2v14h-2zM7 9h2v10H7zm8-2h2v12h-2z"/></svg>写 <b>${s.diskWriteSpeed.toFixed(1)}</b> MB/s</span></div>`;
  if (mode === "text") {
    return textRow(ICONS.disk, "磁盘", `${v}%`, `读${s.diskReadSpeed.toFixed(1)} 写${s.diskWriteSpeed.toFixed(1)}MB/s`);
  }
  if (mode === "spark") {
    return `<div class="card spark-card">${cardHead(ICONS.disk, "磁盘", sparkVal(`${v}%`))}<canvas id="sp-disk"></canvas>${rw}</div>`;
  }
  return `<div class="card">${cardHead(ICONS.disk, "磁盘", `<span class="card-value">${v}%</span>`)}<div class="bar"><div class="bar-fill" style="width:${Math.min(100, s.diskUsage)}%;background:#F59E0B"></div></div>${rw}</div>`;
}

function renderNet(mode: string, s: Snapshot): string {
  const d = formatSpeed(s.netDownloadSpeed);
  const u = formatSpeed(s.netUploadSpeed);
  if (mode === "spark") {
    return `<div class="card spark-card">${cardHead(ICONS.net, "网络", sparkVal(`<span class="net-down">↓${d}</span> <span class="net-up">↑${u}</span>`))}<canvas id="sp-net"></canvas><div class="sub-text">单位 KB/s</div></div>`;
  }
  if (mode === "text") {
    return `<div class="text-row"><span class="tr-label">${ICONS.net}<span>网络</span></span><span class="tr-val"><span class="net-down">↓${d}</span> <span class="net-up">↑${u}</span><span class="unit">KB/s</span></span></div>`;
  }
  // stats（默认卡片）
  return `<div class="card">
    ${cardHead(ICONS.net, "网络", "")}
    <div class="mini-stats">
      <span class="mini net-down"><svg viewBox="0 0 24 24" width="11" height="11"><path fill="currentColor" d="M12 3v12l-4-4-1.4 1.4L12 17.8l5.4-5.4L16 11l-4 4V3h-2z"/></svg>下载 <b>${d}</b> KB/s</span>
      <span class="mini net-up"><svg viewBox="0 0 24 24" width="11" height="11"><path fill="currentColor" d="M12 21V9L8 13l-1.4-1.4L12 6.2l5.4 5.4L16 13l-4-4v12h-2z"/></svg>上传 <b>${u}</b> KB/s</span>
    </div>
  </div>`;
}

// ── spark 画布绘制 ──
function drawCanvases(e: { cpu: string; mem: string; gpu: string; disk: string; net: string }, s: Snapshot) {
  if (e.cpu === "ring") drawChart(hist.cpu);
  if (e.cpu === "spark") drawSpark("sp-cpu", [hist.cpu], ["#4C8DF5"], 100);
  if (e.mem === "spark") drawSpark("sp-mem", [hist.mem], ["#10B981"], 100);
  if (e.gpu === "spark") s.gpus.forEach((g) => drawSpark(`sp-gpu-${g.index}`, [hist.gpu[g.index] ?? []], ["#8B5CF6"], 100));
  if (e.disk === "spark") drawSpark("sp-disk", [hist.diskR, hist.diskW], ["#F59E0B", "#8B5CF6"], null);
  if (e.net === "spark") drawSpark("sp-net", [hist.netD, hist.netU], ["#10B981", "#F59E0B"], null);
}

function drawSpark(id: string, series: number[][], colors: string[], fixedMax: number | null) {
  const canvas = document.getElementById(id) as HTMLCanvasElement | null;
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 200;
  const h = canvas.clientHeight || 40;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const maxLen = Math.max(0, ...series.map((a) => a.length));
  if (maxLen < 2) {
    ctx.fillStyle = "rgba(255,255,255,0.3)";
    ctx.font = "10px sans-serif";
    ctx.fillText("采集中...", 8, h / 2 + 3);
    return;
  }

  let max = fixedMax ?? 0;
  if (!max) {
    for (const a of series) for (const v of a) if (v > max) max = v;
    if (max <= 0) max = 1;
  }
  const step = w / (MAX_POINTS - 1);
  series.forEach((a, si) => {
    if (a.length < 2) return;
    ctx.beginPath();
    const offset = MAX_POINTS - a.length; // 曲线右对齐，随时间向左滚动
    a.forEach((val, i) => {
      const x = (offset + i) * step;
      const y = h - 2 - (Math.min(val, max) / max) * (h - 6);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = colors[si] ?? "#4C8DF5";
    ctx.stroke();
  });
}

// ── CPU 折线（ring 模式大图）──
function drawChart(data: number[]) {
  const canvas = document.getElementById("cpu-chart") as HTMLCanvasElement | null;
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 200;
  const h = canvas.clientHeight || 52;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext("2d")!;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  if (data.length < 2) {
    ctx.fillStyle = "rgba(255,255,255,0.3)";
    ctx.font = "10px sans-serif";
    ctx.fillText("采集中...", 8, h / 2 + 3);
    return;
  }

  const step = w / (MAX_POINTS - 1);
  ctx.beginPath();
  ctx.moveTo(0, h - (data[0] / 100) * h);
  data.forEach((v, i) => {
    ctx.lineTo(i * step, h - (v / 100) * h);
  });
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "#4C8DF5";
  ctx.stroke();

  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, "rgba(76,141,245,0.25)");
  grad.addColorStop(1, "rgba(76,141,245,0)");
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();
}

function formatSpeed(kbs: number): string {
  // 网络速率后端已换算为 KB/s（monitor.rs 中 /1024）。这里不再二次换算成 MB/s，
  // 否则值变成 MB 量级但所有调用处标签仍写死 "KB/s"，单位会错。
  return kbs.toFixed(1);
}

function renderProcs(procs: ProcessInfo[]) {
  const wrap = $("proc-wrap");
  if (!wrap) return;
  if (!procs.length) {
    wrap.innerHTML = "";
    return;
  }
  wrap.innerHTML =
    `<div class="card" style="margin-bottom:0"><div class="card-title" style="margin-bottom:6px">进程 (Top 8)</div>` +
    procs
      .map(
        (p) =>
          `<div class="proc-row"><span class="proc-name">${escapeHtml(p.name)}</span><span class="proc-mem">${p.memoryMb.toFixed(0)} MB</span></div>`
      )
      .join("") +
    `</div>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
  })[c]!);
}

// ── 桌面位置模式 ──
async function applyDesktopMode(mode: string) {
  if (mode === "floating") return;
  try {
    const monitor = await currentMonitor();
    if (!monitor) return;
    const size = await win.innerSize();
    const sw = monitor.size.width;
    const x = mode === "topRight" ? sw - size.width - 10 : 10;
    await win.setPosition(new PhysicalPosition(x, 10));
  } catch {}
}

window.addEventListener("DOMContentLoaded", init);
