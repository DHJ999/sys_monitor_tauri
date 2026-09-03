use std::collections::HashMap;
use std::time::Duration;

use windows::core::PCWSTR;
use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1};
use windows::Win32::System::Performance::{
    PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData, PdhGetFormattedCounterArrayW,
    PdhOpenQueryW, PDH_FMT, PDH_FMT_COUNTERVALUE_ITEM_W, PDH_FMT_DOUBLE,
};

use crate::monitor::GpuInfo;

/// GPU 采集：DXGI 枚举适配器（名称/显存总量）+ PDH 性能计数器（利用率/已用显存）
/// PDH 计数器路径用英文（PdhAddEnglishCounterW），中文系统同样有效。
/// 所有解析都是防御式的：任何一步出错只影响对应字段，不 panic。

fn luid_key(high: i32, low: u32) -> u64 {
    // 先 reinterpret 成 u32 再拼位：避免负的 HighPart 经 `as u64` 时符号扩展，
    // 把高 32 位填成 0xFFFFFFFF，虽然当前两处调用结果一致，但改为位保真更稳妥。
    (((high as u32) as u64) << 32) | (low as u64)
}

/// 枚举物理显卡（过滤 WARP 软件适配器），返回 (luid_key, 名称, 显存总量MB)
fn enum_adapters() -> Vec<(u64, String, f64)> {
    let mut out = Vec::new();
    unsafe {
        if let Ok(factory) = CreateDXGIFactory1::<IDXGIFactory1>() {
            let mut index: u32 = 0;
            loop {
                match factory.EnumAdapters1(index) {
                    Ok(adapter) => {
                        let desc = match adapter.GetDesc1() {
                            Ok(d) => d,
                            Err(_) => {
                                index += 1;
                                continue;
                            }
                        };
                        let name = String::from_utf16_lossy(&desc.Description)
                            .trim_end_matches('\0')
                            .to_string();
                        let mem_mb = desc.DedicatedVideoMemory as f64 / 1024.0 / 1024.0;
                        let is_warp = desc.VendorId == 0x1414; // Microsoft 基本显示适配器
                        if !is_warp {
                            let key = luid_key(desc.AdapterLuid.HighPart, desc.AdapterLuid.LowPart);
                            out.push((key, name, mem_mb));
                        }
                        index += 1;
                    }
                    Err(_) => break,
                }
            }
        }
    }
    out
}

/// PDH 通用读取：先查所需缓冲区大小与元素个数，再按元素个数分配（避免越界写入，也避免按字节数分配造成的几十倍浪费）
fn pdh_read_array(counter: isize, format: PDH_FMT) -> Vec<PDH_FMT_COUNTERVALUE_ITEM_W> {
    let mut size: u32 = 0;
    let mut count: u32 = 0;
    unsafe {
        // 传入空缓冲区时返回 PDH_MORE_DATA，同时回填 size（字节数）与 count（元素个数）
        PdhGetFormattedCounterArrayW(counter, format, &mut size, &mut count, None);
    }
    if size == 0 || count == 0 {
        return Vec::new();
    }
    let elem = std::mem::size_of::<PDH_FMT_COUNTERVALUE_ITEM_W>();
    // size 是字节数，换算成元素个数；与 count 取较大者，保证缓冲区足够
    let capacity = ((size as usize + elem - 1) / elem).max(count as usize);
    let mut items: Vec<PDH_FMT_COUNTERVALUE_ITEM_W> =
        vec![PDH_FMT_COUNTERVALUE_ITEM_W::default(); capacity];
    let mut size2: u32 = (capacity * elem) as u32;
    let mut count2: u32 = 0;
    let status = unsafe {
        PdhGetFormattedCounterArrayW(
            counter,
            format,
            &mut size2,
            &mut count2,
            Some(items.as_mut_ptr()),
        )
    };
    if status != 0 {
        return Vec::new();
    }
    // 只保留实际写入的元素，长度不会超过已分配的容量
    items.truncate((count2 as usize).min(capacity));
    items
}

/// PDH 查询：GPU Engine 利用率 %（按 LUID 汇总）
fn pdh_utilization() -> HashMap<u64, f64> {
    let mut map = HashMap::new();
    unsafe {
        let mut query: isize = 0;
        if PdhOpenQueryW(PCWSTR::null(), 0, &mut query) != 0 {
            return map;
        }
        let mut counter: isize = 0;
        let path = windows::core::w!("\\GPU Engine(*)\\Utilization Percentage");
        if PdhAddEnglishCounterW(query, PCWSTR(path.as_ptr()), 0, &mut counter) != 0 {
            PdhCloseQuery(query);
            return map;
        }
        // 双拍热身（第一次读数无效）
        PdhCollectQueryData(query);
        std::thread::sleep(Duration::from_millis(150));
        PdhCollectQueryData(query);

        // GPU Engine 的实例是「进程 × 引擎」维度：同一个引擎（如 3D）会被多个进程同时使用，
        // 直接把所有实例相加会得出几百的数值，被 clamp 后长期显示 100%，失去参考价值。
        // 正确做法：同一块 GPU 的同一种引擎类型内取各进程的最大值，再跨引擎类型求和。
        let mut grouped: HashMap<u64, HashMap<String, f64>> = HashMap::new();
        for item in pdh_read_array(counter, PDH_FMT_DOUBLE) {
            if item.FmtValue.CStatus != 0 {
                continue;
            }
            let name = item.szName.to_string().unwrap_or_default();
            let Some(key) = parse_engine_luid(&name) else {
                continue;
            };
            let v = item.FmtValue.Anonymous.doubleValue;
            if !v.is_finite() || v <= 0.0 {
                continue;
            }
            let engines = grouped.entry(key).or_default();
            let slot = engines.entry(parse_engtype(&name)).or_insert(0.0);
            if v > *slot {
                *slot = v;
            }
        }
        for (key, engines) in grouped {
            map.insert(key, engines.values().sum::<f64>());
        }
        PdhCloseQuery(query);
    }
    map
}

/// 解析 16 进制字段：实例名里的 LUID 段带 "0x" 前缀（如 luid_0x00000000_0x0001212D），
/// 而 u32::from_str_radix 不接受 "0x" 前缀，必须先剥掉，否则解析失败 → GPU 数据恒为 0
fn parse_hex_u32(s: &str) -> Option<u32> {
    let t = s.trim();
    let t = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")).unwrap_or(t);
    if t.is_empty() {
        return None;
    }
    u32::from_str_radix(t, 16).ok()
}

/// 从 "pid_xxx_luid_0xAAAAAAAA_0xBBBBBBBB_phys_0_eng_0_engtype_3D" 提取 LUID（防御式，绝不 panic）
fn parse_engine_luid(name: &str) -> Option<u64> {
    let idx = name.find("luid_")? + 5;
    if idx >= name.len() {
        return None;
    }
    let rest = &name[idx..];
    let mut parts = rest.split('_');
    let high = parse_hex_u32(parts.next()?)?;
    let low = parse_hex_u32(parts.next()?)?;
    Some(luid_key(high as i32, low))
}

/// 提取引擎类型（engtype_3D / engtype_Copy / ...），缺失时归为 "other"
fn parse_engtype(name: &str) -> String {
    match name.find("engtype_") {
        Some(i) => {
            let rest = &name[i + "engtype_".len()..];
            let t = rest.split('_').next().unwrap_or("").trim();
            if t.is_empty() {
                "other".to_string()
            } else {
                t.to_string()
            }
        }
        None => "other".to_string(),
    }
}

/// PDH 查询：GPU 已用显存 MB（按适配器名称）
fn pdh_used_memory() -> HashMap<String, f64> {
    let mut map = HashMap::new();
    unsafe {
        let mut query: isize = 0;
        if PdhOpenQueryW(PCWSTR::null(), 0, &mut query) != 0 {
            return map;
        }
        let mut counter: isize = 0;
        let path = windows::core::w!("\\GPU Adapter Memory(*)\\Dedicated Usage");
        if PdhAddEnglishCounterW(query, PCWSTR(path.as_ptr()), 0, &mut counter) != 0 {
            PdhCloseQuery(query);
            return map;
        }
        PdhCollectQueryData(query);
        std::thread::sleep(Duration::from_millis(150));
        PdhCollectQueryData(query);

        for item in pdh_read_array(
            counter,
            windows::Win32::System::Performance::PDH_FMT_LARGE,
        ) {
            if item.FmtValue.CStatus == 0 {
                let name = item.szName.to_string().unwrap_or_default();
                let bytes = item.FmtValue.Anonymous.largeValue;
                if bytes > 0 {
                    map.insert(name.trim().to_string(), bytes as f64 / 1024.0 / 1024.0);
                }
            }
        }
        PdhCloseQuery(query);
    }
    map
}

/// 汇总一次 GPU 快照（容错：任何一步失败只影响对应字段，不 panic）
pub fn collect_gpus() -> Vec<GpuInfo> {
    let adapters = enum_adapters();
    if adapters.is_empty() {
        return Vec::new();
    }
    let util = pdh_utilization();
    let used = pdh_used_memory();

    adapters
        .into_iter()
        .enumerate()
        .map(|(idx, (key, name, mem_total))| {
            let mem_used_mb = used.get(&name).copied().unwrap_or(0.0);
            GpuInfo {
                index: idx,
                name,
                util_pct: util.get(&key).copied().unwrap_or(0.0).min(100.0),
                mem_used_mb,
                mem_total_mb: mem_total,
            }
        })
        .collect()
}
