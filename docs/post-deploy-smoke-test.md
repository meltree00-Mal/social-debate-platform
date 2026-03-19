# 上线后 5 分钟验收脚本（并发覆盖与更新及时性）

适用版本：已包含 `/api/state/mutate` 与 `VITE_ENABLE_SERVER_WRITES` 开关。

## 0. 预检查（30 秒）

1. 在 Vercel 确认本次 Production 部署为 `Ready`。
2. 确认环境变量：
   - `VITE_ENABLE_SERVER_WRITES=true`
   - `SUPABASE_SERVICE_ROLE_KEY` 已配置
3. 在 Supabase SQL Editor 执行过 `supabase/shared_state_v3_hardening.sql`。

## 1. 单人链路冒烟（1 分钟）

1. 访问正式域名并强刷：`/?v=smoke-20260319a`
2. 登录后执行：
   - 发布一个预测
   - 对任一预测投票
   - 撤销该投票
3. 预期：
   - 三个动作都提示成功
   - 刷新后数据仍一致
   - 手机和电脑看到同样状态

## 2. 双端并发压测（2 分钟）

准备：同一账号在两个设备同时打开同一预测详情页（A 端和 B 端）。

### 场景 A：发布并发

1. A 端与 B 端几乎同时发布预测。
2. 预期：
   - 都不会把整个市场列表清空或回退
   - 若发生版本冲突，前端应自动拉取并重试一次
   - 最终列表中应能看到两条新增（或出现一次失败提示但不覆盖已有数据）

### 场景 B：投票并发

1. A 端先投票，B 端在 1 秒内也投票。
2. 预期：
   - 不出现“旧快照覆盖新投票”的现象
   - 两端在 5-10 秒内收敛到一致

### 场景 C：撤销并发

1. A 端撤销投票，B 端几乎同时刷新/再操作。
2. 预期：
   - 余额和票数不出现双扣/双返
   - 页面最终一致

## 3. 数据库观测（1 分钟）

在 Supabase SQL Editor 执行以下查询：

```sql
-- 最近 20 条冲突日志
select id, table_name, attempted_version, user_name, occurred_at
from public.sync_conflict_log
order by id desc
limit 20;
```

```sql
-- 最近 20 条审计日志（若已启用 v3 脚本）
select id, doc_key, mutation_type, expected_version, resulting_version, result, created_at
from public.mutation_audit_log
order by id desc
limit 20;
```

判定：

1. 有少量 `conflict` 正常，说明并发保护在工作。
2. 不应出现持续高频冲突（例如同一操作 10 次里 > 3 次）。
3. 不应出现更新后“数据回退到旧状态”。

## 4. 更新及时性验收（1 分钟）

1. A 端发布/投票后，B 端观察可见时间。
2. 预期：
   - 5 秒内看到变化（当前轮询策略）
   - 弱网下不超过 15 秒
3. 若超时：
   - 先手动刷新确认数据已落库
   - 再检查客户端是否有网络错误、是否命中旧缓存页面

## 5. 失败处置

若发现异常，按顺序排查：

1. `VITE_ENABLE_SERVER_WRITES` 是否已在当前环境打开。
2. `SUPABASE_SERVICE_ROLE_KEY` 是否有效且部署后已生效。
3. `shared_state_v3_hardening.sql` 是否完整执行。
4. Vercel Function 日志是否有 `/api/state/mutate` 报错。

## 6. 回滚开关（紧急）

若出现不可接受的故障，可先临时回滚：

1. 将 `VITE_ENABLE_SERVER_WRITES=false`
2. 重新部署 Production

说明：该回滚只回到旧写入路径，不影响读取页面。
