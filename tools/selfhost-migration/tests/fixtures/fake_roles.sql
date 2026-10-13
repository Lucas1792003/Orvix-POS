--
-- PostgreSQL database cluster dump (SYNTHETIC test fixture)
--

SET default_transaction_read_only = off;

SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;

--
-- Roles
--

-- CREATE ROLE "anon";
-- CREATE ROLE "authenticated";
CREATE ROLE "cli_login_postgres";
ALTER ROLE "cli_login_postgres" WITH NOSUPERUSER INHERIT NOCREATEROLE NOCREATEDB LOGIN NOREPLICATION NOBYPASSRLS;
CREATE ROLE "supabase_etl_admin";
ALTER ROLE "supabase_etl_admin" WITH NOSUPERUSER INHERIT NOCREATEROLE NOCREATEDB NOLOGIN NOREPLICATION NOBYPASSRLS;

--
-- Role memberships
--

GRANT "postgres" TO "cli_login_postgres" WITH INHERIT TRUE GRANTED BY "supabase_admin";
GRANT "pg_read_all_data" TO "supabase_etl_admin" WITH INHERIT TRUE GRANTED BY "supabase_admin";

--
-- PostgreSQL database cluster dump complete
--
