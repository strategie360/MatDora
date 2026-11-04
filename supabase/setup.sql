-- MatDora : tables et droits pour le diaporama.
-- À coller dans Supabase → SQL Editor → Run. Le relancer en entier est sans risque :
-- rien n'est effacé, les droits sont simplement remis à jour.
--
-- Sécurité :
--   - Dashboard : seuls les comptes listés dans la table "admins" (connectés avec
--     identifiant + mot de passe) peuvent modifier les données.
--   - Site (écran TV) : lecture seulement avec le code du site, réglé dans le dashboard.
--     Tant qu'aucun code n'est réglé, la lecture reste ouverte.
--   - Les fichiers photo restent publics par leur adresse (longue et impossible à deviner).

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- Réglages du diaporama (slides actives, horaires de pause, happiness event)
create table if not exists settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- Photos des events passés (le fichier est dans le bucket "photos")
create table if not exists photos (
  id uuid primary key default gen_random_uuid(),
  path text not null,
  caption text check (char_length(caption) <= 120),
  event text check (char_length(event) <= 80),
  created_at timestamptz not null default now()
);

-- Repas : propositions ponctuelles du jour (en plus de la liste des restos)
create table if not exists lunch_options (
  id uuid primary key default gen_random_uuid(),
  day date not null,
  name text not null check (char_length(name) between 1 and 60),
  created_at timestamptz not null default now(),
  unique (day, name)
);

-- Ancien système de vote : plus utilisé, gardé pour ne rien effacer
create table if not exists lunch_votes (
  day date not null,
  voter text not null,
  option_id uuid not null references lunch_options (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (day, voter)
);

-- Liste permanente des restos. days : jours d'ouverture (1 = lundi … 5 = vendredi) ;
-- unavailable : "Pas dispo" (vacances…)
create table if not exists restaurants (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 60),
  days jsonb not null default '[1,2,3,4,5]',
  unavailable boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index if not exists restaurants_name_unique on restaurants (lower(name));

-- Tirage du resto du jour (11:30) : le premier enregistré gagne, "Relancer" le remplace
create table if not exists lunch_draws (
  day date primary key,
  restaurant_id uuid references restaurants (id) on delete set null,
  name text not null,
  drawn_at timestamptz not null default now()
);

-- Comptes autorisés à utiliser le dashboard (adresse e-mail du compte Supabase Auth)
create table if not exists admins (
  email text primary key
);

-- Code du site : seulement son empreinte (sha256), jamais le code en clair
create table if not exists site_secret (
  id int primary key default 1 check (id = 1),
  code_hash text,
  updated_at timestamptz not null default now()
);
insert into site_secret (id) values (1) on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Fonctions de contrôle
-- ---------------------------------------------------------------------------

-- La personne connectée est-elle admin ?
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from admins where lower(email) = lower(coalesce(auth.jwt() ->> 'email', '')));
$$;

-- Le code envoyé par l'écran (en-tête x-site-code) est-il le bon ? Vrai s'il n'y a pas de code.
create or replace function public.site_code_ok() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((
    select code_hash is null
        or code_hash = encode(sha256(convert_to(coalesce(current_setting('request.headers', true)::json ->> 'x-site-code', ''), 'UTF8')), 'hex')
    from site_secret where id = 1
  ), true);
$$;

-- Pour l'écran de code : un code est-il demandé, et celui-ci est-il bon ?
create or replace function public.site_access(code text) returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'required', coalesce((select code_hash is not null from site_secret where id = 1), false),
    'ok', coalesce((
      select code_hash is null or code_hash = encode(sha256(convert_to(coalesce(code, ''), 'UTF8')), 'hex')
      from site_secret where id = 1
    ), true)
  );
$$;

grant execute on function public.is_admin() to anon, authenticated;
grant execute on function public.site_code_ok() to anon, authenticated;
grant execute on function public.site_access(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Droits (Row Level Security)
-- ---------------------------------------------------------------------------

alter table settings enable row level security;
alter table photos enable row level security;
alter table lunch_options enable row level security;
alter table lunch_votes enable row level security;
alter table restaurants enable row level security;
alter table lunch_draws enable row level security;
alter table admins enable row level security;
alter table site_secret enable row level security;

-- Anciennes règles "tout le monde peut tout faire" : supprimées
drop policy if exists "tout le monde" on settings;
drop policy if exists "tout le monde" on photos;
drop policy if exists "tout le monde" on lunch_options;
drop policy if exists "tout le monde" on lunch_votes;
drop policy if exists "tout le monde" on restaurants;
drop policy if exists "tout le monde" on lunch_draws;

-- Lecture par l'écran : avec le bon code du site
drop policy if exists "lecture avec le code" on settings;
drop policy if exists "lecture avec le code" on photos;
drop policy if exists "lecture avec le code" on lunch_options;
drop policy if exists "lecture avec le code" on restaurants;
drop policy if exists "lecture avec le code" on lunch_draws;
create policy "lecture avec le code" on settings for select to anon using (site_code_ok());
create policy "lecture avec le code" on photos for select to anon using (site_code_ok());
create policy "lecture avec le code" on lunch_options for select to anon using (site_code_ok());
create policy "lecture avec le code" on restaurants for select to anon using (site_code_ok());
create policy "lecture avec le code" on lunch_draws for select to anon using (site_code_ok());

-- Tirage de 11:30 et bouton "Relancer" de l'écran : écriture du tirage avec le code
drop policy if exists "tirage avec le code" on lunch_draws;
drop policy if exists "relance avec le code" on lunch_draws;
create policy "tirage avec le code" on lunch_draws for insert to anon with check (site_code_ok());
create policy "relance avec le code" on lunch_draws for update to anon using (site_code_ok()) with check (site_code_ok());

-- Admins connectés : tout
drop policy if exists "admins" on settings;
drop policy if exists "admins" on photos;
drop policy if exists "admins" on lunch_options;
drop policy if exists "admins" on lunch_votes;
drop policy if exists "admins" on restaurants;
drop policy if exists "admins" on lunch_draws;
drop policy if exists "admins" on site_secret;
drop policy if exists "admins : lecture" on admins;
create policy "admins" on settings for all to authenticated using (is_admin()) with check (is_admin());
create policy "admins" on photos for all to authenticated using (is_admin()) with check (is_admin());
create policy "admins" on lunch_options for all to authenticated using (is_admin()) with check (is_admin());
create policy "admins" on lunch_votes for all to authenticated using (is_admin()) with check (is_admin());
create policy "admins" on restaurants for all to authenticated using (is_admin()) with check (is_admin());
create policy "admins" on lunch_draws for all to authenticated using (is_admin()) with check (is_admin());
create policy "admins" on site_secret for all to authenticated using (is_admin()) with check (is_admin());
create policy "admins : lecture" on admins for select to authenticated using (is_admin());

-- ---------------------------------------------------------------------------
-- Stockage des photos : lecture publique, ajout et suppression par les admins
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', true, 10485760, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "photos : lecture" on storage.objects;
drop policy if exists "photos : ajout" on storage.objects;
drop policy if exists "photos : suppression" on storage.objects;
create policy "photos : lecture" on storage.objects for select to anon, authenticated using (bucket_id = 'photos');
create policy "photos : ajout" on storage.objects for insert to authenticated with check (bucket_id = 'photos' and is_admin());
create policy "photos : suppression" on storage.objects for delete to authenticated using (bucket_id = 'photos' and is_admin());

-- ---------------------------------------------------------------------------
-- Ton compte admin (à faire une fois) :
--   1. Supabase → Authentication → Users → Add user → Create new user
--      e-mail : <identifiant>@matdora.app (ex. tom@matdora.app), mot de passe au choix,
--      cocher "Auto Confirm User".
--   2. Décommenter et lancer la ligne ci-dessous avec le même e-mail :
-- insert into admins (email) values ('tom@matdora.app') on conflict do nothing;
-- ---------------------------------------------------------------------------
