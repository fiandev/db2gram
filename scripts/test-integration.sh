#!/usr/bin/env bash
# Starts throwaway PostgreSQL + MariaDB containers, runs the integration tests
# against them, and tears everything down. Requires Docker.
set -euo pipefail

PG_NAME="db2gram-it-pg-$$"
MY_NAME="db2gram-it-my-$$"

cleanup() {
  docker rm -f "$PG_NAME" "$MY_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

host_port() {
  docker port "$1" "$2" | head -n1 | awk -F: '{print $NF}'
}

echo "==> starting PostgreSQL"
docker run -d --rm --name "$PG_NAME" \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=db2gram_test \
  -p 127.0.0.1::5432 postgres:18 >/dev/null

echo "==> starting MariaDB"
docker run -d --rm --name "$MY_NAME" \
  -e MARIADB_ROOT_PASSWORD=root \
  -e MARIADB_DATABASE=db2gram_test -e MARIADB_USER=db2gram -e MARIADB_PASSWORD=db2gram \
  -p 127.0.0.1::3306 mariadb:11 >/dev/null

echo "==> waiting for PostgreSQL"
for _ in $(seq 1 60); do
  if docker exec "$PG_NAME" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done

echo "==> waiting for MariaDB"
for _ in $(seq 1 60); do
  if docker exec "$MY_NAME" mariadb-admin ping -uroot -proot >/dev/null 2>&1; then break; fi
  sleep 1
done

PG_PORT="$(host_port "$PG_NAME" 5432/tcp)"
MY_PORT="$(host_port "$MY_NAME" 3306/tcp)"

docker exec "$PG_NAME" createdb -U postgres db2gram_state

export DB2GRAM_TEST_POSTGRES_URL="postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/db2gram_test"
export DB2GRAM_TEST_MARIADB_URL="mariadb://db2gram:db2gram@127.0.0.1:${MY_PORT}/db2gram_test"
export DB2GRAM_TEST_ROOT_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/db2gram_state"

echo "==> running integration tests"
npx vitest run tests/integration "$@"
