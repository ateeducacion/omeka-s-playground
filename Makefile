PORT ?= 8080
OMEKA_VERSION ?=
OMEKA_REF ?=
OMEKA_REF_BRANCH ?=

# Basic usage:
#   make help             Show the available targets and common overrides
#   make up               Install deps, prepare runtime assets, build all
#                         Omeka versions, and start the dev server
#   make serve            Start only the local dev server
#   make bundle           Rebuild the readonly Omeka bundle for the default
#                         version (override with OMEKA_VERSION=...)
#   make bundle-all       Rebuild bundles for every supported Omeka version
#
# Common overrides:
#   make serve PORT=9090
#   make bundle OMEKA_VERSION=4.1.1
#   make bundle OMEKA_VERSION=4.2.0 OMEKA_REF=https://github.com/<org>/omeka-s.git OMEKA_REF_BRANCH=<branch>

.PHONY: help up deps prepare bundle bundle-all bundle-4.1.1 bundle-4.2.0 serve clean reset test lint format

help:
	@printf '%s\n' \
		'Omeka S Playground Make targets:' \
		'' \
		'  make deps          Install npm dependencies' \
		'  make prepare       Sync browser deps and prepare runtime assets' \
		'  make bundle        Build the readonly Omeka bundle for the default version' \
		'  make bundle-all    Build bundles for every supported Omeka version' \
		'  make bundle-4.1.1  Build only the Omeka 4.1.1 bundle' \
		'  make bundle-4.2.0  Build only the Omeka 4.2.0 bundle' \
		'  make serve         Start the local dev server' \
		'  make up            Run bundle-all + serve' \
		'  make test          Run tests' \
		'  make lint          Check code with Biome' \
		'  make format        Auto-fix code with Biome' \
		'  make clean         Remove generated caches and bundle artifacts' \
		'  make reset         Alias of clean plus cache reset' \
		'' \
		'Common overrides:' \
		'  PORT=9090 make serve' \
		'  OMEKA_VERSION=4.1.1 make bundle' \
		'  OMEKA_REF=<repo> OMEKA_REF_BRANCH=<branch> make bundle OMEKA_VERSION=4.2.0'

deps:
	npm install

prepare: deps
	npm run sync-browser-deps
	npm run prepare-runtime
	npm run build-worker

bundle: prepare
	OMEKA_VERSION=$(OMEKA_VERSION) OMEKA_REF=$(OMEKA_REF) OMEKA_REF_BRANCH=$(OMEKA_REF_BRANCH) npm run bundle

bundle-all: prepare bundle-4.1.1 bundle-4.2.0

# Per-version targets so recursive make can parallelise independent builds
# (they share only the worker bundle and the vendor cache).
bundle-4.1.1:
	OMEKA_VERSION=4.1.1 npm run bundle

bundle-4.2.0:
	OMEKA_VERSION=4.2.0 OMEKA_REF=$(OMEKA_REF) OMEKA_REF_BRANCH=$(OMEKA_REF_BRANCH) npm run bundle

serve:
	PORT=$(PORT) node ./scripts/dev-server.mjs

up: bundle-all serve

clean:
	rm -rf .cache
	rm -rf vendor
	rm -rf dist
	rm -rf assets/omeka/*
	rm -rf assets/manifests/*
	touch assets/omeka/.gitkeep assets/manifests/.gitkeep

test:
	node --test tests/*.test.mjs

lint:
	npx @biomejs/biome check

format:
	npx @biomejs/biome check --fix

reset: clean
	rm -rf .cache
