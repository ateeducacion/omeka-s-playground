PORT ?= 8080
OMEKA_REF ?= https://github.com/ateeducacion/omeka-s.git
OMEKA_REF_BRANCH ?= feature/experimental-sqlite-support

.PHONY: up deps prepare bundle serve clean reset

deps:
	npm install

prepare: deps
	npm run sync-browser-deps
	npm run prepare-runtime

bundle: prepare
	OMEKA_REF=$(OMEKA_REF) OMEKA_REF_BRANCH=$(OMEKA_REF_BRANCH) npm run bundle

serve:
	python3 -m http.server $(PORT)

up: bundle serve

clean:
	rm -rf .cache
	rm -rf vendor
	rm -rf assets/omeka/*
	rm -rf assets/manifests/*
	touch assets/omeka/.gitkeep assets/manifests/.gitkeep

reset: clean
	rm -rf .cache
