#!/bin/bash
export PATH="/opt/homebrew/bin:$PATH"
cd /Users/kusoi/Projects/deepseek-bridge
npx electron . "$@"