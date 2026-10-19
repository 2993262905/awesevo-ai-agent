@echo off
rem AwesEvo 一键快照：双击即把当前所有改动存成一个版本
cd /d %~dp0

echo.
echo ============================================
echo   AwesEvo - Save Snapshot
echo ============================================
echo.

git add -A
git commit -m "snapshot"

if errorlevel 1 (
  echo.
  echo [Nothing to commit] working tree is clean
) else (
  echo.
  echo [Saved] snapshot created
)

echo.
echo Recent history:
git log --oneline -5

echo.
pause
