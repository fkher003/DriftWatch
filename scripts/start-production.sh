#!/bin/sh
set -eu
node scripts/migration.mjs apply
exec node apps/server/dist/main.js
