-- MatDora : tables et droits pour le diaporama.
-- À coller une seule fois dans Supabase → SQL Editor → Run.
-- Choix fait : tout le monde peut contribuer (pas de connexion). Toute personne
-- qui a l'adresse du site peut donc modifier les slides, ajouter ou supprimer des photos.

create extension if not exists pgcrypto;

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

-- Repas : propositions du jour et votes (un vote par personne et par jour)
create table if not exists lunch_options (
  id uuid primary key default gen_random_uuid(),
  day date not null,
  name text not null check (char_length(name) between 1 and 60),
  created_at timestamptz not null default now(),
  unique (day, name)
);

create table if not exists lunch_votes (
  day date not null,
  voter text not null,
  option_id uuid not null references lunch_options (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (day, voter)
);

-- Droits : lecture et écriture pour tous (rôle "anon")
alter table settings enable row level security;
alter table photos enable row level security;
alter table lunch_options enable row level security;
alter table lunch_votes enable row level security;

drop policy if exists "tout le monde" on settings;
drop policy if exists "tout le monde" on photos;
drop policy if exists "tout le monde" on lunch_options;
drop policy if exists "tout le monde" on lunch_votes;
create policy "tout le monde" on settings for all to anon using (true) with check (true);
create policy "tout le monde" on photos for all to anon using (true) with check (true);
create policy "tout le monde" on lunch_options for all to anon using (true) with check (true);
create policy "tout le monde" on lunch_votes for all to anon using (true) with check (true);

-- Stockage des photos : bucket public, images de 10 Mo max
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', true, 10485760, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "photos : lecture" on storage.objects;
drop policy if exists "photos : ajout" on storage.objects;
drop policy if exists "photos : suppression" on storage.objects;
create policy "photos : lecture" on storage.objects for select to anon using (bucket_id = 'photos');
create policy "photos : ajout" on storage.objects for insert to anon with check (bucket_id = 'photos');
create policy "photos : suppression" on storage.objects for delete to anon using (bucket_id = 'photos');

-- ---------------------------------------------------------------------------
-- Repas : liste permanente des restos et tirage au sort quotidien (11:30)
-- Ajouté après coup : relancer tout ce fichier est sans risque (rien n'est effacé).
-- ---------------------------------------------------------------------------

-- days : jours d'ouverture (1 = lundi … 5 = vendredi) ; unavailable : "Pas dispo" (vacances…)
create table if not exists restaurants (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 60),
  days jsonb not null default '[1,2,3,4,5]',
  unavailable boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index if not exists restaurants_name_unique on restaurants (lower(name));

-- Un tirage par jour : le premier enregistré gagne, "Relancer" le remplace
create table if not exists lunch_draws (
  day date primary key,
  restaurant_id uuid references restaurants (id) on delete set null,
  name text not null,
  drawn_at timestamptz not null default now()
);

alter table restaurants enable row level security;
alter table lunch_draws enable row level security;
drop policy if exists "tout le monde" on restaurants;
drop policy if exists "tout le monde" on lunch_draws;
create policy "tout le monde" on restaurants for all to anon using (true) with check (true);
create policy "tout le monde" on lunch_draws for all to anon using (true) with check (true);
