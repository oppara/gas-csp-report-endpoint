SHELL := /bin/bash

.PHONY: test
test: ## テストを実行する
	node --test test/logic.test.js

.PHONY: deploy
deploy: ## clasp pushしてデプロイする(既存デプロイがあればバージョン更新、無ければ新規デプロイ)
	clasp push
	@DEPLOYMENT_ID=$$(clasp deployments | grep -v '@HEAD' | tail -1 | awk '{print $$2}'); \
	if [ -n "$$DEPLOYMENT_ID" ]; then \
		echo "Updating existing deployment: $$DEPLOYMENT_ID"; \
		clasp deploy --deploymentId "$$DEPLOYMENT_ID"; \
	else \
		echo "No existing deployment found. Creating a new one."; \
		clasp deploy; \
	fi

.PHONY: help
help: ## Display this help screen
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'
