#!/usr/bin/env bash
# Fails unless `pico test`'s log shows tests that passed, so a run that executed none can't be green.
# Usage: tests-ran.sh LOG   (colour codes are removed first; perl is on every runner)
if ! perl -pe 's/\e\[[0-9;]*m//g' "$1" | grep -Eq 'tests: [1-9][0-9]* passed'; then
  echo "::error::no passing tests in $1"
  exit 1
fi
