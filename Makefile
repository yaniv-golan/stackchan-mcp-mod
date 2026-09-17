# Thin wrappers around scripts/. Everything that needs the robot says so.
#
#   MODDABLE     path to a Moddable SDK 9.0.0 checkout      (build)
#   STACKCHAN    path to a stack-chan v1.1.0 checkout       (build)
#   STACKCHAN_PORT  serial device, e.g. /dev/cu.usbmodem2101 (install)
#   STACKCHAN_HOST  robot IP or ip:port                      (tools, health, demo)

.DEFAULT_GOAL := help
.PHONY: help check build install reset tools health selftest diagnose demo clean

help: ## Show this help
	@grep -hE '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) | awk -F':.*?## ' '{printf "  \033[1m%-10s\033[0m %s\n", $$1, $$2}'

check: ## Lint and format (no robot needed)
	@scripts/check.sh

build: ## Build mod.xsa (needs MODDABLE and STACKCHAN)
	@scripts/build.sh

install: build ## Build, write to the robot and reset it (needs STACKCHAN_PORT)
	@scripts/install.sh

reset: ## Pulse EN over USB, the first thing to try for a black screen (needs STACKCHAN_PORT)
	@scripts/reset.sh

tools: ## List the tools the robot currently serves (needs STACKCHAN_HOST)
	@scripts/mcp.sh '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
		| python3 -c 'import json,sys; [print(t["name"]) for t in json.load(sys.stdin)["result"]["tools"]]'

health: ## Check the robot is reachable (needs STACKCHAN_HOST, ip or ip:port)
	@host="$${STACKCHAN_HOST}"; case "$$host" in *:*) ;; *) host="$$host:8080" ;; esac; \
		curl -sS -m 5 "http://$$host/health" && echo

selftest: ## Run the read-only tool checks (needs STACKCHAN_HOST; --all for the rest)
	@scripts/selftest.py

diagnose: ## Write a read-only diagnostics bundle to build/ (needs STACKCHAN_HOST)
	@scripts/diagnose.py

demo: ## Make the robot greet you, to confirm everything works end to end
	@scripts/mcp.sh '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"set_emotion","arguments":{"emotion":"HAPPY"}}}' >/dev/null
	@scripts/mcp.sh '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"show_message","arguments":{"text":"Hello","seconds":5}}}' >/dev/null
	@scripts/mcp.sh '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"say_message","arguments":{"message":"Hello."}}}' >/dev/null
	@echo "greeted; check the robot"

clean: ## Remove build output
	@rm -rf build
