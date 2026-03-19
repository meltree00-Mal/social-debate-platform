# ClubHouse手搓小工具

一个基于 React + Vite 的轻量原型，包含预测、秘密、积分、用户管理与简单社区互动机制。

## 本地开发

1. 安装依赖：`npm install`
2. 启动开发环境：`npm run dev`
3. 在浏览器打开 `http://localhost:5173`

## 生产构建

执行：`npm run build`

构建产物输出到 `dist/`。

## Vercel 部署

项目已经添加了 `vercel.json`，可直接用于 Vercel 部署。

### 方法一：通过 GitHub 导入

1. 将当前项目推送到 GitHub 仓库
2. 登录 Vercel
3. 点击 `New Project`
4. 选择你的 GitHub 仓库并导入
5. 保持默认设置，或确认以下内容：
	- Build Command: `npm run build`
	- Output Directory: `dist`
6. 点击 `Deploy`

### 方法二：使用 Vercel CLI

1. 全局安装：`npm install -g vercel`
2. 在项目根目录执行：`vercel`
3. 首次部署按提示选择：
	- Project root: 当前目录
	- Framework: Vite
	- Build command: `npm run build`
	- Output directory: `dist`
4. 若要正式发布生产版本，执行：`vercel --prod`

## Supabase 共享数据同步（防覆盖版）

当前前端已升级为分表同步策略，包含：

1. 分表存储：`shared_users`、`shared_markets`、`shared_secrets`、`shared_feedbacks`、`shared_settings`
2. 乐观锁：每表使用 `version` 字段进行版本递增写入
3. 空快照保护：拒绝把“全空集合快照”覆盖到已有数据

首次启用请在 Supabase SQL Editor 执行：

`supabase/shared_state_v2.sql`

然后在环境变量中配置：

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

## 当前版本的重要限制

当前版本的数据存储基于浏览器 `localStorage`，这意味着：

1. 每个访问者只能看到自己浏览器里的本地数据
2. 不同用户之间不会共享账号、预测、秘密、积分和管理操作
3. 清除浏览器缓存后，本地数据可能消失

如果你想让外部测试者访问同一个线上环境并共享数据，下一步需要接入后端和数据库，例如 Supabase。
