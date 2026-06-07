#!/usr/bin/env bash
set -euo pipefail

make prepare
make bundle-all
python -m pip install -r requirements-docs.txt

rm -rf _site site
mkdir -p _site/docs _site/dist
rsync -a ./ ./_site/ \
  --exclude ".git/" \
  --exclude ".github/" \
  --exclude ".venv/" \
  --exclude ".cache/" \
  --exclude "_site/" \
  --exclude "docs/" \
  --exclude "node_modules/" \
  --exclude "site/"
mkdocs build --strict --site-dir _site/docs
touch _site/.nojekyll
