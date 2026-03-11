PORT ?= 8080
OMEKA_REF ?= https://github.com/ateeducacion/omeka-s.git
OMEKA_REF_BRANCH ?= feature/experimental-sqlite-support

# Basic usage:
#   make help      Show the available targets and common overrides
#   make up        Install deps, prepare runtime assets, build Omeka, and start the dev server
#   make serve     Start only the local dev server
#   make bundle    Rebuild the readonly Omeka bundle
#
# Common overrides:
#   make serve PORT=9090
#   make bundle OMEKA_REF=https://github.com/<org>/omeka-s.git OMEKA_REF_BRANCH=<branch>

.PHONY: help up deps prepare bundle serve clean reset

help:
	@printf '%s\n' \
		'Omeka S Playground Make targets:' \
		'' \
		'  make deps      Install npm dependencies' \
		'  make prepare   Sync browser deps and prepare runtime assets' \
		'  make bundle    Build the readonly Omeka bundle' \
		'  make serve     Start the local dev server' \
		'  make up        Run bundle + serve' \
		'  make clean     Remove generated caches and bundle artifacts' \
		'  make reset     Alias of clean plus cache reset' \
		'' \
		'Common overrides:' \
		'  PORT=9090 make serve' \
		'  OMEKA_REF=<repo> OMEKA_REF_BRANCH=<branch> make bundle'

deps:
	npm install

prepare: deps
	npm run sync-browser-deps
	npm run prepare-runtime

bundle: prepare
	OMEKA_REF=$(OMEKA_REF) OMEKA_REF_BRANCH=$(OMEKA_REF_BRANCH) npm run bundle

serve:
	PORT=$(PORT) node ./scripts/dev-server.mjs

up: bundle serve

clean:
	rm -rf .cache
	rm -rf vendor
	rm -rf assets/omeka/*
	rm -rf assets/manifests/*
	touch assets/omeka/.gitkeep assets/manifests/.gitkeep

reset: clean
	rm -rf .cache
