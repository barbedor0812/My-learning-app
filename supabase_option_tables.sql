-- CPA 学习助手：可选 Supabase 表（执行后计时记录会双写到 study_sessions，登录时自动合并）
-- 主数据仍在 public.app_state(JSON)；未执行本文件不影响现有功能。

create table if not exists public.study_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  duration_seconds integer not null check (duration_seconds >= 0),
  session_date date not null,
  created_at timestamptz not null default now()
);

create index if not exists study_sessions_user_date on public.study_sessions (user_id, session_date desc);

alter table public.study_sessions enable row level security;

create policy "study_sessions_select_own"
  on public.study_sessions for select
  using (auth.uid() = user_id);

create policy "study_sessions_insert_own"
  on public.study_sessions for insert
  with check (auth.uid() = user_id);

-- 若需按文档拆分文件夹/文件，可自行扩展 folders、notes 等表并改前端；当前文件夹与笔记关系保存在 app_state 内。
