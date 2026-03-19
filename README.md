# CPA 学习助手（静态网页版）

## 本地运行

```bash
python -m http.server 5173
```

浏览器访问 `http://localhost:5173/`。

## Supabase 配置位置（不使用环境变量）

只需要改一个文件：

- `src/config/supabase.js`
  - `SUPABASE_URL`
  - `SUPABASE_ANON_KEY`

## 云端同步说明

- 数据表：默认使用 `app_state`（按 `user_id` 一行存整份应用状态 JSON）。
- 机制：
  - 登录后：先对比本地/云端版本（`state.cloudMeta`），选择更新的一份，并在需要时自动回写云端
  - 同步：实时订阅（`postgres_changes`）触发拉取 + 30 秒轮询兜底
  - 切屏/回前台：会主动尝试重连并恢复订阅
  - 登出：会清空当前网页的用户数据（localStorage 中以 `cpaStudyAssistant.v1` 为前缀的键）并取消订阅

> 如果你希望按文档的 `user_data` 表结构落地，也可以把表名从 `app_state` 换成 `user_data`（同时调整字段名）；当前实现优先兼容项目现有表。

