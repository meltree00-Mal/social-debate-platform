# 数据一致性与实时更新改造方案（可执行版）

## 目标

- 避免旧缓存或并发写入导致的数据覆盖。
- 将“更新不及时”从轮询为主升级为“实时推送 + 轮询兜底”。
- 在不大改现有前端结构的前提下，分阶段上线。

## 当前风险点（基于现状）

- 客户端直接写 `shared_*` 文档，多个客户端并发时仍可能在重试链路中产生“后写覆盖先写”。
- 目前是整文档写入（`payload`），冲突粒度较粗。
- 刷新可见性主要依赖轮询，移动端在弱网和后台恢复时会更慢。

## 分阶段实施

### Phase A：止血（1-2天）

1. 写入统一收口到服务端 API（Vercel Functions）。
2. 前端只读 Supabase；写操作调用服务端。
3. 写请求必须携带：
   - `doc`: users/markets/secrets/feedbacks/settings
   - `expectedVersion`
   - `requestId`（幂等键，uuid）
   - `patch`（本次变更，禁止整包覆盖）
4. 服务端：版本不匹配返回 `409`，并回传 `currentVersion`。
5. 前端：收到 `409` -> 先拉最新 -> 自动重试 1 次 -> 仍失败提示手动重试。

### Phase B：提速（2-4天）

1. 加 Supabase Realtime 订阅 `shared_*` 表的 `updated_at/version`。
2. 实时事件到达后局部刷新该文档；轮询降为 15-30 秒兜底。
3. 页面显示同步状态：
   - `同步中`
   - `已同步（HH:mm:ss）`
   - `冲突，已自动重试`

### Phase C：稳态（1-2周）

1. 热点域（markets/votes/credits）逐步实体化为行级表。
2. 关键交易（投票扣费/返还/结算）改为事务化 RPC。
3. 保留 `shared_*` 作为聚合缓存，异步更新。

## 服务端 API 契约（建议）

### 1) 写入接口

- `POST /api/state/mutate`

请求体：

```json
{
  "doc": "markets",
  "expectedVersion": 12,
  "requestId": "2e14f8d4-21a1-4552-b0c3-4cf21245f5ad",
  "mutationType": "append_vote",
  "payload": {
    "marketId": 1710812345678,
    "user": "Stan",
    "outcome": "yes",
    "amount": 10,
    "createdAt": 1710812355000
  }
}
```

返回：

- `200`: `{ "ok": true, "version": 13, "updatedAt": "..." }`
- `409`: `{ "ok": false, "code": "VERSION_CONFLICT", "currentVersion": 13 }`
- `202`: `{ "ok": true, "duplicate": true }`（幂等重复）

### 2) 拉取接口

- `GET /api/state/snapshot?docs=users,markets,secrets,feedbacks,settings`

返回每个文档的 `payload/version/updated_at`。

## 前端改造点（按你当前 App 结构）

1. 只保留前端 `pullSharedState` 读取逻辑。
2. 将 `persistSharedState` 改为调用 `/api/state/mutate`：
   - 发布预测
   - 发布秘密
   - 投票/撤销
   - 结算
   - 管理员公告
3. 每次写入生成 `requestId` 并带上。
4. 冲突处理统一函数：
   - 409 -> pull -> retry once。
5. 新增 `syncBadge` UI 状态。

## 幂等与审计

- 新增 `request_dedupe` 表：按 `(request_id, doc)` 去重，TTL 7-30 天。
- 新增 `mutation_audit_log` 表：记录用户、mutation_type、结果、耗时。

## Vercel 部署方案

### 环境变量

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`（仅服务端）
- `ENABLE_SERVER_WRITES=true`
- `ENABLE_REALTIME_SUBSCRIBE=true`

### 灰度发布

1. 第1天：`ENABLE_SERVER_WRITES=false`（仅部署代码，不生效）
2. 第2天：开启 10% 写操作走服务端（按用户 hash 分流）
3. 第3天：50%
4. 第4天：100%

## 回滚策略

1. 一键切回：`ENABLE_SERVER_WRITES=false`
2. 保留旧轮询读取，不影响查看。
3. 服务端函数可保留不删，避免二次发布风险。

## 监控指标（必须）

- 写成功率（按 mutation_type）
- 409 冲突率
- 409 自动恢复率
- 写入 P95 延迟
- 实时推送到达延迟（写入到客户端可见）
- 前端“落后于服务器 >30s”用户占比

## 验收用例

1. 双客户端同时投同一 market：不出现整包覆盖。
2. 手机后台 5 分钟恢复：10 秒内可见最新结果。
3. 连续重复点击提交（网络抖动）：仅产生一条有效写。
4. 管理员修改公告与用户发帖并发：互不丢失。

## 建议先做的最小闭环（本周）

1. 先改 `publishMarket`、`buyShare`、`revokeVoteChoice` 三条写链路。
2. 上线 `requestId + expectedVersion + 409 重试一次`。
3. 添加同步状态徽标。
4. 观测 48 小时后再扩到 secrets/feedbacks/settings。
