use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use sysinfo::{Disks, Networks, ProcessesToUpdate, System};
use tauri::{AppHandle, Emitter};

use crate::gpu::collect_gpus;
/// GPU 快照的最新值（由独立线程刷新，主循环直接读取）
/// Arc<Mutex> 共享：内层 Mutex 保护数据，Arc 允许在线程间克隆句柄
#[derive(Clone)]
pub struct GpuCache {
    inner: Arc<Mutex<Vec<GpuInfo>>>,
}

impl GpuCache {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Vec::new())),
        }
    }

    pub fn set(&self, gpus: Vec<GpuInfo>) {
        if let Ok(mut cur) = self.inner.lock() {
            *cur = gpus;
        }
    }

    pub fn get(&self) -> Vec<GpuInfo> {
        self.inner.lock().map(|v| v.clone()).unwrap_or_default()
    }
}

/// 单块 GPU 信息
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuInfo {
    pub index: usize,
    pub name: String,
    pub util_pct: f64,
    pub mem_used_mb: f64,
    pub mem_total_mb: f64,
}

/// 一次采集快照
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub cpu_usage: f64,
    pub memory_usage: f64,
    pub memory_used_gb: f64,
    pub memory_total_gb: f64,
    pub disk_usage: f64,
    pub disk_read_speed: f64,
    pub disk_write_speed: f64,
    pub net_download_speed: f64,
    pub net_upload_speed: f64,
    pub gpus: Vec<GpuInfo>,
    pub processes: Vec<ProcessInfo>,
}

/// 进程信息
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    pub name: String,
    pub memory_mb: f64,
}

/// 数据源：sysinfo（CPU/内存/磁盘/网络/进程）+ DXGI/PDH（GPU）
/// 采集，通过 "snapshot" 事件推给前端
/// 主循环 2Hz（500ms）；GPU 采集（PDH 双拍热身 ~750ms）跑在独立线程，
/// 通过 GpuCache 共享，避免拖慢主循环的实际刷新率。
pub fn start_monitor(app: AppHandle) {
    let gpu_cache = GpuCache::new();
    // ── GPU 独立线程 ──
    {
        let cache = gpu_cache.clone();
        std::thread::spawn(move || {
            loop {
                cache.set(collect_gpus());
                std::thread::sleep(Duration::from_millis(1000));
            }
        });
    }

    std::thread::spawn(move || {
        let mut sys = System::new_all();
        let mut networks = Networks::new_with_refreshed_list();
        let mut disks = Disks::new_with_refreshed_list();

        let mut prev_net: std::collections::HashMap<String, (u64, u64)> =
            std::collections::HashMap::new();
        let mut prev_disk: std::collections::HashMap<String, (u64, u64)> =
            std::collections::HashMap::new();
        let mut last = Instant::now();

        // 热身：CPU 占用率第一拍无效
        sys.refresh_cpu_usage();
        std::thread::sleep(Duration::from_millis(300));

        loop {
            let now = Instant::now();
            let dt = now.duration_since(last).as_secs_f64().max(0.05);
            last = now;

            sys.refresh_cpu_usage();
            sys.refresh_memory();
            sys.refresh_processes(ProcessesToUpdate::All, true);

            let cpu = sys.global_cpu_usage() as f64;
            let mem_used = sys.used_memory() as f64;
            let mem_total = sys.total_memory() as f64;

            // 网络速率（KB/s）：按接口差分
            networks.refresh(true);
            let mut down = 0.0f64;
            let mut up = 0.0f64;
            for (name, data) in networks.iter() {
                let rx = data.received();
                let tx = data.transmitted();
                if let Some((prx, ptx)) = prev_net.get(name) {
                    down += rx.saturating_sub(*prx) as f64 / dt / 1024.0;
                    up += tx.saturating_sub(*ptx) as f64 / dt / 1024.0;
                }
                prev_net.insert(name.clone(), (rx, tx));
            }

            // 磁盘占用率 + 读写速率（MB/s）
            disks.refresh(true);
            let mut disk_usage = 0.0f64;
            let mut read_speed = 0.0f64;
            let mut write_speed = 0.0f64;
            for disk in disks.iter() {
                let total = disk.total_space() as f64;
                let available = disk.available_space() as f64;
                if total > 0.0 {
                    let usage = (1.0 - available / total) * 100.0;
                    if usage > disk_usage {
                        disk_usage = usage;
                    }
                }
                let key = disk.name().to_string_lossy().into_owned();
                let rw = disk.usage();
                let rd = rw.total_read_bytes;
                let wr = rw.total_written_bytes;
                if let Some((prd, pwr)) = prev_disk.get(&key) {
                    read_speed += rd.saturating_sub(*prd) as f64 / dt / 1024.0 / 1024.0;
                    write_speed += wr.saturating_sub(*pwr) as f64 / dt / 1024.0 / 1024.0;
                }
                prev_disk.insert(key, (rd, wr));
            }

            // Top 进程（按内存）
            let mut procs: Vec<ProcessInfo> = sys
                .processes()
                .iter()
                .map(|(_, p)| ProcessInfo {
                    name: p.name().to_string_lossy().into_owned(),
                    memory_mb: p.memory() as f64 / 1024.0 / 1024.0,
                })
                .collect();
            procs.sort_by(|a, b| b.memory_mb.partial_cmp(&a.memory_mb).unwrap_or(std::cmp::Ordering::Equal));
            procs.truncate(8);

            let snap = Snapshot {
                cpu_usage: cpu,
                memory_usage: if mem_total > 0.0 {
                    mem_used / mem_total * 100.0
                } else {
                    0.0
                },
                memory_used_gb: mem_used / 1024.0 / 1024.0 / 1024.0,
                memory_total_gb: mem_total / 1024.0 / 1024.0 / 1024.0,
                disk_usage,
                disk_read_speed: read_speed,
                disk_write_speed: write_speed,
                net_download_speed: down,
                net_upload_speed: up,
                gpus: gpu_cache.get(),
                processes: procs,
            };

            let _ = app.emit("snapshot", &snap);
            std::thread::sleep(Duration::from_millis(500));
        }
    });
}
