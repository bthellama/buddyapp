-- BuddyApp – Datenbank-Schema für Supabase
-- Einmalig im Supabase-Dashboard unter "SQL Editor" einfügen und ausführen.

-- ---------- Tabellen ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 40),
  dog_name text check (char_length(dog_name) <= 40),
  created_at timestamptz not null default now()
);

create table if not exists public.groups (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 60),
  invite_code text not null unique default upper(substr(md5(random()::text), 1, 6)),
  created_by uuid references auth.users on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);

create table if not exists public.group_members (
  group_id uuid not null references public.groups on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);

create table if not exists public.habits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade default auth.uid(),
  name text not null check (char_length(name) between 1 and 60),
  per_week int not null default 5 check (per_week between 1 and 7),
  minutes int check (minutes between 1 and 120),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Ein Eintrag pro Habit und Tag (bewusst: Regelmässigkeit statt Menge)
create table if not exists public.logs (
  id uuid primary key default gen_random_uuid(),
  habit_id uuid not null references public.habits on delete cascade,
  user_id uuid not null references auth.users on delete cascade default auth.uid(),
  day date not null,
  created_at timestamptz not null default now(),
  unique (habit_id, day)
);

-- Max. ein Stupser pro Habit und Tag
create table if not exists public.nudges (
  id uuid primary key default gen_random_uuid(),
  from_user uuid not null references auth.users on delete cascade default auth.uid(),
  to_user uuid not null references auth.users on delete cascade,
  habit_id uuid not null references public.habits on delete cascade,
  message text not null check (char_length(message) <= 200),
  day date not null,
  seen boolean not null default false,
  created_at timestamptz not null default now(),
  unique (from_user, habit_id, day)
);

-- ---------- Hilfsfunktionen ----------
create or replace function public.is_member(g uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select exists (select 1 from group_members where group_id = g and user_id = auth.uid());
$$;

create or replace function public.is_buddy(other uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select other = auth.uid() or exists (
    select 1 from group_members a
    join group_members b on a.group_id = b.group_id
    where a.user_id = auth.uid() and b.user_id = other);
$$;

create or replace function public.create_group(group_name text) returns public.groups
language plpgsql security definer set search_path = public as $$
declare g groups;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  insert into groups (name, created_by) values (group_name, auth.uid()) returning * into g;
  insert into group_members (group_id, user_id) values (g.id, auth.uid());
  return g;
end $$;

create or replace function public.join_group(code text) returns public.groups
language plpgsql security definer set search_path = public as $$
declare g groups;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  select * into g from groups where invite_code = upper(trim(code));
  if g.id is null then raise exception 'Einladungscode nicht gefunden'; end if;
  insert into group_members (group_id, user_id) values (g.id, auth.uid()) on conflict do nothing;
  return g;
end $$;

revoke execute on function public.is_member(uuid), public.is_buddy(uuid),
  public.create_group(text), public.join_group(text) from public, anon;
grant execute on function public.is_member(uuid), public.is_buddy(uuid),
  public.create_group(text), public.join_group(text) to authenticated;

-- ---------- Zugriffsregeln (Row Level Security) ----------
alter table public.profiles enable row level security;
alter table public.groups enable row level security;
alter table public.group_members enable row level security;
alter table public.habits enable row level security;
alter table public.logs enable row level security;
alter table public.nudges enable row level security;

grant select, insert, update, delete on public.profiles, public.groups, public.group_members,
  public.habits, public.logs, public.nudges to authenticated;

create policy "profiles read" on public.profiles for select to authenticated using (public.is_buddy(id));
create policy "profiles insert" on public.profiles for insert to authenticated with check (id = auth.uid());
create policy "profiles update" on public.profiles for update to authenticated using (id = auth.uid());

create policy "groups read" on public.groups for select to authenticated using (public.is_member(id));

create policy "members read" on public.group_members for select to authenticated using (public.is_member(group_id));
create policy "members leave" on public.group_members for delete to authenticated using (user_id = auth.uid());

create policy "habits read" on public.habits for select to authenticated using (public.is_buddy(user_id));
create policy "habits insert" on public.habits for insert to authenticated with check (user_id = auth.uid());
create policy "habits update" on public.habits for update to authenticated using (user_id = auth.uid());
create policy "habits delete" on public.habits for delete to authenticated using (user_id = auth.uid());

create policy "logs read" on public.logs for select to authenticated using (public.is_buddy(user_id));
create policy "logs insert" on public.logs for insert to authenticated
  with check (user_id = auth.uid() and exists (select 1 from public.habits h where h.id = habit_id and h.user_id = auth.uid()));
create policy "logs delete" on public.logs for delete to authenticated using (user_id = auth.uid());

create policy "nudges read" on public.nudges for select to authenticated using (from_user = auth.uid() or to_user = auth.uid());
create policy "nudges send" on public.nudges for insert to authenticated
  with check (from_user = auth.uid() and to_user <> auth.uid() and public.is_buddy(to_user)
    and exists (select 1 from public.habits h where h.id = habit_id and h.user_id = to_user));
create policy "nudges seen" on public.nudges for update to authenticated using (to_user = auth.uid());

-- ---------- Live-Aktualisierung ----------
alter publication supabase_realtime add table public.logs, public.nudges;
