# ==========================================
# 🖌️ Prettier 一括適用（mabubot-ops、Windows 用）
# ==========================================
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

npx prettier --write "src/**/*.ts" "tests/**/*.ts" "package.json" "tsconfig.json" "ecosystem.config.cjs" ".github/workflows/*.yml" ".github/dependabot.yml"
