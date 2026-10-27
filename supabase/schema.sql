-- =====================================================================
--  مقعد · قاعدة البيانات
--  الصقي هذا الملف كامل في Supabase > SQL Editor واضغطي Run (مرة وحدة).
--  كل الأوقات تنحفظ بتوقيت السعودية (Asia/Riyadh).
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- 1) الكوفيهات: كل كوفي سطر واحد، فيه إعداداته
-- ---------------------------------------------------------------------
create table if not exists public.cafes (
  id            uuid primary key default gen_random_uuid(),
  slug          text unique not null check (slug ~ '^[a-z0-9-]{2,40}$'), -- الاسم في الرابط: ?c=faisal
  owner_id      uuid references auth.users(id) on delete set null,       -- حساب صاحب الكوفي
  name          text not null,
  area          text not null default '',
  open_time     time not null default '16:00',
  close_time    time not null default '01:00',                          -- لو أصغر من وقت الفتح = يقفل بعد منتصف الليل
  slot_minutes  int  not null default 30 check (slot_minutes in (15, 30, 60)),
  grace_minutes int  not null default 15 check (grace_minutes between 5 and 60),
  max_group     int  not null default 6  check (max_group between 1 and 50),
  map_url       text not null default '',
  closed_dates  date[] not null default '{}',                           -- ليالي مقفلة للحجز
  types         jsonb not null default '[
     {"id":"in",  "name":"داخلي",     "desc":"الصالة",      "cap":8, "dur":45},
     {"id":"out", "name":"خارجي",     "desc":"جلسات برّا",  "cap":6, "dur":45},
     {"id":"work","name":"منطقة عمل", "desc":"هادئ + فيش",  "cap":4, "dur":90}
  ]'::jsonb,                                                           -- cap = عدد الطاولات، dur = مدة الجلسة بالدقائق (0 = بدون حد)
  logo_url      text not null default '',                               -- شعار المكان: /logos/yaz.png
  accent_color  text not null default '',                               -- لون الهوية: #99312E
  bg_color      text not null default '',                               -- لون الخلفية: #FAECDF
  created_at    timestamptz not null default now()
);
alter table public.cafes add column if not exists logo_url text not null default '';
alter table public.cafes add column if not exists accent_color text not null default '';
alter table public.cafes add column if not exists bg_color text not null default '';

-- ---------------------------------------------------------------------
-- 2) الحجوزات: كل حجز سطر واحد
-- ---------------------------------------------------------------------
create table if not exists public.bookings (
  id            uuid primary key default gen_random_uuid(),
  cafe_id       uuid not null references public.cafes(id) on delete cascade,
  code          text not null,               -- رقم قصير للموظف: S4821
  token         text not null unique,        -- رمز سري طويل للرابط الخاص بالحجز
  night         date not null,               -- "ليلة العمل": حجز ١٢:٣٠ ص يتبع ليلة اليوم اللي قبله
  slot_time     time not null,               -- الوقت كما اختاره العميل
  start_at      timestamptz not null,        -- بداية الجلسة الفعلية (تاريخ + وقت)
  end_at        timestamptz not null,        -- نهاية الجلسة (تتغير لو مدد الكوفي)
  type_id       text not null,
  people        int  not null check (people between 1 and 50),
  name          text not null,
  phone         text,
  dur_minutes   int  not null,
  extra_minutes int  not null default 0,
  status        text not null default 'booked'
                check (status in ('booked','arrived','done','noshow','cancelled')),
  source        text not null default 'link' check (source in ('link','manual')),
  created_at    timestamptz not null default now(),
  status_at     timestamptz
);
create index if not exists bookings_cafe_night on public.bookings (cafe_id, night);
create index if not exists bookings_cafe_phone on public.bookings (cafe_id, phone);
create index if not exists bookings_cafe_code  on public.bookings (cafe_id, code);

-- ---------------------------------------------------------------------
-- 3) الحماية (RLS): العميل ما يقدر يقرأ جدول الحجوزات مباشرة.
--    كل شي يمر عبر الدوال تحت، وصاحب الكوفي يشوف حجوزات كوفيه فقط.
-- ---------------------------------------------------------------------
alter table public.cafes    enable row level security;
alter table public.bookings enable row level security;

drop policy if exists cafes_public_read  on public.cafes;
drop policy if exists cafes_owner_update on public.cafes;
create policy cafes_public_read  on public.cafes for select using (true);
create policy cafes_owner_update on public.cafes for update
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists bookings_owner_read on public.bookings;
create policy bookings_owner_read on public.bookings for select
  using (exists (select 1 from public.cafes c where c.id = cafe_id and c.owner_id = auth.uid()));

-- ---------------------------------------------------------------------
-- 4) دوال مساعدة للوقت
-- ---------------------------------------------------------------------
-- ليلة العمل الحالية (لو الكوفي يقفل ١ ص، الساعة ١٢:٣٠ ص تتبع أمس)
create or replace function public._tonight(c public.cafes) returns date
language sql stable as $$
  select ((now() at time zone 'Asia/Riyadh')
          - case when c.close_time <= c.open_time then c.close_time - time '00:00' else interval '0' end)::date
$$;

-- بداية ونهاية جلسة لوقت معيّن
create or replace function public._window(c public.cafes, p_night date, p_time time, p_dur int,
                                         out w_start timestamptz, out w_end timestamptz)
language plpgsql stable as $$
declare v_close timestamptz;
begin
  w_start := (p_night + p_time) at time zone 'Asia/Riyadh';
  if p_time < c.open_time then w_start := w_start + interval '1 day'; end if;
  v_close := (p_night + c.close_time) at time zone 'Asia/Riyadh';
  if c.close_time <= c.open_time then v_close := v_close + interval '1 day'; end if;
  w_end := case when p_dur > 0 then w_start + make_interval(mins => p_dur) else v_close end;
end $$;

-- هل الوقت من خانات الكوفي؟ (من الفتح، كل slot دقيقة، وآخر خانة قبل القفل بساعة)
create or replace function public._valid_slot(c public.cafes, p_time time) returns boolean
language plpgsql immutable as $$
declare
  v_rel  int := ((extract(epoch from (p_time - c.open_time))::int / 60) + 1440) % 1440;
  v_span int := ((extract(epoch from (c.close_time - c.open_time))::int / 60) + 1440) % 1440;
begin
  if v_span = 0 then v_span := 1440; end if;
  return v_rel % c.slot_minutes = 0 and v_rel <= v_span - 60;
end $$;

-- ---------------------------------------------------------------------
-- 5) الدوال العامة (يستخدمها العميل بدون تسجيل دخول)
-- ---------------------------------------------------------------------

-- الأوقات المشغولة (بدون أسماء ولا أرقام) عشان الصفحة تحسب المتاح
create or replace function public.get_availability(p_slug text, p_from date, p_to date)
returns table (night date, type_id text, start_at timestamptz, end_at timestamptz)
language sql stable security definer set search_path = public as $$
  select b.night, b.type_id, b.start_at, b.end_at
  from bookings b join cafes c on c.id = b.cafe_id
  where c.slug = p_slug and b.night between p_from - 1 and p_to
    and b.status in ('booked','arrived')
$$;

-- إنشاء حجز: يقفل الخانة لحظياً، يعيد العد، ثم يحفظ
create or replace function public.create_booking(
  p_slug text, p_night date, p_time time, p_type text, p_people int, p_name text, p_phone text)
returns json
language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  c        cafes;
  t        jsonb;
  is_owner boolean;
  v_phone  text := nullif(regexp_replace(coalesce(p_phone,''), '\D', '', 'g'), '');
  v_start  timestamptz; v_end timestamptz;
  v_taken  int; v_code text; v_token text;
begin
  select * into c from cafes where slug = p_slug;
  if not found then raise exception 'NOT_FOUND'; end if;
  is_owner := coalesce(c.owner_id = auth.uid(), false);   -- coalesce مهم: بدون دخول تكون القيمة null

  select x into t from jsonb_array_elements(c.types) x where x->>'id' = p_type;
  if t is null or (t->>'cap')::int <= 0 then raise exception 'BAD_TYPE'; end if;

  if v_phone like '966%' then v_phone := '0' || substr(v_phone, 4); end if;
  if length(trim(coalesce(p_name,''))) not between 2 and 60 then raise exception 'BAD_NAME'; end if;
  if not is_owner and (v_phone is null or v_phone !~ '^05[0-9]{8}$') then raise exception 'BAD_PHONE'; end if;
  if p_people < 1 or p_people > (case when is_owner then 50 else c.max_group end) then raise exception 'BAD_PEOPLE'; end if;
  if not public._valid_slot(c, p_time) then raise exception 'BAD_TIME'; end if;
  if not is_owner and (p_night = any(c.closed_dates)) then raise exception 'CLOSED'; end if;
  if not is_owner and (p_night < public._tonight(c) or p_night > public._tonight(c) + 6) then raise exception 'BAD_DATE'; end if;

  select w_start, w_end into v_start, v_end from public._window(c, p_night, p_time, (t->>'dur')::int);
  v_taken := case when is_owner then -30 else 10 end;   -- العميل: قبل الموعد بـ ١٠ دقائق على الأقل
  if v_start < now() + make_interval(mins => v_taken) then raise exception 'PAST'; end if;

  -- قفل لحظي: طلبين على نفس الكوفي ونفس النوع ونفس الليلة ينتظرون بعض
  perform pg_advisory_xact_lock(hashtext(c.id::text || p_night::text || p_type));

  select count(*) into v_taken from bookings b
  where b.cafe_id = c.id and b.type_id = p_type and b.status in ('booked','arrived')
    and b.night between p_night - 1 and p_night + 1
    and b.start_at < v_end and v_start < b.end_at;
  if v_taken >= (t->>'cap')::int then raise exception 'FULL'; end if;

  if not is_owner and (select count(*) from bookings b
      where b.cafe_id = c.id and b.phone = v_phone and b.status = 'booked' and b.end_at > now()) >= 3 then
    raise exception 'TOO_MANY';
  end if;

  loop
    v_code := 'S' || (1000 + floor(random() * 9000))::int;
    exit when not exists (select 1 from bookings b where b.cafe_id = c.id and b.code = v_code
                          and b.night >= public._tonight(c) - 1);
  end loop;
  v_token := encode(gen_random_bytes(12), 'hex');

  insert into bookings (cafe_id, code, token, night, slot_time, start_at, end_at, type_id, people,
                        name, phone, dur_minutes, source)
  values (c.id, v_code, v_token, p_night, p_time, v_start, v_end, p_type, p_people,
          trim(p_name), v_phone, (t->>'dur')::int, case when is_owner then 'manual' else 'link' end);

  return json_build_object('token', v_token, 'code', v_code);
end $$;

-- صفحة الحجز الخاصة (بالرمز السري في الرابط)
create or replace function public.get_booking(p_token text)
returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'token', b.token, 'code', b.code, 'night', b.night, 'slot_time', to_char(b.slot_time,'HH24:MI'),
    'start_at', b.start_at, 'end_at', b.end_at, 'type_id', b.type_id, 'people', b.people,
    'name', b.name, 'phone', case when b.phone is null then null
                                  else substr(b.phone,1,3) || '•••' || right(b.phone,3) end,
    'dur_minutes', b.dur_minutes, 'extra_minutes', b.extra_minutes, 'status', b.status,
    'cafe_slug', c.slug)
  from bookings b join cafes c on c.id = b.cafe_id
  where b.token = p_token
$$;

-- "حجزي": البحث برقم الجوال أو رقم الحجز
create or replace function public.find_bookings(p_slug text, p_query text)
returns setof json
language plpgsql stable security definer set search_path = public as $$
declare
  c cafes;
  q text := upper(regexp_replace(coalesce(p_query,''), '[\s-]', '', 'g'));
begin
  select * into c from cafes where slug = p_slug;
  if not found then return; end if;
  if q ~ '^S?[0-9]{4}$' then
    if q !~ '^S' then q := 'S' || q; end if;
    return query
      select json_build_object('token',b.token,'code',b.code,'night',b.night,'slot_time',to_char(b.slot_time,'HH24:MI'),
                               'type_id',b.type_id,'people',b.people,'status',b.status,'start_at',b.start_at)
      from bookings b where b.cafe_id = c.id and b.code = q and b.night >= public._tonight(c) - 1
      order by b.start_at;
  else
    q := regexp_replace(q, '\D', '', 'g');
    if q like '966%' then q := '0' || substr(q, 4); end if;
    if q !~ '^05[0-9]{8}$' then return; end if;
    return query
      select json_build_object('token',b.token,'code',b.code,'night',b.night,'slot_time',to_char(b.slot_time,'HH24:MI'),
                               'type_id',b.type_id,'people',b.people,'status',b.status,'start_at',b.start_at)
      from bookings b where b.cafe_id = c.id and b.phone = q
      order by b.start_at desc limit 10;
  end if;
end $$;

-- إلغاء من العميل (مسموح لين تنتهي مهلة التأخير)
create or replace function public.cancel_booking(p_token text)
returns boolean
language plpgsql volatile security definer set search_path = public as $$
declare n int;
begin
  update bookings b set status = 'cancelled', status_at = now()
  from cafes c
  where c.id = b.cafe_id and b.token = p_token and b.status = 'booked'
    and now() < b.start_at + make_interval(mins => c.grace_minutes);
  get diagnostics n = row_count;
  return n > 0;
end $$;

-- ---------------------------------------------------------------------
-- 6) دوال صاحب الكوفي (لازم يكون مسجل دخول)
-- ---------------------------------------------------------------------
create or replace function public.set_status(p_token text, p_status text)
returns boolean
language plpgsql volatile security definer set search_path = public as $$
declare n int;
begin
  if p_status not in ('booked','arrived','done','noshow','cancelled') then raise exception 'BAD_STATUS'; end if;
  update bookings b set status = p_status, status_at = now()
  from cafes c
  where c.id = b.cafe_id and b.token = p_token and c.owner_id = auth.uid();
  get diagnostics n = row_count;
  return n > 0;
end $$;

-- تمديد جلسة: يرجّع كم حجز يتعارض بعد التمديد (عشان الكوفي ينتبه)
create or replace function public.extend_booking(p_token text, p_minutes int)
returns int
language plpgsql volatile security definer set search_path = public as $$
declare b bookings; v_cap int; v_over int;
begin
  if p_minutes not between 5 and 120 then raise exception 'BAD_MINUTES'; end if;
  update bookings x set extra_minutes = x.extra_minutes + p_minutes,
                        end_at = x.end_at + make_interval(mins => p_minutes)
  from cafes c
  where c.id = x.cafe_id and x.token = p_token and c.owner_id = auth.uid()
  returning x.* into b;
  if b.id is null then raise exception 'NOT_ALLOWED'; end if;
  select (t->>'cap')::int into v_cap from cafes c, jsonb_array_elements(c.types) t
   where c.id = b.cafe_id and t->>'id' = b.type_id;
  select count(*) into v_over from bookings o
   where o.cafe_id = b.cafe_id and o.type_id = b.type_id and o.status in ('booked','arrived')
     and o.start_at < b.end_at and b.start_at < o.end_at;
  return greatest(v_over - v_cap, 0);
end $$;

-- ---------------------------------------------------------------------
-- 7) الصلاحيات
-- ---------------------------------------------------------------------
revoke all on function public.create_booking(text,date,time,text,int,text,text) from public;
revoke all on function public.set_status(text,text) from public;
revoke all on function public.extend_booking(text,int) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    -- صلاحيات الجداول صريحة (تشتغل حتى لو "Automatically expose new tables" مقفل). قواعد RLS فوق هي اللي تحدد الأسطر.
    grant usage on schema public to anon, authenticated;
    grant select on public.cafes to anon, authenticated;
    grant update on public.cafes to authenticated;
    grant select on public.bookings to authenticated;
    grant execute on function public.get_availability(text,date,date)                     to anon, authenticated;
    grant execute on function public.create_booking(text,date,time,text,int,text,text)    to anon, authenticated;
    grant execute on function public.get_booking(text)                                    to anon, authenticated;
    grant execute on function public.find_bookings(text,text)                             to anon, authenticated;
    grant execute on function public.cancel_booking(text)                                 to anon, authenticated;
    grant execute on function public.set_status(text,text)                                to authenticated;
    grant execute on function public.extend_booking(text,int)                             to authenticated;
  end if;
end $$;

-- تحديث مباشر للوحة الكوفي (Realtime)
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.bookings;
    exception when duplicate_object then null;
    end;
  end if;
end $$;
