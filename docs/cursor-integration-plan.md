# Cursor 平台接入计划（分阶段）

## 目标
在保持页面交互体验与现有平台一致的前提下，分阶段完成 Cursor 平台独立接入，最终实现“真实落盘切号 + 完整设置联动 + Tray 联动”。

## 母版选择
- 母版页面：`Kiro`
- 选择原因：`Kiro` 已是“独立 page/store/service + overview/instances 双页签”的结构，最接近 Cursor 目标形态。

## 阶段拆分

### 阶段 1（已落地）：前端迁移骨架
- 新增 `Cursor` 独立文件：
  - `src/types/cursor.ts`
  - `src/services/cursorService.ts`
  - `src/stores/useCursorAccountStore.ts`
  - `src/services/cursorInstanceService.ts`
  - `src/stores/useCursorInstanceStore.ts`
  - `src/components/CursorOverviewTabsHeader.tsx`
  - `src/pages/CursorInstancesPage.tsx`
  - `src/pages/CursorAccountsPage.tsx`
- 路由/导航接入：
  - `src/types/navigation.ts`
  - `src/App.tsx`
  - `src/components/layout/SideNav.tsx`
  - `src/components/platform/PlatformOverviewTabsHeader.tsx`
- i18n 最小三语补齐：
  - `src/locales/zh-CN.json`
  - `src/locales/en-US.json`
  - `src/locales/en.json`

验收标准：
- 侧边栏可进入 Cursor 页面。
- Cursor 页面可在 `账号总览/多开实例` 两个 tab 间切换。
- 页面交互（筛选、搜索、批量、弹窗结构）与 Kiro 保持一致。

### 阶段 2：后端命令与真实数据链路
- 新增 Rust 模块与命令注册：
  - `src-tauri/src/models/cursor.rs`
  - `src-tauri/src/modules/cursor_*.rs`
  - `src-tauri/src/commands/cursor.rs`
  - `src-tauri/src/lib.rs` 命令注册
- 对齐登录流程：
  - OAuth start/complete/cancel
  - token 导入、本地导入、刷新、导出
- 数据模型对齐：账号主键、套餐、配额、raw 快照。

验收标准：
- `cursorService` 所有 invoke 命令可用且返回稳定。
- 新增账号、刷新、导入导出均可执行。

### 阶段 3：真实落盘切号与实例联动
- 实现 `inject_cursor_to_vscode`（或 Cursor 客户端真实落盘切号命令）。
- 按客户端真实存储结构完成读写与二次校验。
- 补齐实例命令（defaults/list/create/update/start/stop/open）。

验收标准：
- 切号后客户端重启仍是目标账号。
- 不是前端状态切换，能够二次读取验证。

### 阶段 4：全局联动收口
- 平台布局系统接入：
  - `src/types/platform.ts`
  - `src/stores/usePlatformLayoutStore.ts`
  - `src/utils/platformMeta.tsx`
- Dashboard 卡片与推荐切号接入：`src/pages/DashboardPage.tsx`
- 设置与快捷设置接入：
  - `src/pages/SettingsPage.tsx`
  - `src/components/QuickSettingsPopover.tsx`
  - `src/hooks/useAutoRefresh.ts`
- Tray 菜单接入：
  - `src-tauri/src/modules/tray.rs`
  - `src-tauri/src/modules/tray_layout.rs`
  - `src/App.tsx` tray:navigate/tray:refresh_quota
- 文档同步：`README.md`、`README.en.md`

验收标准：
- Cursor 在侧边栏、Dashboard、设置、快捷设置、Tray 都可见且行为一致。

## 执行策略
- 每阶段独立可回滚，优先保证“可运行 + 可验证”。
- 先迁页面与交互，再替换底层实现，避免一次性大改导致主线不稳定。
